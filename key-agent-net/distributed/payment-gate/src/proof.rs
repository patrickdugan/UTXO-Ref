//! The final proof: SP1 6.9.0's wrap layer re-proved under BLAKE3 with transcript v2
//! (nova-bitvm3 `m13`), checked with `m13-verify` as a library.
//!
//! The wrap proof commits SHA-256 of the guest's public values, not the values themselves, so
//! the caller supplies the statement bytes and the check binds them by digest. Order follows
//! `m13_verify::verify_final`: wrap key, STARK, exit code, completeness, guest program,
//! recursion key map, committed statement. Each failure has its own reason code.

use crate::policy::Pins;
use crate::{sha256, Refusal};
use bincode::Options;
use m13_verify::{final_statement, Blake3KoalaBearV2, Blake3WrapProofV2, FinalLayer, FinalStatement};

/// The wrap proof is 1,099,173 bytes; anything far larger is not one.
pub const MAX_PROOF_BYTES: usize = 2 << 20;

fn decode(proof: &[u8]) -> Result<Blake3WrapProofV2, Refusal> {
    if proof.len() > MAX_PROOF_BYTES {
        return Err(Refusal::new("proof_too_large", format!("{} bytes", proof.len())));
    }
    // m13-verify writes proofs with bincode 1's default (fixed-width integers). The limit bounds
    // every length prefix by the input size.
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PROOF_BYTES as u64)
        .deserialize(proof)
        .map_err(|e| Refusal::new("proof_malformed", e.to_string()))
}

/// Verify a final proof against the pins and a required committed-values digest (hex).
pub fn verify_digest(proof: &[u8], committed_sha256: &str, pins: &Pins) -> Result<FinalStatement, Refusal> {
    let wrap = decode(proof)?;
    let got = final_statement(&wrap).map_err(|e| Refusal::new("proof_malformed", e.to_string()))?;
    if got.wrap_vk_sha256 != pins.wrap_vk_sha256 {
        return Err(Refusal::new("proof_wrap_key", got.wrap_vk_sha256));
    }
    Blake3KoalaBearV2::verify_stark(&wrap).map_err(|e| Refusal::new("proof_rejected", e.to_string()))?;
    if got.exit_code != 0 {
        return Err(Refusal::new("proof_exit_code", got.exit_code.to_string()));
    }
    if got.is_complete != 1 {
        return Err(Refusal::new("proof_incomplete", ""));
    }
    if got.program_vk_digest != pins.program_vk_digest {
        return Err(Refusal::new("proof_wrong_program", got.program_vk_digest));
    }
    if got.recursion_vk_root != pins.recursion_vk_root {
        return Err(Refusal::new("proof_recursion_root", got.recursion_vk_root));
    }
    if got.committed_values_sha256 != committed_sha256 {
        return Err(Refusal::new(
            "statement_digest_mismatch",
            format!("proof commits {}, statement is {committed_sha256}", got.committed_values_sha256),
        ));
    }
    Ok(got)
}

/// Verify a final proof and bind it to `statement`.
pub fn verify(proof: &[u8], statement: &[u8], pins: &Pins) -> Result<FinalStatement, Refusal> {
    verify_digest(proof, &hex::encode(sha256(statement)), pins)
}
