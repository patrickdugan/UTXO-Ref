//! Domain-separated messages signed by the parties and selected oracles.

use ff::PrimeField;
use nova_snark::frontend::{Boolean, ConstraintSystem, SynthesisError};

use crate::nullifier::{tag_hash, tagged_digest, DigestBits};
use crate::{V1_CONTEXT_BYTES, V1_OUTCOME_BYTES, V1_SUMMARY_BYTES};

pub struct RowSigningDigests {
    pub summary: DigestBits,
    pub oracle: DigestBits,
    pub consent: DigestBits,
}

/// Bind each signature's message to the same v1 wire bits used by the
/// other row constraints. The context excludes the batch magic. Every
/// wire byte is represented most-significant bit first.
pub fn row_signing_digests<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    context: &[Boolean],
    summary: &[Boolean],
    outcome: &[Boolean],
) -> Result<RowSigningDigests, SynthesisError> {
    if context.len() != V1_CONTEXT_BYTES * 8
        || summary.len() != V1_SUMMARY_BYTES * 8
        || outcome.len() != V1_OUTCOME_BYTES * 8
    {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 context, summary or outcome bit length".into(),
        ));
    }

    let summary_digest = tagged_digest(
        cs.namespace(|| "summary signature digest"),
        &tag_hash("dlc-summary"),
        summary,
    )?;

    let mut oracle = Vec::with_capacity(76 * 8);
    oracle.extend_from_slice(&summary[468 * 8..500 * 8]); // event ID
    oracle.extend_from_slice(&summary[536 * 8..540 * 8]); // maturity height
    oracle.extend_from_slice(&summary[532 * 8..536 * 8]); // outcome count
    oracle.extend_from_slice(&outcome[..36 * 8]); // outcome index and message
    let oracle_digest = tagged_digest(
        cs.namespace(|| "oracle signature digest"),
        &tag_hash("oracle-attestation"),
        &oracle,
    )?;

    let mut consent = context.to_vec();
    consent.extend_from_slice(&summary_digest);
    let consent_digest = tagged_digest(
        cs.namespace(|| "batch consent signature digest"),
        &tag_hash("batch-consent"),
        &consent,
    )?;
    Ok(RowSigningDigests {
        summary: summary_digest,
        oracle: oracle_digest,
        consent: consent_digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nullifier::bits;
    use nova_snark::{
        frontend::{test_cs::TestConstraintSystem, AllocatedBit},
        provider::Bn256EngineIPA,
        traits::Engine,
    };

    type F = <Bn256EngineIPA as Engine>::Scalar;

    fn patterned_wire<CS: ConstraintSystem<F>>(
        mut cs: CS,
        length: usize,
        scale: u8,
        seed: u8,
    ) -> Vec<Boolean> {
        let bytes = (0..length)
            .map(|i| (i as u8).wrapping_mul(scale).wrapping_add(seed))
            .collect::<Vec<_>>();
        bits(&bytes)
            .enumerate()
            .map(|(i, bit)| {
                AllocatedBit::alloc(cs.namespace(|| format!("bit {i}")), Some(bit))
                    .unwrap()
                    .into()
            })
            .collect()
    }

    #[test]
    fn signing_messages_match_independent_v1_hashes() {
        let mut cs = TestConstraintSystem::<F>::new();
        let context = patterned_wire(cs.namespace(|| "context"), 180, 13, 171);
        let summary = patterned_wire(cs.namespace(|| "summary"), 546, 31, 7);
        let outcome = patterned_wire(cs.namespace(|| "outcome"), 68, 7, 201);
        let actual =
            row_signing_digests(cs.namespace(|| "signatures"), &context, &summary, &outcome)
                .unwrap();
        let expected = [
            "caf7c8a43a06299544b7f0c0fc901351104ce5d06a6ee7e1c2e4b0b7cc853705",
            "e616a792765584e43b97b2fde1e01df1cb9ac6aaddf8397b30725f7f3afaff5a",
            "5bfedf49896fcf8cd30ca6ee93b0148d31a0adfeaea461574e8ab38357768854",
        ];
        for (i, (digest, hex)) in [actual.summary, actual.oracle, actual.consent]
            .iter()
            .zip(expected)
            .enumerate()
        {
            let bytes: [u8; 32] =
                std::array::from_fn(|j| u8::from_str_radix(&hex[j * 2..j * 2 + 2], 16).unwrap());
            for (j, (bit, expected)) in digest.iter().zip(bits(&bytes)).enumerate() {
                Boolean::enforce_equal(
                    cs.namespace(|| format!("digest {i} bit {j}")),
                    bit,
                    &Boolean::constant(expected),
                )
                .unwrap();
            }
        }
        assert!(cs.is_satisfied());
    }
}
