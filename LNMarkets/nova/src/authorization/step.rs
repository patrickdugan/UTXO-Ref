//! A Nova step with the retained v1 journal as its public input.

use ff::{PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{num::AllocatedNum, ConstraintSystem, SynthesisError},
    traits::circuit::StepCircuit,
};

use crate::journal_binding::V1_JOURNAL_BYTES;
use crate::nullifier_path::{pack_limb, unpack_bits, NULLIFIER_PATH_STEPS};
use crate::transaction_binding::{FIXED_BYTES, INPUT_BYTES, OUTPUT_BYTES};
use crate::witness::{BatchWitness, RowWitness};
use crate::{MAX_BATCH_ROWS, V1_CONTEXT_BYTES, V1_OUTCOME_BYTES, V1_SUMMARY_BYTES};

use super::constrain_linked_authorization;

const JOURNAL_LIMBS: usize = V1_JOURNAL_BYTES.div_ceil(16);
const STATE_ARITY: usize = JOURNAL_LIMBS + 3;

/// The verifier derives the row count from its retained journal and pins
/// the transaction layout when choosing the circuit parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorizationLayout {
    row_count: usize,
    output_count: usize,
}

impl AuthorizationLayout {
    pub fn new(row_count: usize, output_count: usize) -> Result<Self, &'static str> {
        if !(1..=MAX_BATCH_ROWS).contains(&row_count)
            || !(3..=3 * row_count).contains(&output_count)
        {
            return Err("invalid authorization circuit dimensions");
        }
        Ok(Self {
            row_count,
            output_count,
        })
    }

    pub fn from_transaction_size(
        row_count: usize,
        transaction_bytes: usize,
    ) -> Result<Self, &'static str> {
        if !(1..=MAX_BATCH_ROWS).contains(&row_count) {
            return Err("invalid authorization row count");
        }
        let outputs = transaction_bytes
            .checked_sub(FIXED_BYTES + INPUT_BYTES * row_count)
            .ok_or("truncated authorization transaction")?;
        if outputs % OUTPUT_BYTES != 0 {
            return Err("invalid authorization transaction size");
        }
        Self::new(row_count, outputs / OUTPUT_BYTES)
    }

    fn transaction_bytes(&self) -> usize {
        FIXED_BYTES + INPUT_BYTES * self.row_count + OUTPUT_BYTES * self.output_count
    }
}

/// A single authorization step returns the unchanged journal and the
/// bindings to the nullifier and curve proofs.
#[derive(Clone)]
pub struct AuthorizationStep {
    layout: AuthorizationLayout,
    witness: Option<(Vec<u8>, Vec<u8>)>,
}

impl AuthorizationStep {
    pub fn blank(layout: AuthorizationLayout) -> Self {
        Self {
            layout,
            witness: None,
        }
    }

    pub fn with_witness(
        layout: AuthorizationLayout,
        bytes: Vec<u8>,
        transaction: Vec<u8>,
    ) -> Result<Self, &'static str> {
        if BatchWitness::decode(&bytes)?.rows.len() != layout.row_count
            || transaction.len() != layout.transaction_bytes()
        {
            return Err("witness dimensions differ from authorization parameters");
        }
        Ok(Self {
            layout,
            witness: Some((bytes, transaction)),
        })
    }
}

/// Pin every byte before verifying a single authorization step.
pub fn initial_state<F: PrimeField>(journal: &[u8; V1_JOURNAL_BYTES]) -> [F; STATE_ARITY] {
    let mut state = [F::ZERO; STATE_ARITY];
    for (field, bytes) in state.iter_mut().zip(journal.chunks(16)) {
        let value = bytes
            .iter()
            .fold(0u128, |value, byte| (value << 8) | u128::from(*byte));
        *field = F::from_u128(value);
    }
    state
}

pub fn final_state<F: PrimeField>(
    journal: &[u8; V1_JOURNAL_BYTES],
    outpoints: &[u8; 32],
    curve: F,
) -> [F; STATE_ARITY] {
    let mut state = initial_state(journal);
    for (i, bytes) in outpoints.chunks_exact(16).enumerate() {
        state[JOURNAL_LIMBS + i] = F::from_u128(u128::from_be_bytes(bytes.try_into().unwrap()));
    }
    state[JOURNAL_LIMBS + 2] = curve;
    state
}

