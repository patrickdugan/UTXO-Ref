//! The M16 guest's committed statement (garbled-snark-verifier `nova-bitvm3/m16`).
//!
//! Guest A's 1,164-byte chain record, then the 128-byte PAY1 payment record:
//!
//! ```text
//! magic "NHC1"|"NHT4" | u32 k | u32 steps | z0 (17 x 32) | zn (17 x 32) | sha256(compressed Nova key)
//! | proofs digest | "PAY1" | u32 segments | u32 height_B | hash_B | u32 confirmations | txid | u32 vout
//! | u64 value | u32 script length | sha256(script)
//! ```
//!
//! Integers are little-endian. Hashes and the txid are in internal byte order; this module
//! returns them in display order. A chain state is 17 Pallas scalars (canonical 32-byte LE):
//! element 0 is the height, elements 1 and 2 hold the low 16 bytes each of the block hash's two
//! halves, element 3 is the cumulative chainwork. The layout is fixed, so parsing is bounded by
//! the length check.

use crate::Refusal;

pub const STATE_BYTES: usize = 17 * 32;
/// Guest A's chain record alone.
pub const CHAIN_BYTES: usize = 12 + 2 * STATE_BYTES + 64;
pub const PAYMENT_BYTES: usize = 128;
pub const STATEMENT_BYTES: usize = CHAIN_BYTES + PAYMENT_BYTES;

/// Height, block hash and chainwork from a 17-element chain state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainPoint {
    pub height: u32,
    /// Display order.
    pub hash: [u8; 32],
    /// Big-endian, so byte-wise comparison is numeric comparison.
    pub chainwork: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payment {
    pub segments: u32,
    pub block_height: u32,
    /// Display order.
    pub block_hash: [u8; 32],
    pub confirmations: u32,
    /// Display order.
    pub txid: [u8; 32],
    pub vout: u32,
    pub value_sats: u64,
    pub script_len: u32,
    pub script_sha256: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub magic: [u8; 4],
    pub k: u32,
    pub steps: u32,
    /// The canonical start state, as committed; its SHA-256 is what a genesis pin names.
    pub z0: Vec<u8>,
    pub start: ChainPoint,
    pub tip: ChainPoint,
    pub nova_vk_sha256: [u8; 32],
    pub proofs_sha256: [u8; 32],
    pub payment: Payment,
}

fn u32le(b: &[u8]) -> u32 {
    u32::from_le_bytes(b[..4].try_into().unwrap())
}

fn arr32(b: &[u8]) -> [u8; 32] {
    b[..32].try_into().unwrap()
}

fn display(b: &[u8]) -> [u8; 32] {
    let mut v = arr32(b);
    v.reverse();
    v
}

fn point(state: &[u8], which: &str) -> Result<ChainPoint, Refusal> {
    let elem = |i: usize| &state[32 * i..32 * i + 32];
    // The height and both hash halves are small integers inside 32-byte scalars; anything in
    // their high bytes is not a state the guest commits.
    let height_high = &elem(0)[4..];
    let half_high = [&elem(1)[16..], &elem(2)[16..]];
    if height_high.iter().chain(half_high[0]).chain(half_high[1]).any(|&b| b != 0) {
        return Err(Refusal::new("statement_state_encoding", which.to_string()));
    }
    let mut internal = [0u8; 32];
    internal[..16].copy_from_slice(&elem(1)[..16]);
    internal[16..].copy_from_slice(&elem(2)[..16]);
    internal.reverse();
    Ok(ChainPoint { height: u32le(elem(0)), hash: internal, chainwork: display(elem(3)) })
}

/// Parse M16's committed statement. Guest A's chain-only record (no payment) is refused as
/// `no_payment_record`.
pub fn parse(bytes: &[u8]) -> Result<Statement, Refusal> {
    if bytes.len() == CHAIN_BYTES {
        return Err(Refusal::new("no_payment_record", "1,164-byte chain statement"));
    }
    if bytes.len() != STATEMENT_BYTES {
        return Err(Refusal::new("statement_length", format!("{} bytes, expected {STATEMENT_BYTES}", bytes.len())));
    }
    let z0 = &bytes[12..12 + STATE_BYTES];
    let zn = &bytes[12 + STATE_BYTES..12 + 2 * STATE_BYTES];
    let tail = &bytes[12 + 2 * STATE_BYTES..CHAIN_BYTES];
    let pay = &bytes[CHAIN_BYTES..];
    if &pay[..4] != b"PAY1" {
        return Err(Refusal::new("payment_record_magic", hex::encode(&pay[..4])));
    }
    let payment = Payment {
        segments: u32le(&pay[4..]),
        block_height: u32le(&pay[8..]),
        block_hash: display(&pay[12..]),
        confirmations: u32le(&pay[44..]),
        txid: display(&pay[48..]),
        vout: u32le(&pay[80..]),
        value_sats: u64::from_le_bytes(pay[84..92].try_into().unwrap()),
        script_len: u32le(&pay[92..]),
        script_sha256: arr32(&pay[96..]),
    };
    let st = Statement {
        magic: bytes[..4].try_into().unwrap(),
        k: u32le(&bytes[4..]),
        steps: u32le(&bytes[8..]),
        z0: z0.to_vec(),
        start: point(z0, "z0")?,
        tip: point(zn, "zn")?,
        nova_vk_sha256: arr32(tail),
        proofs_sha256: arr32(&tail[32..]),
        payment,
    };
    // The guest derives the payment block's height from the tip and the header count, so these
    // always agree in a statement it committed.
    let p = &st.payment;
    if p.confirmations == 0 || p.segments == 0 || p.block_height.checked_add(p.confirmations - 1) != Some(st.tip.height) {
        return Err(Refusal::new(
            "statement_inconsistent",
            format!("block {} with {} confirmations under tip {}", p.block_height, p.confirmations, st.tip.height),
        ));
    }
    Ok(st)
}

impl Statement {
    pub fn outpoint(&self) -> String {
        format!("{}:{}", hex::encode(self.payment.txid), self.payment.vout)
    }
}
