//! The exact v1 selected-outcome Merkle relation.

use ff::PrimeField;
use nova_snark::frontend::{Boolean, ConstraintSystem, SynthesisError};

use crate::nullifier::{merkle_parent, tag_hash, tagged_digest, DigestBits};
use crate::{V1_OUTCOME_BYTES, V1_SUMMARY_BYTES};

/// Up to 1024 outcomes fit in a 10-level tree. An unpadded v1 witness
/// supplies only the active siblings. The circuit represents the rest as zero.
pub const OUTCOME_TREE_LEVELS: usize = 10;

/// Recompute the selected leaf and enforce its membership in the root in the
/// signed summary. Use the same encoded summary and outcome bits for all
/// other checks. Each wire byte is MSB first. Allocate all ten siblings as
/// private bits, including zero padding, to keep the circuit shape fixed.
pub fn verify_selected_outcome<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    summary: &[Boolean],
    outcome: &[Boolean],
    siblings: &[DigestBits; OUTCOME_TREE_LEVELS],
) -> Result<(), SynthesisError> {
    if summary.len() != V1_SUMMARY_BYTES * 8 || outcome.len() != V1_OUTCOME_BYTES * 8 {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 summary or outcome bit length".into(),
        ));
    }
    let count_wire = &summary[532 * 8..536 * 8];
    let count = std::array::from_fn(|i| count_wire[i ^ 7].clone());
    let index = std::array::from_fn(|i| outcome[i ^ 7].clone());
    let valid_index = less_than(cs.namespace(|| "compare index"), &index, &count)?;
    expect_bit(cs.namespace(|| "index below count"), &valid_index, true)?;
    let valid_count = less_than(
        cs.namespace(|| "compare count"),
        &count,
        &constant_u32(1025),
    )?;
    expect_bit(
        cs.namespace(|| "count within tree capacity"),
        &valid_count,
        true,
    )?;
    let mut message_nonzero = Boolean::constant(false);
    for (i, bit) in outcome[4 * 8..36 * 8].iter().enumerate() {
        message_nonzero = Boolean::or(
            cs.namespace(|| format!("message bit {i}")),
            &message_nonzero,
            bit,
        )?;
    }
    expect_bit(
        cs.namespace(|| "nonzero outcome message"),
        &message_nonzero,
        true,
    )?;

    let mut leaf = Vec::with_capacity(136 * 8);
    leaf.extend_from_slice(&summary[32 * 8..64 * 8]);
    leaf.extend_from_slice(&summary[468 * 8..500 * 8]);
    leaf.extend_from_slice(count_wire);
    leaf.extend_from_slice(outcome);
    let mut node = tagged_digest(
        cs.namespace(|| "selected outcome leaf"),
        &tag_hash("outcome-leaf"),
        &leaf,
    )?;
    let node_tag = tag_hash("outcome-node");
    for (level, sibling) in siblings.iter().enumerate() {
        let mut ns = cs.namespace(|| format!("path level {level}"));
        let active = less_than(
            ns.namespace(|| "active when count exceeds level capacity"),
            &constant_u32(1 << level),
            &count,
        )?;
        let parent = merkle_parent(
            ns.namespace(|| "Merkle parent"),
            &node_tag,
            &node,
            sibling,
            &index[level],
        )?;
        for bit in 0..256 {
            let mut bit_ns = ns.namespace(|| format!("path bit {bit}"));
            let nonzero_pad = Boolean::and(
                bit_ns.namespace(|| "padding bit"),
                &active.not(),
                &sibling[bit],
            )?;
            expect_bit(bit_ns.namespace(|| "zero padding"), &nonzero_pad, false)?;
            node[bit] = Boolean::sha256_ch(
                bit_ns.namespace(|| "apply active parent"),
                &active,
                &parent[bit],
                &node[bit],
            )?;
        }
    }
    for (i, (computed, committed)) in node.iter().zip(&summary[500 * 8..532 * 8]).enumerate() {
        Boolean::enforce_equal(
            cs.namespace(|| format!("root bit {i}")),
            computed,
            committed,
        )?;
    }
    Ok(())
}

fn expect_bit<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: CS,
    value: &Boolean,
    expected: bool,
) -> Result<(), SynthesisError> {
    Boolean::enforce_equal(cs, value, &Boolean::constant(expected))
}

fn constant_u32(value: u32) -> [Boolean; 32] {
    std::array::from_fn(|i| Boolean::constant((value >> i) & 1 != 0))
}

