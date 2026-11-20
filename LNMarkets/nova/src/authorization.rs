//! Compose the exact v1 authorization statement with shared private wire bits.

pub mod step;

use ff::PrimeFieldBits;
use nova_snark::frontend::{num::AllocatedNum, Boolean, ConstraintSystem, SynthesisError};

use crate::accepted_set::verify_accepted_set;
use crate::bip340::{signature_transcript, verify_signature, SCALAR_ORDER};
use crate::journal_binding::{bind_batch_journal, V1_JOURNAL_BYTES};
use crate::nullifier::DigestBits;
use crate::nullifier_batch::bind_summary_outpoints;
use crate::outcome_membership::{verify_selected_outcome, OUTCOME_TREE_LEVELS};
use crate::secp256k1::fold::{CurveBinding, CurveEquation, EquationBits};
use crate::secp256k1::Secp256k1;
use crate::settlement_amounts::{apply_row, RowAmountBits, Totals};
use crate::signing_digests::row_signing_digests;
use crate::summary_policy::{enforce_summary_policy, select_oracle_keys};
use crate::taproot_funding::{funding_tweak, nums_bits, verify_funding_script};
use crate::transaction_binding::{bind_unsigned_settlement, SettlementRowBits};
use crate::wire::{allocate_bytes, constants};
use crate::witness::{BatchWitness, RowWitness};
use crate::MAX_BATCH_ROWS;

pub struct AuthorizationBindings<F: PrimeFieldBits> {
    pub outpoints: DigestBits,
    pub curve: AllocatedNum<F>,
    equations: Vec<EquationBits>,
}

impl<F: PrimeFieldBits> AuthorizationBindings<F> {
    /// Extract private prover inputs from the same transcript synthesis.
    pub fn curve_witness(&self) -> Result<Vec<CurveEquation>, SynthesisError> {
        self.equations.iter().map(EquationBits::witness).collect()
    }
}

/// Constrain the journal, accepted set, payouts and signing transcripts.
/// A batch verifier also checks proofs of both returned bindings.
pub fn constrain_linked_authorization<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
    witness: &BatchWitness<'_>,
    unsigned: &[u8],
    journal: &[Boolean],
) -> Result<AuthorizationBindings<F>, SynthesisError> {
    let mut equations = Vec::new();
    let outpoints = constrain_batch(
        cs.namespace(|| "authorization body"),
        witness,
        unsigned,
        journal,
        Some(&mut equations),
    )?;
    let hash = CurveBinding::default();
    let mut curve = allocate_zero(cs.namespace(|| "initial curve binding"))?;
    for (i, equation) in equations.iter().enumerate() {
        curve = hash.append_constrained(
            cs.namespace(|| format!("curve equation {i}")),
            &curve,
            equation,
        )?;
    }
    Ok(AuthorizationBindings {
        outpoints,
        curve,
        equations,
    })
}

/// Constrain all signed rows against independently supplied public journal
/// bits. The caller must prove this relation and require the same returned
/// ordered outpoint digest in the verified nullifier transition.
pub fn constrain_authorization<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    cs: CS,
    witness: &BatchWitness<'_>,
    unsigned: &[u8],
    journal: &[Boolean],
) -> Result<DigestBits, SynthesisError> {
    constrain_batch(cs, witness, unsigned, journal, None)
}

