//! Constraints for the v1 unsigned Bitcoin transaction envelope and hashes.

use ff::PrimeField;
use nova_snark::frontend::{sha256, Boolean, ConstraintSystem, SynthesisError};

use crate::nullifier::DigestBits;
use crate::wire::{constants, enforce_same_bits, less_than_le};
use crate::{MAX_BATCH_ROWS, V1_CONTEXT_BYTES, V1_SUMMARY_BYTES};

const INPUT_BYTES: usize = 41;
const OUTPUT_BYTES: usize = 43;
const FIXED_BYTES: usize = 10;

/// Bind the candidate transaction to the exact signed digest, retained
/// display-order txid, ordered summary outpoints and maximal maturity.
/// Circuit dimensions follow the public transaction layout. The caller
/// also constrains each output's value and script against the row payouts.
pub fn bind_unsigned_transaction<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    context: &[Boolean],
    summaries: &[&[Boolean]],
    tx: &[Boolean],
    journal_txid: &DigestBits,
) -> Result<(), SynthesisError> {
    if context.len() != V1_CONTEXT_BYTES * 8
        || !(1..=MAX_BATCH_ROWS).contains(&summaries.len())
        || summaries.iter().any(|s| s.len() != V1_SUMMARY_BYTES * 8)
        || tx.len() % 8 != 0
    {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 transaction dimensions".into(),
        ));
    }
    let inputs = summaries.len();
    let output_bytes = (tx.len() / 8)
        .checked_sub(FIXED_BYTES + INPUT_BYTES * inputs)
        .ok_or_else(|| SynthesisError::Unsatisfiable("truncated v1 transaction".into()))?;
    let outputs = output_bytes / OUTPUT_BYTES;
    if output_bytes % OUTPUT_BYTES != 0 || !(1..=3 * inputs).contains(&outputs) {
        return Err(SynthesisError::Unsatisfiable(
            "invalid v1 output count".into(),
        ));
    }

    let tx_field = |start: usize, len: usize| &tx[start * 8..(start + len) * 8];
    let mut header = 2u32.to_le_bytes().to_vec();
    header.push(inputs as u8);
    enforce_same_bits(
        cs.namespace(|| "transaction header"),
        tx_field(0, 5),
        &constants(&header),
    )?;
    enforce_same_bits(
        cs.namespace(|| "signed row count"),
        &context[176 * 8..180 * 8],
        &constants(&(inputs as u32).to_le_bytes()),
    )?;

    let mut previous_outpoint: Option<Vec<Boolean>> = None;
    let mut maturity = [false; 32].map(Boolean::constant);
    for (i, summary) in summaries.iter().enumerate() {
        let mut row = cs.namespace(|| format!("input {i}"));
        let display_txid = &summary[128 * 8..160 * 8];
        let vout = &summary[160 * 8..164 * 8];
        let mut input = reverse_bytes(display_txid);
        input.extend_from_slice(vout);
        input.extend(constants(&[0, 0xfd, 0xff, 0xff, 0xff]));
        enforce_same_bits(
            row.namespace(|| "wire input"),
            tx_field(5 + INPUT_BYTES * i, INPUT_BYTES),
            &input,
        )?;

        // Numeric vout order follows the displayed txid's byte order.
        let mut ordered = display_txid.to_vec();
        ordered.extend(reverse_bytes(vout));
        ordered.reverse();
        if let Some(previous) = previous_outpoint.as_ref() {
            enforce_increasing(
                row.namespace(|| "unique ordered outpoint"),
                previous,
                &ordered,
            )?;
        }
        previous_outpoint = Some(ordered);

        let height = &summary[536 * 8..540 * 8];
        let height_le: [Boolean; 32] = std::array::from_fn(|i| height[i ^ 7].clone());
        let grows = less_than_le(
            row.namespace(|| "new maximum height"),
            &maturity,
            &height_le,
        )?;
        for (bit, (maximum, current)) in maturity.iter_mut().zip(&height_le).enumerate() {
            *maximum = Boolean::sha256_ch(
                row.namespace(|| format!("maximum height bit {bit}")),
                &grows,
                current,
                maximum,
            )?;
        }
    }

    let outputs_at = 5 + inputs * INPUT_BYTES;
    enforce_same_bits(
        cs.namespace(|| "canonical output count"),
        tx_field(outputs_at, 1),
        &constants(&[outputs as u8]),
    )?;
    let mut previous_script: Option<Vec<Boolean>> = None;
    for i in 0..outputs {
        let mut output = cs.namespace(|| format!("output {i}"));
        let start = outputs_at + 1 + i * OUTPUT_BYTES;
        enforce_same_bits(
            output.namespace(|| "P2TR script template"),
            tx_field(start + 8, 3),
            &constants(&[34, 0x51, 0x20]),
        )?;
        let script: Vec<_> = tx_field(start + 9, 34).iter().rev().cloned().collect();
        if let Some(previous) = previous_script.as_ref() {
            enforce_increasing(
                output.namespace(|| "unique ordered script"),
                previous,
                &script,
            )?;
        }
        previous_script = Some(script);
    }
    let locktime: [Boolean; 32] = std::array::from_fn(|i| maturity[i ^ 7].clone());
    enforce_same_bits(
        cs.namespace(|| "transaction locktime"),
        tx_field(tx.len() / 8 - 4, 4),
        &locktime,
    )?;

    let digest = sha256(cs.namespace(|| "unsigned transaction SHA256"), tx)?;
    enforce_same_bits(
        cs.namespace(|| "signed transaction digest"),
        &digest,
        &context[144 * 8..176 * 8],
    )?;
    let txid = sha256(cs.namespace(|| "Bitcoin transaction hash"), &digest)?;
    enforce_same_bits(
        cs.namespace(|| "journal display txid"),
        &reverse_bytes(&txid),
        journal_txid,
    )
}

