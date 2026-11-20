//! Bind the Nova public journal to the shared v1 context and proved outputs.

use ff::PrimeField;
use nova_snark::frontend::{Boolean, ConstraintSystem, SynthesisError};
use sha2::{Digest, Sha256};

use crate::nullifier::{tag_hash, DigestBits};
use crate::settlement_amounts::{wire_amount, Totals, MAX_MONEY};
use crate::wire::{constants, enforce_same_bits, less_than_le};
use crate::{MAX_BATCH_ROWS, V1_CONTEXT_BYTES};

pub const V1_JOURNAL_BYTES: usize = 276;

/// The caller supplies the public journal from its independent acceptance
/// context, the same signed context bits used by the rows, the computed
/// display-order txid and the constrained settlement totals.
pub fn bind_batch_journal<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    context: &[Boolean],
    journal: &[Boolean],
    txid: &DigestBits,
    totals: &Totals<F>,
) -> Result<(), SynthesisError> {
    if context.len() != V1_CONTEXT_BYTES * 8 || journal.len() != V1_JOURNAL_BYTES * 8 {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 journal dimensions".into(),
        ));
    }
    if F::CAPACITY < 51 {
        return Err(SynthesisError::Unsatisfiable(
            "journal amounts need 51 field bits".into(),
        ));
    }
    enforce_context_policy(cs.namespace(|| "context policy"), context)?;
    let tag = tag_hash("statement-domain");
    let domain = Sha256::new()
        .chain_update(tag)
        .chain_update(tag)
        .chain_update(b"co-signed-batch-proposal-certificate")
        .finalize();
    let mut prefix = b"LNMJNL01".to_vec();
    prefix.extend_from_slice(&domain);
    enforce_same_bits(
        cs.namespace(|| "journal prefix"),
        &journal[..40 * 8],
        &constants(&prefix),
    )?;
    enforce_same_bits(
        cs.namespace(|| "epoch and window"),
        &journal[40 * 8..88 * 8],
        &context[..48 * 8],
    )?;
    enforce_same_bits(
        cs.namespace(|| "row count"),
        &journal[88 * 8..92 * 8],
        &context[176 * 8..180 * 8],
    )?;
    enforce_same_bits(
        cs.namespace(|| "context roots and digest"),
        &journal[92 * 8..220 * 8],
        &context[48 * 8..176 * 8],
    )?;
    enforce_same_bits(
        cs.namespace(|| "journal txid"),
        &journal[220 * 8..252 * 8],
        txid,
    )?;

    for (i, total) in totals.iter().enumerate() {
        let mut ns = cs.namespace(|| format!("journal total {i}"));
        let start = (252 + 8 * i) * 8;
        let field: [Boolean; 64] = std::array::from_fn(|j| journal[start + j].clone());
        let committed = wire_amount(ns.namespace(|| "wire total"), &field, 0, MAX_MONEY)?;
        ns.enforce(
            || "journal total equals proved total",
            |lc| lc + committed.get_variable(),
            |lc| lc + CS::one(),
            |lc| lc + total.get_variable(),
        );
    }
    Ok(())
}

fn enforce_context_policy<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    context: &[Boolean],
) -> Result<(), SynthesisError> {
    nonzero(cs.namespace(|| "positive epoch"), &context[..8 * 8])?;
    nonzero(cs.namespace(|| "nonzero batch ID"), &context[8 * 8..40 * 8])?;
    nonzero(
        cs.namespace(|| "positive evaluation height"),
        &context[40 * 8..44 * 8],
    )?;
    nonzero(
        cs.namespace(|| "positive count"),
        &context[176 * 8..180 * 8],
    )?;

    let evaluation: [Boolean; 32] = std::array::from_fn(|i| context[40 * 8 + (i ^ 7)].clone());
    let expiry: [Boolean; 32] = std::array::from_fn(|i| context[44 * 8 + (i ^ 7)].clone());
    let count: [Boolean; 32] = std::array::from_fn(|i| context[176 * 8 + (i ^ 7)].clone());
    let expiry_limit: [Boolean; 32] =
        std::array::from_fn(|i| Boolean::constant((500_000_000u32 >> i) & 1 != 0));
    let count_limit: [Boolean; 32] =
        std::array::from_fn(|i| Boolean::constant((((MAX_BATCH_ROWS + 1) as u32) >> i) & 1 != 0));

    let inverted = less_than_le(cs.namespace(|| "height ordering"), &expiry, &evaluation)?;
    Boolean::enforce_equal(
        cs.namespace(|| "evaluation at most expiry"),
        &inverted,
        &Boolean::constant(false),
    )?;
    let height_valid = less_than_le(cs.namespace(|| "height limit"), &expiry, &expiry_limit)?;
    Boolean::enforce_equal(
        cs.namespace(|| "expiry is a block height"),
        &height_valid,
        &Boolean::constant(true),
    )?;
    let count_valid = less_than_le(cs.namespace(|| "count limit"), &count, &count_limit)?;
    Boolean::enforce_equal(
        cs.namespace(|| "count fits the batch"),
        &count_valid,
        &Boolean::constant(true),
    )
}

fn nonzero<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    bits: &[Boolean],
) -> Result<(), SynthesisError> {
    let mut has_one = Boolean::constant(false);
    for (i, bit) in bits.iter().enumerate() {
        has_one = Boolean::or(cs.namespace(|| format!("bit {i}")), &has_one, bit)?;
    }
    Boolean::enforce_equal(
        cs.namespace(|| "has a set bit"),
        &has_one,
        &Boolean::constant(true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{allocated, saved_context, F, JOURNAL};
    use nova_snark::frontend::{num::AllocatedNum, test_cs::TestConstraintSystem};

    fn check(context: &[u8], journal: &[u8]) -> bool {
        let mut cs = TestConstraintSystem::<F>::new();
        let context = allocated(cs.namespace(|| "signed context"), context);
        let journal = allocated(cs.namespace(|| "expected journal"), journal);
        let txid = allocated(cs.namespace(|| "proved txid"), &JOURNAL[220..252])
            .try_into()
            .unwrap();
        let totals = [802_660u64, 800_660, 2_000].map(F::from);
        let totals = std::array::from_fn(|i| {
            AllocatedNum::alloc(cs.namespace(|| format!("proved total {i}")), || {
                Ok(totals[i])
            })
            .unwrap()
        });
        bind_batch_journal(
            cs.namespace(|| "v1 journal"),
            &context,
            &journal,
            &txid,
            &totals,
        )
        .unwrap();
        cs.is_satisfied()
    }

    #[test]
    fn exact_journal_binds_the_context_txid_and_amounts() {
        let context = saved_context();
        assert!(check(&context, JOURNAL));
        for byte in [8, 124, 220, 268] {
            let mut modified = *JOURNAL;
            modified[byte] ^= 1;
            assert!(!check(&context, &modified));
        }
    }

    #[test]
    fn agreed_but_out_of_order_window_is_rejected() {
        let mut context = saved_context();
        let mut journal = *JOURNAL;
        context[44..48].copy_from_slice(&1000u32.to_le_bytes());
        journal[84..88].copy_from_slice(&1000u32.to_le_bytes());
        assert!(!check(&context, &journal));
    }
}
