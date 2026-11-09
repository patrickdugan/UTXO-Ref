//! KeyAgentNet payment gate.
//!
//! Custodian A releases a signature only when the request carries a final proof of the
//! nova-bitvm3 M16 guest (a Nova proof of the Bitcoin header chain from genesis, plus an SPV
//! payment under its tip) whose statement pays a script the coordinator registered, with
//! enough confirmations under a chain with enough work.
//!
//! Three layers, each refusing with a reason code:
//! - [`proof`]: the BLAKE3 wrap proof verifies under the pinned wrap key, for the pinned guest
//!   program and recursion key map, and commits to exactly the statement bytes supplied;
//! - [`statement`]: the 1,292 statement bytes parse under M16's fixed layout;
//! - [`policy`]: network, fold width, genesis, Nova key, chainwork floor, confirmations,
//!   registered script and minimum value.
//!
//! Replay of one payment across requests is the signer journal's job (`kan_policy.py`), keyed
//! by the accepted outpoint.

#[cfg(feature = "verify")]
pub mod proof;
pub mod policy;
pub mod statement;

use serde::Serialize;

/// A refusal: a stable reason code plus detail for the journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub reason: &'static str,
    pub detail: String,
}

impl Refusal {
    pub fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Refusal { reason, detail: detail.into() }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() {
            f.write_str(self.reason)
        } else {
            write!(f, "{}: {}", self.reason, self.detail)
        }
    }
}

impl std::error::Error for Refusal {}

pub fn sha256(b: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).into()
}

/// Parse a 32-byte lowercase hex pin. Uppercase is refused so string comparison of pins matches
/// byte comparison.
pub(crate) fn hex32(s: &str, what: &str) -> Result<[u8; 32], Refusal> {
    if s.bytes().any(|c| c.is_ascii_uppercase()) {
        return Err(Refusal::new("policy_invalid", format!("{what} is not lowercase hex")));
    }
    let v = hex::decode(s).map_err(|_| Refusal::new("policy_invalid", format!("{what} is not hex")))?;
    v.try_into().map_err(|_| Refusal::new("policy_invalid", format!("{what} is not 32 bytes")))
}
