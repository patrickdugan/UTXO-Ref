//! Structural v1 summary rules and the two-oracle key selection.

use ff::PrimeField;
use nova_snark::frontend::{Boolean, ConstraintSystem, SynthesisError};

use crate::nullifier::DigestBits;
use crate::settlement_amounts::{wire_amount, MAX_MONEY, MIN_OUTPUT_SATS};
use crate::wire::{constants, enforce_same_bits, less_than_le, require_nonzero};
use crate::{MAX_BATCH_ROWS, V1_CONTEXT_BYTES, V1_SUMMARY_BYTES};

/// Check the byte-level wire policy on the same summaries used in the
/// signed batch. The full relation also validates secp256k1 points and
/// derives the Taproot funding commitment from the two party keys.
pub fn enforce_summary_policy<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    context: &[Boolean],
    summaries: &[&[Boolean]],
) -> Result<(), SynthesisError> {
    if context.len() != V1_CONTEXT_BYTES * 8
        || !(1..=MAX_BATCH_ROWS).contains(&summaries.len())
        || summaries.iter().any(|s| s.len() != V1_SUMMARY_BYTES * 8)
        || F::CAPACITY < 51
    {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 summary dimensions".into(),
        ));
    }
    enforce_same_bits(
        cs.namespace(|| "context row count"),
        &context[176 * 8..],
        &constants(&(summaries.len() as u32).to_le_bytes()),
    )?;
    let evaluation = little_u32(&context[40 * 8..44 * 8]);
    for (i, summary) in summaries.iter().enumerate() {
        let mut row = cs.namespace(|| format!("row {i}"));
        enforce_row(&mut row, summary, &evaluation)?;
        for (j, preceding) in summaries[..i].iter().enumerate() {
            require_different(
                row.namespace(|| format!("unique contract ID compared with {j}")),
                &preceding[32 * 8..64 * 8],
                &summary[32 * 8..64 * 8],
            )?;
        }
    }
    Ok(())
}

fn enforce_row<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: &mut CS,
    summary: &[Boolean],
    evaluation: &[Boolean; 32],
) -> Result<(), SynthesisError> {
    let field = |offset: usize, size: usize| &summary[offset * 8..(offset + size) * 8];
    for (name, offset) in [
        ("salt", 0),
        ("contract ID", 32),
        ("plan digest", 64),
        ("recovery digest", 96),
        ("funding txid", 128),
        ("oracle event", 468),
        ("outcome root", 500),
    ] {
        require_nonzero(cs.namespace(|| name), field(offset, 32))?;
    }
    let inverted_index = field(160, 4).iter().map(Boolean::not).collect::<Vec<_>>();
    require_nonzero(
        cs.namespace(|| "funding output index below maximum"),
        &inverted_index,
    )?;
    wire_amount(
        cs.namespace(|| "funding collateral"),
        field(164, 8).try_into().unwrap(),
        3 * MIN_OUTPUT_SATS + 1,
        MAX_MONEY,
    )?;
    require_different(
        cs.namespace(|| "distinct party keys"),
        field(206, 32),
        field(238, 32),
    )?;

    for (i, offset) in [372, 404].into_iter().enumerate() {
        let one: Vec<_> = field(offset, 32).iter().rev().cloned().collect();
        let two: Vec<_> = field(offset + 32, 32).iter().rev().cloned().collect();
        let ordered = less_than_le(cs.namespace(|| format!("oracle key order {i}")), &one, &two)?;
        require(
            cs.namespace(|| format!("distinct sorted oracle keys {i}")),
            &ordered,
            true,
        )?;
    }
    for (role, offset) in [
        ("funding", 172),
        ("trader", 270),
        ("maker", 304),
        ("anchor", 338),
    ] {
        enforce_same_bits(
            cs.namespace(|| format!("{role} P2TR template")),
            field(offset, 2),
            &constants(&[0x51, 0x20]),
        )?;
    }
    for (left, right) in [(270, 304), (270, 338), (304, 338)] {
        require_different(
            cs.namespace(|| format!("distinct scripts at {left} and {right}")),
            field(left, 34),
            field(right, 34),
        )?;
    }

    require_nonzero(cs.namespace(|| "positive outcome count"), field(532, 4))?;
    let outcome_count = little_u32(field(532, 4));
    let count_limit = little_u32(&constants(&1025u32.to_le_bytes()));
    let count_valid = less_than_le(
        cs.namespace(|| "outcome count bound"),
        &outcome_count,
        &count_limit,
    )?;
    require(cs.namespace(|| "outcome count fits"), &count_valid, true)?;
    require_nonzero(cs.namespace(|| "positive maturity"), field(536, 4))?;
    require_nonzero(cs.namespace(|| "positive refund delay"), field(544, 2))?;
    let maturity = little_u32(field(536, 4));
    let refund = little_u32(field(540, 4));
    let height_limit = little_u32(&constants(&500_000_000u32.to_le_bytes()));
    let refund_after = less_than_le(
        cs.namespace(|| "maturity and refund order"),
        &maturity,
        &refund,
    )?;
    require(
        cs.namespace(|| "refund after maturity"),
        &refund_after,
        true,
    )?;
    let refund_is_height = less_than_le(
        cs.namespace(|| "refund height bound"),
        &refund,
        &height_limit,
    )?;
    require(
        cs.namespace(|| "refund block height"),
        &refund_is_height,
        true,
    )?;
    let immature = less_than_le(
        cs.namespace(|| "maturity versus evaluation"),
        evaluation,
        &maturity,
    )?;
    require(
        cs.namespace(|| "mature by evaluation height"),
        &immature,
        false,
    )
}