fn constrain_batch<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
    witness: &BatchWitness<'_>,
    unsigned: &[u8],
    journal: &[Boolean],
    mut equations: Option<&mut Vec<EquationBits>>,
) -> Result<DigestBits, SynthesisError> {
    if journal.len() != V1_JOURNAL_BYTES * 8 || !(1..=MAX_BATCH_ROWS).contains(&witness.rows.len())
    {
        return Err(SynthesisError::Unsatisfiable(
            "invalid batch dimensions".into(),
        ));
    }
    let context = allocate_bytes(cs.namespace(|| "batch context"), witness.context)?;
    let tx = allocate_bytes(cs.namespace(|| "unsigned settlement"), unsigned)?;
    let mut totals = zero_totals(cs.namespace(|| "initial totals"))?;
    let curve = Secp256k1::new::<CS>()?;
    let mut rows = Vec::with_capacity(witness.rows.len());
    let mut accepted = Vec::with_capacity(witness.rows.len());
    for (i, row) in witness.rows.iter().enumerate() {
        let mut ns = cs.namespace(|| format!("trade {i}"));
        let summary = allocate_bytes(ns.namespace(|| "summary"), row.summary)?;
        let outcome = allocate_bytes(ns.namespace(|| "selected outcome"), row.outcome)?;
        accepted.push(constrain_row(
            ns.namespace(|| "authorization"),
            &curve,
            &context,
            row,
            &summary,
            &outcome,
            equations.as_deref_mut(),
        )?);
        let amounts = RowAmountBits::from_v1_wire(&summary, &outcome)?;
        totals = apply_row(
            &mut ns.namespace(|| "amount conservation"),
            &totals,
            &amounts,
        )?;
        rows.push((summary, outcome));
    }

    let summaries = rows
        .iter()
        .map(|(summary, _)| summary.as_slice())
        .collect::<Vec<_>>();
    enforce_summary_policy(cs.namespace(|| "summary policy"), &context, &summaries)?;
    verify_accepted_set(cs.namespace(|| "accepted set root"), &context, &accepted)?;
    let settlement_rows = rows
        .iter()
        .map(|(summary, outcome)| SettlementRowBits { summary, outcome })
        .collect::<Vec<_>>();
    let txid = std::array::from_fn(|i| journal[220 * 8 + i].clone());
    bind_unsigned_settlement(
        cs.namespace(|| "committed Bitcoin transaction"),
        &context,
        &settlement_rows,
        &tx,
        &txid,
    )?;
    bind_batch_journal(
        cs.namespace(|| "retained journal"),
        &context,
        journal,
        &txid,
        &totals,
    )?;
    bind_summary_outpoints(cs.namespace(|| "nullifier proof binding"), &summaries)
}

