use ff::{Field, PrimeField};
use lnmarkets_nova::authorization::{
    constrain_linked_authorization,
    step::{self as authorization_step, AuthorizationLayout, AuthorizationStep},
};
use lnmarkets_nova::nullifier_batch::{self, BatchNullifierStep};
use lnmarkets_nova::secp256k1::fold::{self as curve_fold, CurveBinding, CurveEquation, CurveStep};
use lnmarkets_nova::settlement_amounts::SettlementAmountStep;
use lnmarkets_nova::witness::BatchWitness;
use nova_snark::{
    frontend::{
        num::AllocatedNum, util_cs::witness_cs::WitnessCS, Boolean, ConstraintSystem,
        SynthesisError,
    },
    nova::{CompressedSNARK, PublicParams, RecursiveSNARK},
    provider::{ipa_pc::EvaluationEngine, Bn256EngineIPA, GrumpkinEngine},
    spartan::snark::RelaxedR1CSSNARK,
    traits::{circuit::StepCircuit, snark::RelaxedR1CSSNARKTrait, Engine},
};

type E1 = Bn256EngineIPA;
type E2 = GrumpkinEngine;
type F = <E1 as Engine>::Scalar;
type S1 = RelaxedR1CSSNARK<E1, EvaluationEngine<E1>>;
type S2 = RelaxedR1CSSNARK<E2, EvaluationEngine<E2>>;
type Proof<C> = CompressedSNARK<E1, E2, C, S1, S2>;
const JOURNAL: &[u8; 276] = include_bytes!("../../evidence/sp1-two-trade-journal.bin");

#[derive(Clone, Debug)]
struct Multiply(F);

impl StepCircuit<F> for Multiply {
    fn arity(&self) -> usize {
        1
    }

    fn synthesize<CS: ConstraintSystem<F>>(
        &self,
        cs: &mut CS,
        z: &[AllocatedNum<F>],
    ) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        let factor = AllocatedNum::alloc(cs.namespace(|| "factor"), || Ok(self.0))?;
        Ok(vec![z[0].mul(cs.namespace(|| "product"), &factor)?])
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var_os("CUDA_VISIBLE_DEVICES")
        .is_some_and(|value| value.is_empty() || value == "-1")
    {
        return Err("CUDA_VISIBLE_DEVICES hides all CUDA devices".into());
    }
    match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => {
            let steps = [Multiply(F::from(3)), Multiply(F::from(7))];
            prove_and_check(&steps[0], &steps, &[F::ONE], &[F::from(21)])?;
            println!("Nova GPU smoke proof verified and altered public input rejected");
        }
        [mode] if mode == "--settlement-amounts" => {
            let steps = [
                SettlementAmountStep {
                    collateral: 401_330,
                    trader: 88_889,
                    maker: 311_111,
                    anchor: 330,
                    fee: 1_000,
                },
                SettlementAmountStep {
                    collateral: 401_330,
                    trader: 290_909,
                    maker: 109_091,
                    anchor: 330,
                    fee: 1_000,
                },
            ];
            let mut totals = [0u64; 3];
            for (total, field) in totals.iter_mut().zip(JOURNAL[252..276].chunks_exact(8)) {
                *total = u64::from_le_bytes(field.try_into().unwrap());
            }
            prove_and_check(&steps[0], &steps, &[F::ZERO; 3], &totals.map(F::from))?;
            println!("Nova GPU settlement-amount proof matches the saved journal totals and rejects altered public input");
        }
        [mode, fixture, files @ ..] if mode == "--nullifiers" && files.len() <= 2 => {
            let witness = std::fs::read(fixture)?;
            let journal = match files.first() {
                Some(path) => std::fs::read(path)?
                    .try_into()
                    .map_err(|_| "journal must be 276 bytes")?,
                None => *JOURNAL,
            };
            let (steps, binding) = nullifier_fixture(&witness, &journal)?;
            let old_root = journal[124..156].try_into()?;
            let new_root = journal[156..188].try_into()?;
            let proof = prove_and_check(
                &BatchNullifierStep::default(),
                &steps,
                &nullifier_batch::initial_state(&old_root),
                &nullifier_batch::final_state(&new_root, &binding),
            )?;
            write_proof(files.get(1), &proof)?;
            println!("Nova GPU nullifier proof matches both saved journal roots and rejects altered public input");
        }
        [mode, fixture, files @ ..] if mode == "--curve-equations" && files.len() <= 1 => {
            prove_fixture_curve(fixture, files.first())?;
        }
        [mode, fixture, files @ ..] if mode == "--authorization-body" && files.len() <= 1 => {
            prove_fixture_authorization(fixture, files.first())?;
        }
        [mode, fixture] if mode == "--inspect-bindings" => {
            let fixture = Fixture::read(fixture)?;
            let (_, curve, _) = fixture.bindings()?;
            let encoded = curve.to_repr();
            let hex = encoded.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            println!("curve binding {hex}");
        }
        _ => {
            return Err(
                "usage: gpu_smoke [--settlement-amounts | --nullifiers WITNESS [JOURNAL [PROOF]] | {--curve-equations | --authorization-body} FIXTURE_DIR [PROOF] | --inspect-bindings FIXTURE_DIR]".into(),
            )
        }
    }
    Ok(())
}

