//! The final proof: SP1 6.9.0's wrap layer re-proved under BLAKE3 with transcript v2
//! (nova-bitvm3 `m13`), checked with `m13-verify` as a library.
//!
//! The wrap proof commits SHA-256 of the guest's public values, not the values themselves, so
//! the caller supplies the statement bytes and the check binds them by digest. Order follows
//! `m13_verify::verify_final`: wrap key, STARK, public-values digest, exit code, completeness,
//! guest program, recursion key map, committed statement. Each failure has its own reason code.
//!
//! The public-values digest is what makes the later comparisons mean anything. SP1's wrap
//! machine constrains only the `digest` slots of the proof's public values; the guest program
//! key, the committed-values digest and the exit code are bound to the proof through that digest
//! alone. Without recomputing it, a prover who runs the wrap step can write the M16 program key
//! and any statement digest into a proof of something else, and the STARK still verifies.

use crate::policy::Pins;
use crate::{sha256, Refusal};
use bincode::Options;
use m13_verify::{
    check_public_values_digest, final_statement, Blake3KoalaBearV2, Blake3WrapProofV2, FinalLayer, FinalStatement,
};

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
    check_statement(&wrap, got, committed_sha256, pins)
}

/// What follows the STARK: the public values hash to the digest the STARK constrains, and the
/// statement they carry is the pinned program's, complete, with exit code 0, under the pinned
/// recursion key map, committing `committed_sha256`. Private: it is only sound after the wrap key
/// and STARK checks of [`verify_digest`].
fn check_statement(
    wrap: &Blake3WrapProofV2,
    got: FinalStatement,
    committed_sha256: &str,
    pins: &Pins,
) -> Result<FinalStatement, Refusal> {
    check_public_values_digest(wrap).map_err(|e| Refusal::new("proof_public_values_digest", e.to_string()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = env!("CARGO_MANIFEST_DIR");

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{DIR}/fixtures/{name}")).unwrap()
    }

    fn m16_pins() -> Pins {
        let p: serde_json::Value = serde_json::from_slice(&std::fs::read(format!("{DIR}/pins.json")).unwrap()).unwrap();
        let s = |v: &serde_json::Value| v.as_str().unwrap().to_string();
        Pins {
            wrap_vk_sha256: s(&p["final_proof"]["wrap_vk_sha256"]),
            recursion_vk_root: s(&p["final_proof"]["recursion_vk_root"]),
            program_vk_digest: s(&p["programs"]["m16_chain_and_payment"]["program_vk_digest"]),
            nova_vk_sha256: s(&p["networks"]["mainnet"]["nova_vk_sha256"]),
            genesis_z0_sha256: s(&p["networks"]["mainnet"]["genesis_z0_sha256"]),
        }
    }

    /// The statement layer on the public values a forger would present: guest A's proof showing
    /// the M16 program key and the M16 statement digest. A forger gets a STARK over such values
    /// by writing them in before proving the wrap, which this crate cannot do in a test, so the
    /// test calls the layer that follows the STARK.
    ///
    /// `digest` (8 elements) and `proof_nonce` (4) are the last fields of SP1's
    /// `RecursionPublicValues`. The forged vector is M16's with those 12 elements taken from
    /// guest A's proof: every statement field reads as M16's, and the digest is the one the
    /// STARK would have constrained for another proof.
    #[test]
    fn m16_statement_over_another_proofs_digest_is_refused() {
        let pins = m16_pins();
        let statement_sha = hex::encode(sha256(&fixture("m16-statement.bin")));
        let m16 = decode(&fixture("m16-wrap-blake3-v2.bin")).unwrap();
        let a = decode(&fixture("guest-a-wrap-blake3-v2.bin")).unwrap();

        // The real M16 proof passes the layer.
        let got = final_statement(&m16).unwrap();
        check_statement(&m16, got, &statement_sha, &pins).expect("the M16 proof's statement layer");

        let mut forged = m16.clone();
        let n = forged.proof.public_values.len();
        assert_eq!(n, a.proof.public_values.len());
        forged.proof.public_values[n - 12..].copy_from_slice(&a.proof.public_values[n - 12..]);
        assert_ne!(forged.proof.public_values, m16.proof.public_values);

        // It reads as the M16 statement in every field the gate compares.
        let got = final_statement(&forged).unwrap();
        assert_eq!(got, final_statement(&m16).unwrap());
        assert_eq!(got.program_vk_digest, pins.program_vk_digest);
        assert_eq!(got.committed_values_sha256, statement_sha);

        let refusal = check_statement(&forged, got, &statement_sha, &pins).unwrap_err();
        assert_eq!(refusal.reason, "proof_public_values_digest");
    }
}