fn constrain_row<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
    curve: &Secp256k1<F>,
    context: &[Boolean],
    row: &RowWitness<'_>,
    summary: &[Boolean],
    outcome: &[Boolean],
    mut equations: Option<&mut Vec<EquationBits>>,
) -> Result<DigestBits, SynthesisError> {
    if row.outcome_siblings.len() > OUTCOME_TREE_LEVELS {
        return Err(SynthesisError::Unsatisfiable(
            "invalid outcome path length".into(),
        ));
    }
    let zero = [0; 32];
    let siblings = (0..OUTCOME_TREE_LEVELS)
        .map(|i| {
            let sibling = row.outcome_siblings.get(i).copied().unwrap_or(&zero);
            allocate_bytes(cs.namespace(|| format!("outcome sibling {i}")), sibling)
                .map(|bits| bits.try_into().unwrap())
        })
        .collect::<Result<Vec<_>, _>>()?
        .try_into()
        .unwrap();
    verify_selected_outcome(
        cs.namespace(|| "selected outcome membership"),
        summary,
        outcome,
        &siblings,
    )?;

    let messages = row_signing_digests(
        cs.namespace(|| "signing messages"),
        context,
        summary,
        outcome,
    )?;
    let get_key =
        |byte: usize| -> DigestBits { std::array::from_fn(|i| summary[byte * 8 + i].clone()) };
    let trader = get_key(206);
    let maker = get_key(238);
    let salt = get_key(0);
    let csv = std::array::from_fn(|i| summary[544 * 8 + i].clone());
    if let Some(equations) = equations.as_deref_mut() {
        let tweak = funding_tweak(cs.namespace(|| "funding tweak"), &trader, &maker, &csv)?;
        let mut n_minus_one = SCALAR_ORDER;
        n_minus_one[31] -= 1;
        equations.push(EquationBits {
            salt: salt.clone(),
            key: nums_bits(),
            s: tweak,
            // NUMS + tG equals tG - (n - 1)NUMS.
            e: constants(&n_minus_one).try_into().unwrap(),
            result_x: get_key(174),
            even_y: Boolean::constant(false),
        });
    } else {
        let funding = std::array::from_fn(|i| summary[172 * 8 + i].clone());
        verify_funding_script(
            cs.namespace(|| "funding commitment"),
            curve,
            &trader,
            &maker,
            &csv,
            &funding,
        )?;
    }

    for (role, offset) in [
        ("trader payout", 272),
        ("maker payout", 306),
        ("anchor payout", 340),
        ("oracle one", 372),
        ("oracle two", 404),
        ("oracle three", 436),
    ] {
        curve.lift_x(
            cs.namespace(|| format!("validate {role} key")),
            &get_key(offset),
        )?;
    }
    let indices = allocate_bytes(
        cs.namespace(|| "selected oracle indices"),
        &row.oracle_indices,
    )?;
    let indices = std::array::from_fn(|i| std::array::from_fn(|j| indices[i * 8 + j].clone()));
    let oracles = select_oracle_keys(
        cs.namespace(|| "select two pinned oracle keys"),
        summary,
        &indices,
    )?;
    for (name, key, message, signature) in [
        (
            "trader summary",
            &trader,
            &messages.summary,
            row.summary_signatures[0],
        ),
        (
            "maker summary",
            &maker,
            &messages.summary,
            row.summary_signatures[1],
        ),
        (
            "first oracle",
            &oracles[0],
            &messages.oracle,
            row.oracle_signatures[0],
        ),
        (
            "second oracle",
            &oracles[1],
            &messages.oracle,
            row.oracle_signatures[1],
        ),
        (
            "trader batch consent",
            &trader,
            &messages.consent,
            row.batch_signatures[0],
        ),
        (
            "maker batch consent",
            &maker,
            &messages.consent,
            row.batch_signatures[1],
        ),
    ] {
        let mut sig_ns = cs.namespace(|| name);
        let signature = allocate_bytes(sig_ns.namespace(|| "signature bytes"), signature)?
            .try_into()
            .unwrap();
        if let Some(equations) = equations.as_deref_mut() {
            let signed = signature_transcript(
                sig_ns.namespace(|| "BIP340 transcript"),
                key,
                message,
                &signature,
            )?;
            equations.push(EquationBits {
                salt: salt.clone(),
                key: key.clone(),
                s: signed.s,
                e: signed.e,
                result_x: signed.r,
                even_y: Boolean::constant(true),
            });
        } else {
            verify_signature(
                sig_ns.namespace(|| "BIP340 check"),
                curve,
                key,
                message,
                &signature,
            )?;
        }
    }
    Ok(messages.summary)
}

fn zero_totals<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
) -> Result<Totals<F>, SynthesisError> {
    let mut totals = Vec::with_capacity(3);
    for i in 0..3 {
        totals.push(allocate_zero(
            cs.namespace(|| format!("initial total {i}")),
        )?);
    }
    Ok(totals.try_into().unwrap())
}