struct Fixture {
    witness: Vec<u8>,
    unsigned: Vec<u8>,
    journal: [u8; 276],
}

impl Fixture {
    fn read(fixture: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let path = std::path::Path::new(fixture);
        let journal: [u8; 276] = std::fs::read(path.join("expected-journal.bin"))?
            .try_into()
            .map_err(|_| "journal must be 276 bytes")?;
        if journal[..40] != JOURNAL[..40] {
            return Err("unsupported fixture journal domain".into());
        }
        Ok(Self {
            witness: std::fs::read(path.join("witness.bin"))?,
            unsigned: std::fs::read(path.join("unsigned-batch.bin"))?,
            journal,
        })
    }

    fn row_count(&self) -> usize {
        u32::from_le_bytes(self.journal[88..92].try_into().unwrap()) as usize
    }

    fn bindings(&self) -> Result<([u8; 32], F, Vec<CurveEquation>), Box<dyn std::error::Error>> {
        let batch = BatchWitness::decode(&self.witness)?;
        let journal_bits = self
            .journal
            .iter()
            .flat_map(|byte| {
                (0..8)
                    .rev()
                    .map(move |i| Boolean::constant(byte & (1 << i) != 0))
            })
            .collect::<Vec<_>>();
        let mut cs = WitnessCS::<F>::new();
        let outputs =
            constrain_linked_authorization(&mut cs, &batch, &self.unsigned, &journal_bits)?;
        let mut outpoints = [0; 32];
        for (i, bit) in outputs.outpoints.iter().enumerate() {
            let bit = bit.get_value().ok_or("missing outpoint binding")?;
            outpoints[i / 8] |= u8::from(bit) << (7 - i % 8);
        }
        Ok((
            outpoints,
            outputs.curve.get_value().ok_or("missing curve binding")?,
            outputs.curve_witness()?,
        ))
    }
}

fn prove_fixture_curve(
    fixture: &str,
    output: Option<&String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::read(fixture)?;
    let (_, constrained_binding, equations) = fixture.bindings()?;
    let binding = CurveBinding::<F>::default();
    let expected = equations
        .iter()
        .fold(F::ZERO, |prior, equation| binding.append(prior, equation));
    assert_eq!(constrained_binding, expected);
    let steps = CurveStep::for_equations(binding, &equations);
    assert_eq!(
        curve_fold::step_count(fixture.row_count()),
        Some(steps.len())
    );
    println!("Proving {} private curve equations", equations.len());
    let proof = prove_and_check(
        &CurveStep::blank(),
        &steps,
        &curve_fold::initial_state(),
        &curve_fold::final_state(expected),
    )?;
    write_proof(output, &proof)?;
    println!("Nova GPU curve proof matches the fixture's ordered equation binding and rejects altered public input");
    Ok(())
}

