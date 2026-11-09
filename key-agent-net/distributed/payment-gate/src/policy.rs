//! The gate's policy: which chain, which proof pins, which scripts the coordinator registered.
//!
//! A statement proves a valid proof-of-work chain from genesis, not that it is the heaviest
//! one: anyone can extend a low-difficulty fork. `min_tip_chainwork` is the defence. Set it
//! from a chain observation the custodian trusts (Bitcoin Core's `chainwork` at a recent
//! block); a statement whose tip has less work is refused, and so are the confirmations under it.

use crate::statement::Statement;
use crate::{hex32, sha256, Refusal};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet4,
}

impl Network {
    pub fn magic(self) -> &'static [u8; 4] {
        match self {
            Network::Mainnet => b"NHC1",
            Network::Testnet4 => b"NHT4",
        }
    }
    /// Genesis block hash, display order. Checked against the start state in addition to the
    /// policy's z0 pin, so a mistyped pin cannot admit another start.
    pub fn genesis_hash(self) -> &'static str {
        match self {
            Network::Mainnet => "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
            Network::Testnet4 => "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
        }
    }
}

/// Pins of the final proof and of the chain statement it carries.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pins {
    /// SHA-256 of the bincode BLAKE3 wrap verifying key (m13 `pins.json`).
    pub wrap_vk_sha256: String,
    /// Root of SP1 6.9.0's recursion key map (m13 `pins.json`).
    pub recursion_vk_root: String,
    /// The M16 guest's SP1 program key digest.
    pub program_vk_digest: String,
    /// SHA-256 of the compressed k = 1 Nova verifier key for the network.
    pub nova_vk_sha256: String,
    /// SHA-256 of the canonical genesis chain state z0 for the network.
    pub genesis_z0_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredScript {
    pub id: String,
    /// SHA-256 of the output's scriptPubKey bytes.
    pub script_sha256: String,
    pub min_value_sats: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GatePolicy {
    pub network: Network,
    pub min_confirmations: u32,
    /// Big-endian hex, as Bitcoin Core prints `chainwork`.
    pub min_tip_chainwork: String,
    pub scripts: Vec<RegisteredScript>,
    pub pins: Pins,
}

/// What an accepted statement attests, for the journal and the signer's replay check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Accepted {
    pub outpoint: String,
    pub txid: String,
    pub vout: u32,
    pub value_sats: u64,
    pub script_id: String,
    pub script_sha256: String,
    pub block_height: u32,
    pub block_hash: String,
    pub confirmations: u32,
    pub tip_height: u32,
    pub tip_hash: String,
    pub tip_chainwork: String,
}

fn chainwork_be(s: &str) -> Result<[u8; 32], Refusal> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.is_empty() || s.len() > 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Refusal::new("policy_invalid", "min_tip_chainwork"));
    }
    let padded = format!("{s:0>64}");
    hex32(&padded.to_ascii_lowercase(), "min_tip_chainwork")
}

impl GatePolicy {
    pub fn from_json(text: &str) -> Result<Self, Refusal> {
        let p: GatePolicy = serde_json::from_str(text).map_err(|e| Refusal::new("policy_invalid", e.to_string()))?;
        p.validate()?;
        Ok(p)
    }

    fn validate(&self) -> Result<(), Refusal> {
        for (v, what) in [
            (&self.pins.wrap_vk_sha256, "wrap_vk_sha256"),
            (&self.pins.recursion_vk_root, "recursion_vk_root"),
            (&self.pins.program_vk_digest, "program_vk_digest"),
            (&self.pins.nova_vk_sha256, "nova_vk_sha256"),
            (&self.pins.genesis_z0_sha256, "genesis_z0_sha256"),
        ] {
            hex32(v, what)?;
        }
        chainwork_be(&self.min_tip_chainwork)?;
        if self.min_confirmations == 0 {
            return Err(Refusal::new("policy_invalid", "min_confirmations must be at least 1"));
        }
        if self.scripts.is_empty() {
            return Err(Refusal::new("policy_invalid", "no registered scripts"));
        }
        for s in &self.scripts {
            hex32(&s.script_sha256, "script_sha256")?;
        }
        Ok(())
    }

    /// Check a parsed statement. The caller has already bound it to a verified final proof.
    pub fn check(&self, st: &Statement) -> Result<Accepted, Refusal> {
        self.validate()?;
        if &st.magic != self.network.magic() {
            return Err(Refusal::new("wrong_network", String::from_utf8_lossy(&st.magic).into_owned()));
        }
        if st.k != 1 {
            return Err(Refusal::new("wrong_fold_width", st.k.to_string()));
        }
        if sha256(&st.z0) != hex32(&self.pins.genesis_z0_sha256, "genesis_z0_sha256")?
            || st.start.height != 0
            || hex::encode(st.start.hash) != self.network.genesis_hash()
        {
            return Err(Refusal::new(
                "wrong_genesis",
                format!("start height {} hash {}", st.start.height, hex::encode(st.start.hash)),
            ));
        }
        if st.nova_vk_sha256 != hex32(&self.pins.nova_vk_sha256, "nova_vk_sha256")? {
            return Err(Refusal::new("wrong_nova_key", hex::encode(st.nova_vk_sha256)));
        }
        if st.tip.chainwork < chainwork_be(&self.min_tip_chainwork)? {
            return Err(Refusal::new(
                "chainwork_below_floor",
                format!("tip {} chainwork {}", st.tip.height, hex::encode(st.tip.chainwork)),
            ));
        }
        let p = &st.payment;
        if p.confirmations < self.min_confirmations {
            return Err(Refusal::new(
                "too_few_confirmations",
                format!("{} < {}", p.confirmations, self.min_confirmations),
            ));
        }
        let script = hex::encode(p.script_sha256);
        let registered = self
            .scripts
            .iter()
            .find(|s| s.script_sha256 == script)
            .ok_or_else(|| Refusal::new("script_not_registered", script.clone()))?;
        if p.value_sats < registered.min_value_sats {
            return Err(Refusal::new(
                "value_below_policy",
                format!("{} < {} for {}", p.value_sats, registered.min_value_sats, registered.id),
            ));
        }
        Ok(Accepted {
            outpoint: st.outpoint(),
            txid: hex::encode(p.txid),
            vout: p.vout,
            value_sats: p.value_sats,
            script_id: registered.id.clone(),
            script_sha256: script,
            block_height: p.block_height,
            block_hash: hex::encode(p.block_hash),
            confirmations: p.confirmations,
            tip_height: st.tip.height,
            tip_hash: hex::encode(st.tip.hash),
            tip_chainwork: hex::encode(st.tip.chainwork),
        })
    }
}