fn reverse_bytes(bits: &[Boolean]) -> Vec<Boolean> {
    bits.chunks_exact(8).rev().flatten().cloned().collect()
}

fn enforce_increasing<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    previous: &[Boolean],
    current: &[Boolean],
) -> Result<(), SynthesisError> {
    let increasing = less_than_le(cs.namespace(|| "compare"), previous, current)?;
    Boolean::enforce_equal(
        cs.namespace(|| "strict order"),
        &increasing,
        &Boolean::constant(true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{allocated, decode, saved_context, F, JOURNAL};
    use nova_snark::frontend::test_cs::TestConstraintSystem;
    use sha2::{Digest, Sha256};

    fn transaction() -> [u8; 221] {
        decode(concat!(
            "0200000002f38b4c8177edf7d72a3f7800984e53041b0715d7f02cd2b52d97c6cbffa1e8a7",
            "0200000000fdffffff75ca88a50979c4314e9dd8a9f1361a668437a135c54269ea0beee1edd0bcece8",
            "0100000000fdffffff0394020000000000002251202fa2104d6b38d11b0230010559879124e42ab8dfeff5ff29dc9cdadd4ecacc3f",
            "96cb050000000000225120352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d56",
            "a69060000000000225120421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fce9030000"
        ))
    }

    fn check(context: &[u8], tx: &[u8], txid: &[u8]) -> bool {
        let mut summaries = [[0u8; V1_SUMMARY_BYTES]; 2];
        for (summary, (txid, vout, height)) in summaries.iter_mut().zip([
            (
                "a7e8a1ffcbc6972db5d22cf0d715071b04534e9800783f2ad7f7ed77814c8bf3",
                2u32,
                1001u32,
            ),
            (
                "e8ecbcd0ede1ee0bea6942c535a13784661a36f1a9d89d4e31c47909a588ca75",
                1u32,
                1000u32,
            ),
        ]) {
            summary[128..160].copy_from_slice(&decode::<32>(txid));
            summary[160..164].copy_from_slice(&vout.to_le_bytes());
            summary[536..540].copy_from_slice(&height.to_le_bytes());
        }
        let mut cs = TestConstraintSystem::<F>::new();
        let context = allocated(cs.namespace(|| "context"), context);
        let one = allocated(cs.namespace(|| "first summary"), &summaries[0]);
        let two = allocated(cs.namespace(|| "second summary"), &summaries[1]);
        let tx = allocated(cs.namespace(|| "transaction"), tx);
        let txid = allocated(cs.namespace(|| "journal txid"), txid)
            .try_into()
            .unwrap();
        bind_unsigned_transaction(cs.namespace(|| "bind"), &context, &[&one, &two], &tx, &txid)
            .unwrap();
        cs.is_satisfied()
    }

    #[test]
    fn saved_transaction_binds_signed_digest_and_journal_txid() {
        let mut tx = transaction();
        assert!(check(&saved_context(), &tx, &JOURNAL[220..252]));
        tx[88] ^= 1; // First output amount, with the signed digest retained.
        assert!(!check(&saved_context(), &tx, &JOURNAL[220..252]));
    }

    #[test]
    fn rehashing_an_altered_locktime_does_not_bypass_summary_maturity() {
        let mut tx = transaction();
        tx[217] ^= 1;
        let digest = Sha256::digest(tx);
        let mut context = saved_context();
        context[144..176].copy_from_slice(&digest);
        let mut txid: [u8; 32] = Sha256::digest(digest).into();
        txid.reverse();
        assert!(!check(&context, &tx, &txid));
    }
}
