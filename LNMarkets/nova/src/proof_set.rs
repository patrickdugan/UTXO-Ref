//! Verify the compressed Nova artifacts against independently retained terms.

use nova_snark::{
    nova::{CompressedSNARK, PublicParams},
    provider::{ipa_pc::EvaluationEngine, Bn256EngineIPA, GrumpkinEngine},
    spartan::snark::RelaxedR1CSSNARK,
    traits::{circuit::StepCircuit, snark::RelaxedR1CSSNARKTrait, Engine},
};

use crate::authorization::step::{self, AuthorizationLayout, AuthorizationStep};
use crate::journal_binding::{statement_prefix, V1_JOURNAL_BYTES};
use crate::nullifier_batch::{self, BatchNullifierStep};
use crate::secp256k1::fold::{self as curve_fold, CurveStep};

type E1 = Bn256EngineIPA;
type E2 = GrumpkinEngine;
pub type BatchScalar = <E1 as Engine>::Scalar;
type S1 = RelaxedR1CSSNARK<E1, EvaluationEngine<E1>>;
type S2 = RelaxedR1CSSNARK<E2, EvaluationEngine<E2>>;
type Proof<C> = CompressedSNARK<E1, E2, C, S1, S2>;
type VerifyError = Box<dyn std::error::Error>;

pub const MAX_PROOF_BYTES: usize = 64 * 1024 * 1024;

pub struct BatchProofs<'a> {
    pub authorization: &'a [u8],
    pub curve: &'a [u8],
    pub nullifier: &'a [u8],
}

/// Verify the three compressed artifacts. The retained journal and the
/// output count are supplied by the verifier's approval policy. Derive
/// the fixed parameter sets locally without reading any private witness.
pub fn verify_batch_proofs(
    journal: &[u8; V1_JOURNAL_BYTES],
    output_count: usize,
    proofs: BatchProofs<'_>,
) -> Result<(), VerifyError> {
    if journal[..40] != statement_prefix() {
        return Err("unsupported batch journal domain".into());
    }
    let row_count = u32::from_le_bytes(journal[88..92].try_into()?) as usize;
    let layout = AuthorizationLayout::new(row_count, output_count)?;
    let authorization = decode::<AuthorizationStep>(proofs.authorization)?;
    let curve = decode::<CurveStep<BatchScalar>>(proofs.curve)?;
    let nullifier = decode::<BatchNullifierStep>(proofs.nullifier)?;

    // Reject invalid component proofs before building the much larger
    // authorization parameters. Only compare verified public outputs.
    let curve_state = verify_curve(&curve, row_count)?;
    let old_root = journal[124..156].try_into()?;
    let new_root = journal[156..188].try_into()?;
    let count = nullifier_batch::step_count(row_count).ok_or("invalid nullifier row count")?;
    let nullifier_state = verify_step(
        &BatchNullifierStep::default(),
        &nullifier,
        count,
        &nullifier_batch::initial_state(&old_root),
    )?;
    let state = verify_step(
        &AuthorizationStep::blank(layout),
        &authorization,
        1,
        &step::initial_state(journal),
    )?;
    let (bound_outpoints, bound_curve) = step::verified_bindings(journal, &state)?;
    check_curve_binding(&curve_state, bound_curve)?;
    if nullifier_state != nullifier_batch::final_state(&new_root, &bound_outpoints) {
        return Err("nullifier proof did not match the approved roots and signed outpoints".into());
    }
    Ok(())
}

/// Verify only the curve component against a binding already supplied by
/// the caller. Batch acceptance uses `verify_batch_proofs`.
pub fn verify_curve_proof(
    bytes: &[u8],
    row_count: usize,
    binding: BatchScalar,
) -> Result<(), VerifyError> {
    let proof = decode::<CurveStep<BatchScalar>>(bytes)?;
    check_curve_binding(&verify_curve(&proof, row_count)?, binding)
}

fn verify_curve(
    proof: &Proof<CurveStep<BatchScalar>>,
    row_count: usize,
) -> Result<Vec<BatchScalar>, VerifyError> {
    let count = curve_fold::step_count(row_count).ok_or("invalid curve proof row count")?;
    verify_step(
        &CurveStep::blank(),
        proof,
        count,
        &curve_fold::initial_state(),
    )
}

fn check_curve_binding(actual: &[BatchScalar], binding: BatchScalar) -> Result<(), VerifyError> {
    if actual != curve_fold::final_state(binding) {
        return Err("curve proof did not match the signed operation binding".into());
    }
    Ok(())
}

fn decode<C: StepCircuit<BatchScalar>>(bytes: &[u8]) -> Result<Proof<C>, VerifyError> {
    if bytes.is_empty() || bytes.len() > MAX_PROOF_BYTES {
        return Err("invalid compressed Nova artifact size".into());
    }
    let config = bincode::config::standard().with_limit::<MAX_PROOF_BYTES>();
    let (proof, consumed) = bincode::serde::decode_from_slice(bytes, config)?;
    if consumed != bytes.len() {
        return Err("trailing bytes in compressed Nova artifact".into());
    }
    Ok(proof)
}

fn verify_step<C: StepCircuit<BatchScalar>>(
    circuit: &C,
    proof: &Proof<C>,
    steps: usize,
    initial: &[BatchScalar],
) -> Result<Vec<BatchScalar>, VerifyError> {
    let params = PublicParams::<E1, E2, C>::setup(circuit, &*S1::ck_floor(), &*S2::ck_floor())?;
    let (_, verifier) = Proof::<C>::setup(&params)?;
    drop(params);
    Ok(proof.verify(&verifier, steps, initial)?)
}
