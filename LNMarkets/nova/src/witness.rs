//! Decode the pinned v1 batch witness without changing any signed bytes.

use crate::nullifier_path::NULLIFIER_PATH_STEPS;
use crate::outcome_membership::OUTCOME_TREE_LEVELS;
use crate::{MAX_BATCH_ROWS, V1_CONTEXT_BYTES, V1_OUTCOME_BYTES, V1_SUMMARY_BYTES};

const MAX_WITNESS_BYTES: usize = 512 * 1024;
const SIGNATURE_BYTES: usize = 64;

pub struct BatchWitness<'a> {
    pub context: &'a [u8; V1_CONTEXT_BYTES],
    pub rows: Vec<RowWitness<'a>>,
}

pub struct RowWitness<'a> {
    pub summary: &'a [u8; V1_SUMMARY_BYTES],
    pub summary_signatures: [&'a [u8; SIGNATURE_BYTES]; 2],
    pub outcome: &'a [u8; V1_OUTCOME_BYTES],
    pub outcome_siblings: Vec<&'a [u8; 32]>,
    pub oracle_indices: [u8; 2],
    pub oracle_signatures: [&'a [u8; SIGNATURE_BYTES]; 2],
    pub batch_signatures: [&'a [u8; SIGNATURE_BYTES]; 2],
    pub nullifier_siblings: &'a [u8; NULLIFIER_PATH_STEPS * 32],
}

impl<'a> BatchWitness<'a> {
    /// Read the native statement layout. Cryptographic and policy checks
    /// follow inside the corresponding proof constraints.
    pub fn decode(mut bytes: &'a [u8]) -> Result<Self, &'static str> {
        if bytes.len() > MAX_WITNESS_BYTES {
            return Err("v1 batch witness exceeds 512 KiB");
        }
        if take::<8>(&mut bytes)? != b"LNMBAT01" {
            return Err("unsupported v1 witness domain");
        }
        let context = take::<V1_CONTEXT_BYTES>(&mut bytes)?;
        let row_count = u32::from_le_bytes(context[176..180].try_into().unwrap()) as usize;
        if !(1..=MAX_BATCH_ROWS).contains(&row_count) {
            return Err("v1 batch witness requires 1..32 rows");
        }

        let mut rows = Vec::with_capacity(row_count);
        for _ in 0..row_count {
            let summary = take::<V1_SUMMARY_BYTES>(&mut bytes)?;
            let summary_signatures = [take(&mut bytes)?, take(&mut bytes)?];
            let outcome = take(&mut bytes)?;
            let outcome_count = u32::from_le_bytes(summary[532..536].try_into().unwrap());
            let depth = u16::from_le_bytes(*take(&mut bytes)?) as usize;
            if !(1..=(1 << OUTCOME_TREE_LEVELS)).contains(&outcome_count)
                || depth != outcome_count.next_power_of_two().trailing_zeros() as usize
            {
                return Err("noncanonical v1 outcome depth");
            }
            let outcome_siblings = (0..depth)
                .map(|_| take(&mut bytes))
                .collect::<Result<Vec<_>, _>>()?;
            let [first_index] = *take(&mut bytes)?;
            let first_signature = take(&mut bytes)?;
            let [second_index] = *take(&mut bytes)?;
            let second_signature = take(&mut bytes)?;
            let batch_signatures = [take(&mut bytes)?, take(&mut bytes)?];
            let nullifier_siblings = take(&mut bytes)?;
            rows.push(RowWitness {
                summary,
                summary_signatures,
                outcome,
                outcome_siblings,
                oracle_indices: [first_index, second_index],
                oracle_signatures: [first_signature, second_signature],
                batch_signatures,
                nullifier_siblings,
            });
        }
        if !bytes.is_empty() {
            return Err("trailing bytes in v1 batch witness");
        }
        Ok(Self { context, rows })
    }
}

fn take<'a, const N: usize>(bytes: &mut &'a [u8]) -> Result<&'a [u8; N], &'static str> {
    let (field, rest) = bytes
        .split_at_checked(N)
        .ok_or("truncated v1 batch witness")?;
    *bytes = rest;
    Ok(field.try_into().unwrap())
}
