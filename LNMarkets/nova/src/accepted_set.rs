//! The ordered v1 commitment to every accepted contract summary.

use ff::PrimeField;
use nova_snark::frontend::{Boolean, ConstraintSystem, SynthesisError};

use crate::nullifier::{merkle_parent, tag_hash, tagged_digest, DigestBits};
use crate::wire::{constants, enforce_same_bits};
use crate::{MAX_BATCH_ROWS, V1_CONTEXT_BYTES};

/// Verify the commitment in the signed context. Pass the summary digests
/// computed from each row's signed v1 bytes, in the same order as the rows.
/// Circuit dimensions follow the public row count in the journal.
pub fn verify_accepted_set<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    context: &[Boolean],
    summaries: &[DigestBits],
) -> Result<(), SynthesisError> {
    if context.len() != V1_CONTEXT_BYTES * 8 || !(1..=MAX_BATCH_ROWS).contains(&summaries.len()) {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 accepted set dimensions".into(),
        ));
    }
    let count = summaries.len() as u32;
    let count_bits = constants(&count.to_le_bytes());
    enforce_same_bits(
        cs.namespace(|| "context row count"),
        &context[176 * 8..180 * 8],
        &count_bits,
    )?;

    let width = summaries.len().next_power_of_two();
    let accepted_tag = tag_hash("accepted-contract-leaf");
    let padding_tag = tag_hash("accepted-contract-padding");
    let node_tag = tag_hash("accepted-contract-node");
    let mut level = Vec::with_capacity(width);
    for index in 0..width {
        let mut payload = constants(&(index as u32).to_le_bytes());
        payload.extend_from_slice(&count_bits);
        let tag = match summaries.get(index) {
            Some(digest) => {
                payload.extend_from_slice(digest);
                &accepted_tag
            }
            None => &padding_tag,
        };
        level.push(tagged_digest(
            cs.namespace(|| format!("leaf {index}")),
            tag,
            &payload,
        )?);
    }

    for height in 0..width.trailing_zeros() {
        let mut parents = Vec::with_capacity(level.len() / 2);
        for (index, pair) in level.chunks_exact(2).enumerate() {
            parents.push(merkle_parent(
                cs.namespace(|| format!("height {height} node {index}")),
                &node_tag,
                &pair[0],
                &pair[1],
                &Boolean::constant(false),
            )?);
        }
        level = parents;
    }
    enforce_same_bits(
        cs.namespace(|| "context accepted set root"),
        &level[0],
        &context[48 * 8..80 * 8],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{allocated, decode, saved_context, F};
    use nova_snark::frontend::test_cs::TestConstraintSystem;

    fn check(context: &[u8], summaries: &[[u8; 32]]) -> bool {
        let mut cs = TestConstraintSystem::<F>::new();
        let context = allocated(cs.namespace(|| "signed context"), context);
        let summaries = summaries
            .iter()
            .enumerate()
            .map(|(i, digest)| {
                allocated(cs.namespace(|| format!("summary digest {i}")), digest)
                    .try_into()
                    .unwrap()
            })
            .collect::<Vec<DigestBits>>();
        verify_accepted_set(cs.namespace(|| "accepted set"), &context, &summaries).unwrap();
        cs.is_satisfied()
    }

    #[test]
    fn saved_batch_root_binds_order_and_row_count() {
        let mut context = saved_context();
        let first = decode("503a6fc266116b5ac714bacfef296aeeb21f3b86c4b8bcf865f32e423112e05b");
        let second = decode("6cbd68afd6050d69e83e512199707cf6d817cb918a7824cf8c434bdd3e041b53");
        assert!(check(&context, &[first, second]));
        assert!(!check(&context, &[second, first]));
        context[176..180].copy_from_slice(&1u32.to_le_bytes());
        let mut cs = TestConstraintSystem::<F>::new();
        let summaries = [first, second].map(|digest| constants(&digest).try_into().unwrap());
        assert!(verify_accepted_set(
            cs.namespace(|| "incorrect public shape"),
            &constants(&context),
            &summaries
        )
        .is_err());
    }

    #[test]
    fn three_rows_use_the_canonical_padding_leaf() {
        let mut context = [0u8; V1_CONTEXT_BYTES];
        context[176..].copy_from_slice(&3u32.to_le_bytes());
        context[48..80].copy_from_slice(&decode::<32>(
            "22608525a6a08cf588a55da7731b1a6780cf148201bb2a8e930b5a277d1f91eb",
        ));
        assert!(check(&context, &[[0x53; 32], [0x2f; 32], [0x8c; 32]]));
    }
}