fn prove_fixture_authorization(
    fixture: &str,
    output: Option<&String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::read(fixture)?;
    let (outpoints, curve, _) = fixture.bindings()?;
    let layout =
        AuthorizationLayout::from_transaction_size(fixture.row_count(), fixture.unsigned.len())?;
    let step = AuthorizationStep::with_witness(layout, fixture.witness, fixture.unsigned)?;
    let proof = prove_and_check(
        &AuthorizationStep::blank(layout),
        &[step],
        &authorization_step::initial_state(&fixture.journal),
        &authorization_step::final_state(&fixture.journal, &outpoints, curve),
    )?;
    write_proof(output, &proof)?;
    println!("Nova GPU authorization proof matched the journal and both proof bindings");
    Ok(())
}

fn write_proof<C: StepCircuit<F>>(
    output: Option<&String>,
    proof: &Proof<C>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(output) = output {
        let bytes = bincode::serde::encode_to_vec(proof, bincode::config::standard())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        std::io::Write::write_all(&mut file, &bytes)?;
        println!("Saved {} bytes of compressed proof", bytes.len());
    }
    Ok(())
}
fn nullifier_fixture(
    bytes: &[u8],
    journal: &[u8; 276],
) -> Result<(Vec<BatchNullifierStep>, [u8; 32]), Box<dyn std::error::Error>> {
    let batch = BatchWitness::decode(bytes)?;
    if journal[..40] != JOURNAL[..40]
        || batch.context[..48] != journal[40..88]
        || batch.context[48..176] != journal[92..220]
        || batch.context[176..] != journal[88..92]
    {
        return Err("v1 witness context differs from the retained fixture journal".into());
    }
    let count = nullifier_batch::step_count(batch.rows.len()).ok_or("invalid row count")?;
    let mut steps = Vec::with_capacity(count);
    let mut binding = [0u8; 32];
    for row in &batch.rows {
        let start = BatchNullifierStep {
            salt: row.summary[..32].try_into()?,
            txid: row.summary[128..160].try_into()?,
            vout: u32::from_le_bytes(row.summary[160..164].try_into()?),
            ..Default::default()
        };
        binding = start.extend_row_binding(&binding);
        for (level, sibling) in row.nullifier_siblings.chunks_exact(32).enumerate() {
            let mut step = if level == 0 {
                start.clone()
            } else {
                BatchNullifierStep::default()
            };
            step.sibling = sibling.try_into()?;
            steps.push(step);
        }
    }
    Ok((steps, binding))
}

fn prove_and_check<C: StepCircuit<F>>(
    public_circuit: &C,
    steps: &[C],
    initial: &[F],
    expected: &[F],
) -> Result<Proof<C>, Box<dyn std::error::Error>> {
    let started = std::time::Instant::now();
    eprintln!("Preparing Nova parameters");
    let pp = PublicParams::<E1, E2, C>::setup(public_circuit, &*S1::ck_floor(), &*S2::ck_floor())?;
    let (primary, secondary) = pp.num_constraints();
    eprintln!("Nova step constraints {primary} primary and {secondary} secondary");
    eprintln!("Creating the first Nova instance");
    let mut folded = RecursiveSNARK::new(&pp, &steps[0], initial)?;
    for (index, step) in steps.iter().enumerate() {
        folded.prove_step(&pp, step)?;
        let done = index + 1;
        if done <= 2 || done % 16 == 0 || done == steps.len() {
            eprintln!(
                "Completed fold {done}/{} after {:.1}s",
                steps.len(),
                started.elapsed().as_secs_f64()
            );
        }
    }
    assert_eq!(folded.verify(&pp, steps.len(), initial)?, expected);
    eprintln!(
        "Preparing Spartan IPA compression keys after {:.1}s",
        started.elapsed().as_secs_f64()
    );
    let (pk, vk) = CompressedSNARK::<_, _, _, S1, S2>::setup(&pp)?;
    eprintln!(
        "Compressing the fold after {:.1}s",
        started.elapsed().as_secs_f64()
    );
    let compressed = CompressedSNARK::prove(&pp, &pk, &folded)?;
    eprintln!(
        "Checking the compressed proof after {:.1}s",
        started.elapsed().as_secs_f64()
    );
    assert_eq!(compressed.verify(&vk, steps.len(), initial)?, expected);
    let mut altered = initial.to_vec();
    altered[0] += F::ONE;
    assert!(compressed.verify(&vk, steps.len(), &altered).is_err());
    Ok(compressed)
}