fn less_than<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    left: &[Boolean; 32],
    right: &[Boolean; 32],
) -> Result<Boolean, SynthesisError> {
    // A more significant differing bit overrides the lower-bit comparison.
    let mut less = Boolean::constant(false);
    for (i, (a, b)) in left.iter().zip(right).enumerate() {
        let mut ns = cs.namespace(|| format!("compare bit {i}"));
        let different = Boolean::xor(ns.namespace(|| "different"), a, b)?;
        less = Boolean::sha256_ch(
            ns.namespace(|| "take significant bit"),
            &different,
            b,
            &less,
        )?;
    }
    Ok(less)
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

    fn decode<const N: usize>(hex: &str) -> [u8; N] {
        assert_eq!(hex.len(), 2 * N);
        std::array::from_fn(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
    }

    fn allocated<CS: ConstraintSystem<F>>(mut cs: CS, bytes: &[u8]) -> Vec<Boolean> {
        bits(bytes)
            .enumerate()
            .map(|(i, bit)| {
                AllocatedBit::alloc(cs.namespace(|| format!("bit {i}")), Some(bit))
                    .unwrap()
                    .into()
            })
            .collect()
    }

    #[test]
    fn saved_selected_outcome_matches_the_committed_root_and_rejects_substitution() {
        // The saved batch's second trade selects index two of three.
        let mut summary = [0u8; V1_SUMMARY_BYTES];
        summary[32..64].copy_from_slice(&decode::<32>(
            "b63463f36ef1b8f6556a6bbcddc7d2fd215f05e4c9902ded373c7aa1e71f5bc2",
        ));
        summary[468..500].copy_from_slice(&decode::<32>(
            "2fba4fdaf51f089a76ea0220f2ab44c8ea346adacc375a341a5db1e42f4c5e11",
        ));
        summary[500..532].copy_from_slice(&decode::<32>(
            "8ac19164b9fc0e7e543f4ca238610f6a8fb5c8f20c02a28ab0cef6a07477f954",
        ));
        summary[532..536].copy_from_slice(&3u32.to_le_bytes());
        let outcome = decode::<68>(concat!(
            "02000000d8ae5f1b4d16ba96cdf3fb784e39e490541ad755681e365c5cf9f37cad4582ca",
            "5d7004000000000023aa0100000000004a01000000000000e803000000000000",
        ));
        let mut witness = [[0; 32]; OUTCOME_TREE_LEVELS];
        witness[0] = decode("b58219525a56654c1e9b6f63896a3d1f8beb329d9e262c8e27ea2ae151248f4b");
        witness[1] = decode("73e3208783e414ef14de7f2188f351b23f1f806dd50a90ab8da52b1844429b1c");
        for altered in [false, true] {
            witness[0][0] ^= u8::from(altered);
            let mut cs = TestConstraintSystem::<F>::new();
            let summary_bits = allocated(cs.namespace(|| "summary"), &summary);
            let outcome_bits = allocated(cs.namespace(|| "outcome"), &outcome);
            let siblings = std::array::from_fn(|i| {
                allocated(cs.namespace(|| format!("sibling {i}")), &witness[i])
                    .try_into()
                    .unwrap()
            });
            verify_selected_outcome(
                cs.namespace(|| "membership"),
                &summary_bits,
                &outcome_bits,
                &siblings,
            )
            .unwrap();
            assert_eq!(cs.is_satisfied(), !altered);
        }
    }

    #[test]
    fn numeric_comparison_covers_boundaries_and_bit_orders() {
        for (left, right) in [
            (0u32, 0u32),
            (0, 1),
            (1, 1),
            (3, 4),
            (4, 3),
            (255, 256),
            (1024, 1025),
            (1025, 1025),
        ] {
            let mut cs = TestConstraintSystem::<F>::new();
            let left_wire = allocated(cs.namespace(|| "left"), &left.to_le_bytes());
            let right_wire = allocated(cs.namespace(|| "right"), &right.to_le_bytes());
            let a = std::array::from_fn(|i| left_wire[i ^ 7].clone());
            let b = std::array::from_fn(|i| right_wire[i ^ 7].clone());
            let result = less_than(cs.namespace(|| "less than"), &a, &b).unwrap();
            assert_eq!(result.get_value(), Some(left < right));
            assert!(cs.is_satisfied());
        }
    }
}
