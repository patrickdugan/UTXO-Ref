use ff::Field;
use lnmarkets_nova::nullifier_batch::{self, BatchNullifierStep};
use lnmarkets_nova::settlement_amounts::SettlementAmountStep;
use lnmarkets_nova::witness::BatchWitness;
use nova_snark::{
    frontend::{num::AllocatedNum, ConstraintSystem, SynthesisError},
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
            prove_and_check(&steps, &[F::ONE], &[F::from(21)])?;
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
            prove_and_check(&steps, &[F::ZERO; 3], &totals.map(F::from))?;
            println!("Nova GPU settlement-amount proof matches the saved journal totals and rejects altered public input");
        }
        [mode, fixture, journal_path @ ..] if mode == "--nullifiers" && journal_path.len() <= 1 => {
            let witness = std::fs::read(fixture)?;
            let journal = match journal_path.first() {
                Some(path) => std::fs::read(path)?
                    .try_into()
                    .map_err(|_| "journal must be 276 bytes")?,
                None => *JOURNAL,
            };
            let (steps, binding) = nullifier_fixture(&witness, &journal)?;
            let old_root = journal[124..156].try_into()?;
            let new_root = journal[156..188].try_into()?;
            prove_and_check(
                &steps,
                &nullifier_batch::initial_state(&old_root),
                &nullifier_batch::final_state(&new_root, &binding),
            )?;
            println!("Nova GPU nullifier proof matches both saved journal roots and rejects altered public input");
        }
        _ => {
            return Err(
                "usage: gpu_smoke [--settlement-amounts | --nullifiers WITNESS [JOURNAL]]".into(),
            )
        }
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
    steps: &[C],
    initial: &[F],
    expected: &[F],
) -> Result<(), Box<dyn std::error::Error>> {
    let started = std::time::Instant::now();
    eprintln!("Preparing Nova parameters");
    let pp = PublicParams::<E1, E2, C>::setup(&steps[0], &*S1::ck_floor(), &*S2::ck_floor())?;
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
    eprintln!("Compressing the fold with Spartan IPA");
    let (pk, vk) = CompressedSNARK::<_, _, _, S1, S2>::setup(&pp)?;
    let compressed = CompressedSNARK::prove(&pp, &pk, &folded)?;
    assert_eq!(compressed.verify(&vk, steps.len(), initial)?, expected);
    let mut altered = initial.to_vec();
    altered[0] += F::ONE;
    assert!(compressed.verify(&vk, steps.len(), &altered).is_err());
    Ok(())
}