fn allocate_zero<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
) -> Result<AllocatedNum<F>, SynthesisError> {
    let zero = AllocatedNum::alloc(cs.namespace(|| "zero"), || Ok(F::ZERO))?;
    cs.enforce(
        || "equals zero",
        |lc| lc + zero.get_variable(),
        |lc| lc + CS::one(),
        |lc| lc,
    );
    Ok(zero)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nullifier_batch::BatchNullifierStep;
    use crate::wire::{
        constants, enforce_same_bits,
        fixture::{allocated, step_shape, ConstraintCheck, F},
    };
    use ff::Field;
    use nova_snark::traits::circuit::StepCircuit;

    #[test]
    #[ignore = "requires a native-verified batch-demo fixture directory"]
    fn native_fixture_binds_every_row_and_rejects_an_oracle_signature_change() {
        let fixture = std::path::PathBuf::from(
            std::env::var_os("LNM_BATCH_FIXTURE").expect("LNM_BATCH_FIXTURE"),
        );
        let bytes = std::fs::read(fixture.join("witness.bin")).unwrap();
        let journal = std::fs::read(fixture.join("expected-journal.bin")).unwrap();
        let transaction = std::fs::read(fixture.join("unsigned-batch.bin")).unwrap();
        let mut witness = BatchWitness::decode(&bytes).unwrap();
        assert_eq!(witness.rows.len(), 2);
        assert!(BatchWitness::decode(&bytes[..bytes.len() - 1]).is_err());
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(BatchWitness::decode(&trailing).is_err());

        let binding = witness.rows.iter().fold([0; 32], |prior, row| {
            BatchNullifierStep {
                salt: row.summary[..32].try_into().unwrap(),
                txid: row.summary[128..160].try_into().unwrap(),
                vout: u32::from_le_bytes(row.summary[160..164].try_into().unwrap()),
                ..Default::default()
            }
            .extend_row_binding(&prior)
        });
        let run = |witness: &BatchWitness<'_>| {
            let mut cs = ConstraintCheck::new();
            let journal = allocated(cs.namespace(|| "retained journal"), &journal);
            let digest = constrain_authorization(
                cs.namespace(|| "batch authorization"),
                witness,
                &transaction,
                &journal,
            )
            .unwrap();
            enforce_same_bits(
                cs.namespace(|| "same binding as the nullifier proof"),
                &digest,
                &constants(&binding),
            )
            .unwrap();
            cs.first_failure
        };
        assert_eq!(run(&witness), None);
        let linked = |witness: &BatchWitness<'_>| {
            let mut cs = ConstraintCheck::new();
            let retained = allocated(cs.namespace(|| "retained journal"), &journal);
            let outputs = constrain_linked_authorization(
                cs.namespace(|| "linked authorization body"),
                witness,
                &transaction,
                &retained,
            )
            .unwrap();
            enforce_same_bits(
                cs.namespace(|| "same nullifier binding"),
                &outputs.outpoints,
                &constants(&binding),
            )
            .unwrap();
            let equations = outputs.curve_witness().unwrap();
            assert_eq!(equations.len(), 14);
            assert!(equations
                .iter()
                .enumerate()
                .all(|(i, equation)| equation.even_y == (i % 7 != 0)));
            let hash = CurveBinding::default();
            let expected = equations
                .iter()
                .fold(F::ZERO, |prior, equation| hash.append(prior, equation));
            assert_eq!(outputs.curve.get_value(), Some(expected));
            assert_eq!(cs.first_failure, None);
            expected
        };
        let curve_binding = linked(&witness);
        let layout =
            step::AuthorizationLayout::from_transaction_size(2, transaction.len()).unwrap();
        let step =
            step::AuthorizationStep::with_witness(layout, bytes.clone(), transaction.clone())
                .unwrap();
        let (setup_constraints, setup_shape) = step_shape(&step::AuthorizationStep::blank(layout));
        assert_eq!(step_shape(&step), (setup_constraints, setup_shape));
        let retained: &[u8; V1_JOURNAL_BYTES] = journal.as_slice().try_into().unwrap();
        let mut cs = ConstraintCheck::new();
        let state = step::initial_state::<F>(retained)
            .into_iter()
            .map(|value| {
                AllocatedNum::alloc(cs.namespace(|| "public state register"), || Ok(value)).unwrap()
            })
            .collect::<Vec<_>>();
        let output = step.synthesize(&mut cs, &state).unwrap();
        assert_eq!(cs.first_failure, None);
        assert_eq!(cs.constraints, setup_constraints);
        println!(
            "Two-trade authorization step uses {} constraints before the Nova wrapper",
            cs.constraints
        );
        assert!(output
            .iter()
            .zip(step::final_state(retained, &binding, curve_binding))
            .all(|(actual, expected)| actual.get_value() == Some(expected)));
        drop(cs);

        let mut changed = *witness.rows[1].oracle_signatures[1];
        changed[63] ^= 1;
        witness.rows[1].oracle_signatures[1] = &changed;
        assert!(run(&witness).is_some());
        assert_ne!(linked(&witness), curve_binding);
    }
}