/// The two encoded indices are single MSB-first bytes. Return the selected
/// key bits, from the same summary, in increasing index order for BIP340.
pub fn select_oracle_keys<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    summary: &[Boolean],
    indices: &[[Boolean; 8]; 2],
) -> Result<[DigestBits; 2], SynthesisError> {
    if summary.len() != V1_SUMMARY_BYTES * 8 {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 oracle summary dimensions".into(),
        ));
    }
    let le = indices.clone().map(|mut index| {
        index.reverse();
        index
    });
    let ordered = less_than_le(cs.namespace(|| "oracle index order"), &le[0], &le[1])?;
    require(
        cs.namespace(|| "two distinct sorted oracle indices"),
        &ordered,
        true,
    )?;

    let mut selected = Vec::with_capacity(2);
    for (i, index) in indices.iter().enumerate() {
        let mut ns = cs.namespace(|| format!("oracle {i}"));
        enforce_same_bits(
            ns.namespace(|| "zero high index bits"),
            &index[..6],
            &[false; 6].map(Boolean::constant),
        )?;
        let hi = &index[6];
        let lo = &index[7];
        let three = Boolean::and(ns.namespace(|| "index equals three"), hi, lo)?;
        require(ns.namespace(|| "index at most two"), &three, false)?;
        let mut key = Vec::with_capacity(256);
        for bit in 0..256 {
            let mut cell = ns.namespace(|| format!("key bit {bit}"));
            let key_zero = &summary[372 * 8 + bit];
            let key_one = &summary[404 * 8 + bit];
            let key_two = &summary[436 * 8 + bit];
            let lower = Boolean::sha256_ch(
                cell.namespace(|| "choose zero or one"),
                lo,
                key_one,
                key_zero,
            )?;
            key.push(Boolean::sha256_ch(
                cell.namespace(|| "choose key"),
                hi,
                key_two,
                &lower,
            )?);
        }
        selected.push(DigestBits::try_from(key).unwrap());
    }
    Ok(selected.try_into().unwrap())
}

fn little_u32(wire: &[Boolean]) -> [Boolean; 32] {
    std::array::from_fn(|i| wire[i ^ 7].clone())
}

fn require<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: CS,
    bit: &Boolean,
    expected: bool,
) -> Result<(), SynthesisError> {
    Boolean::enforce_equal(cs, bit, &Boolean::constant(expected))
}