pub(crate) fn verified_bindings<F: PrimeFieldBits>(
    journal: &[u8; V1_JOURNAL_BYTES],
    output: &[F],
) -> Result<([u8; 32], F), &'static str> {
    if output.len() != STATE_ARITY
        || output[..JOURNAL_LIMBS] != initial_state::<F>(journal)[..JOURNAL_LIMBS]
    {
        return Err("authorization proof returned a different journal");
    }
    let mut outpoints = [0; 32];
    for (i, field) in output[JOURNAL_LIMBS..JOURNAL_LIMBS + 2].iter().enumerate() {
        let bits = field.to_le_bits();
        if bits[128..].iter().any(|bit| *bit) {
            return Err("authorization proof returned an oversized digest limb");
        }
        let limb = (0..128).fold(0u128, |value, bit| value | (u128::from(bits[bit]) << bit));
        outpoints[i * 16..(i + 1) * 16].copy_from_slice(&limb.to_be_bytes());
    }
    Ok((outpoints, output[JOURNAL_LIMBS + 2]))
}

impl<F: PrimeFieldBits> StepCircuit<F> for AuthorizationStep {
    fn arity(&self) -> usize {
        STATE_ARITY
    }

    fn synthesize<CS: ConstraintSystem<F>>(
        &self,
        cs: &mut CS,
        state: &[AllocatedNum<F>],
    ) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        if state.len() != STATE_ARITY || F::CAPACITY < 128 {
            return Err(SynthesisError::Unsatisfiable(
                "invalid authorization state".into(),
            ));
        }
        let mut journal = Vec::with_capacity(V1_JOURNAL_BYTES * 8);
        for (i, register) in state[..JOURNAL_LIMBS].iter().enumerate() {
            let width = ((V1_JOURNAL_BYTES - 16 * i).min(16)) * 8;
            journal.extend(unpack_bits(
                cs.namespace(|| format!("journal limb {i}")),
                register,
                width,
            )?);
        }

        let zero_summary = [0; V1_SUMMARY_BYTES];
        let zero_context = [0; V1_CONTEXT_BYTES];
        let zero_outcome = [0; V1_OUTCOME_BYTES];
        let zero_signature = [0; 64];
        let zero_siblings = [0; NULLIFIER_PATH_STEPS * 32];
        let dummy;
        let dummy_transaction;
        let (witness, transaction) = match self.witness.as_ref() {
            Some((bytes, transaction)) => (
                BatchWitness::decode(bytes)
                    .map_err(|error| SynthesisError::Unsatisfiable(error.into()))?,
                transaction.as_slice(),
            ),
            None => {
                dummy = (0..self.layout.row_count)
                    .map(|_| RowWitness {
                        summary: &zero_summary,
                        summary_signatures: [&zero_signature; 2],
                        outcome: &zero_outcome,
                        outcome_siblings: Vec::new(),
                        oracle_indices: [0, 1],
                        oracle_signatures: [&zero_signature; 2],
                        batch_signatures: [&zero_signature; 2],
                        nullifier_siblings: &zero_siblings,
                    })
                    .collect();
                dummy_transaction = vec![0; self.layout.transaction_bytes()];
                (
                    BatchWitness {
                        context: &zero_context,
                        rows: dummy,
                    },
                    dummy_transaction.as_slice(),
                )
            }
        };
        let result = constrain_linked_authorization(
            cs.namespace(|| "authorization"),
            &witness,
            transaction,
            &journal,
        )?;
        let mut output = state[..JOURNAL_LIMBS].to_vec();
        output.push(pack_limb(
            cs.namespace(|| "outpoint binding high"),
            &result.outpoints[..128],
        )?);
        output.push(pack_limb(
            cs.namespace(|| "outpoint binding low"),
            &result.outpoints[128..],
        )?);
        output.push(result.curve);
        Ok(output)
    }
}
