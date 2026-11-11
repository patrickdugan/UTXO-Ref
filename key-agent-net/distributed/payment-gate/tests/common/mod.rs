#![allow(dead_code)]
use kan_payment_gate::policy::{GatePolicy, Network, Pins, RegisteredScript};
use serde_json::Value;

pub const DIR: &str = env!("CARGO_MANIFEST_DIR");

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{DIR}/fixtures/{name}")).unwrap()
}

pub fn pins() -> Value {
    serde_json::from_slice(&std::fs::read(format!("{DIR}/pins.json")).unwrap()).unwrap()
}

/// The block-170 statement's output script: 67-byte P2PK, 10 BTC (m16 README).
pub const BLOCK170_SCRIPT_SHA256: &str = "799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677";
/// Chainwork at block 800, the block-170 statement's tip.
pub const BLOCK800_CHAINWORK: &str = "32103210321";

pub fn gate_pins(network: &str, program: &str) -> Pins {
    let p = pins();
    let s = |v: &Value| v.as_str().unwrap().to_string();
    Pins {
        wrap_vk_sha256: s(&p["final_proof"]["wrap_vk_sha256"]),
        recursion_vk_root: s(&p["final_proof"]["recursion_vk_root"]),
        program_vk_digest: s(&p["programs"][program]["program_vk_digest"]),
        nova_vk_sha256: s(&p["networks"][network]["nova_vk_sha256"]),
        genesis_z0_sha256: s(&p["networks"][network]["genesis_z0_sha256"]),
    }
}

/// `fixtures/m16-payment.json`: the M16 mainnet final proof's files and the policy values that
/// accept its payment.
pub fn m16_payment() -> Value {
    serde_json::from_slice(&fixture("m16-payment.json")).unwrap()
}

/// The policy that accepts the M16 mainnet payment, built from `m16-payment.json`.
pub fn m16_policy() -> GatePolicy {
    let m = m16_payment();
    GatePolicy {
        network: Network::Mainnet,
        min_confirmations: m["confirmations"].as_u64().unwrap() as u32,
        min_tip_chainwork: m["min_tip_chainwork"].as_str().unwrap().into(),
        scripts: vec![RegisteredScript {
            id: "m16-payment".into(),
            script_sha256: m["script_sha256"].as_str().unwrap().into(),
            min_value_sats: m["min_value_sats"].as_u64().unwrap(),
        }],
        pins: gate_pins("mainnet", "m16_chain_and_payment"),
    }
}

/// The policy that accepts the block-170 payment.
pub fn block170_policy() -> GatePolicy {
    GatePolicy {
        network: Network::Mainnet,
        min_confirmations: 6,
        min_tip_chainwork: BLOCK800_CHAINWORK.into(),
        scripts: vec![RegisteredScript {
            id: "block-170-p2pk".into(),
            script_sha256: BLOCK170_SCRIPT_SHA256.into(),
            min_value_sats: 100_000_000,
        }],
        pins: gate_pins("mainnet", "m16_chain_and_payment"),
    }
}