pub(crate) fn require_different<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    one: &[Boolean],
    two: &[Boolean],
) -> Result<(), SynthesisError> {
    let different = one
        .iter()
        .zip(two)
        .enumerate()
        .map(|(i, (a, b))| Boolean::xor(cs.namespace(|| format!("different bit {i}")), a, b))
        .collect::<Result<Vec<_>, _>>()?;
    require_nonzero(cs.namespace(|| "different"), &different)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nullifier::bits;
    use crate::wire::fixture::{allocated, saved_context, F};
    use nova_snark::frontend::test_cs::TestConstraintSystem;

    fn summary(tag: u8) -> [u8; V1_SUMMARY_BYTES] {
        let mut bytes = [0u8; V1_SUMMARY_BYTES];
        bytes[..160].fill(tag);
        bytes[164..172].copy_from_slice(&401_330u64.to_le_bytes());
        for (offset, marker) in [(172, 1), (270, 2), (304, 3), (338, 4)] {
            bytes[offset..offset + 2].copy_from_slice(&[0x51, 0x20]);
            bytes[offset + 2..offset + 34].fill(marker);
        }
        for (offset, marker) in [
            (206, 0x11),
            (238, 0x22),
            (372, 0x30),
            (404, 0x60),
            (436, 0x70),
        ] {
            bytes[offset..offset + 32].fill(marker);
        }
        bytes[468..532].fill(tag);
        bytes[532..536].copy_from_slice(&3u32.to_le_bytes());
        bytes[536..540].copy_from_slice(&1000u32.to_le_bytes());
        bytes[540..544].copy_from_slice(&1020u32.to_le_bytes());
        bytes[544..546].copy_from_slice(&8u16.to_le_bytes());
        bytes
    }

    fn check(left: &[u8], right: &[u8]) -> bool {
        let mut cs = TestConstraintSystem::<F>::new();
        let context = allocated(cs.namespace(|| "accepted context"), &saved_context());
        let first = allocated(cs.namespace(|| "first summary"), left);
        let second = allocated(cs.namespace(|| "second summary"), right);
        enforce_summary_policy(
            cs.namespace(|| "batch policy"),
            &context,
            &[&first, &second],
        )
        .unwrap();
        cs.is_satisfied()
    }

    #[test]
    fn enforces_identities_roles_maturity_and_refund_policy() {
        let left = summary(1);
        let right = summary(2);
        assert!(check(&left, &right));

        let mut duplicate = right;
        duplicate[32..64].copy_from_slice(&left[32..64]);
        assert!(!check(&left, &duplicate));
        let mut repeated_script = right;
        repeated_script.copy_within(270..304, 304);
        assert!(!check(&left, &repeated_script));
        let mut premature = right;
        premature[536..540].copy_from_slice(&1002u32.to_le_bytes());
        assert!(!check(&left, &premature));
        let mut no_csv = right;
        no_csv[544..546].fill(0);
        assert!(!check(&left, &no_csv));
        let mut reserved = right;
        reserved[160..164].fill(0xff);
        assert!(!check(&left, &reserved));
        let mut unordered_oracles = right;
        unordered_oracles[404] = 0xff;
        assert!(!check(&left, &unordered_oracles));
    }

    #[test]
    fn selects_every_two_key_subset_and_rejects_bad_indices() {
        for pair in [[0u8, 1], [0, 2], [1, 2], [1, 1], [2, 1], [0, 3], [0, 128]] {
            let mut cs = TestConstraintSystem::<F>::new();
            let summary = allocated(cs.namespace(|| "summary"), &summary(1));
            let indices = std::array::from_fn(|i| {
                allocated(cs.namespace(|| format!("index {i}")), &pair[i..i + 1])
                    .try_into()
                    .unwrap()
            });
            let keys =
                select_oracle_keys(cs.namespace(|| "selected keys"), &summary, &indices).unwrap();
            let valid = pair[0] < pair[1] && pair[1] < 3;
            if valid {
                for (key, index) in keys.iter().zip(pair) {
                    let expected = [[0x30; 32], [0x60; 32], [0x70; 32]][index as usize];
                    assert!(key
                        .iter()
                        .zip(bits(&expected))
                        .all(|(actual, bit)| actual.get_value() == Some(bit)));
                }
            }
            assert_eq!(cs.is_satisfied(), valid);
        }
    }
}
