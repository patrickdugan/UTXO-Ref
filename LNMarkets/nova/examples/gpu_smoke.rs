use ff::Field;
use lnmarkets_nova::settlement_amounts::SettlementAmountStep;
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
            let journal = include_bytes!("../../evidence/sp1-two-trade-journal.bin");
            let mut totals = [0u64; 3];
            for (total, field) in totals.iter_mut().zip(journal[252..276].chunks_exact(8)) {
                *total = u64::from_le_bytes(field.try_into().unwrap());
            }
            prove_and_check(&steps, &[F::ZERO; 3], &totals.map(F::from))?;
            println!("Nova GPU settlement-amount proof matches the saved journal totals and rejects altered public input");
        }
        _ => return Err("usage: gpu_smoke [--settlement-amounts]".into()),
    }
    Ok(())
}

fn prove_and_check<C: StepCircuit<F>>(
    steps: &[C],
    initial: &[F],
    expected: &[F],
) -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("Preparing Nova parameters");
    let pp = PublicParams::<E1, E2, C>::setup(&steps[0], &*S1::ck_floor(), &*S2::ck_floor())?;
    eprintln!("Creating the first Nova instance");
    let mut folded = RecursiveSNARK::new(&pp, &steps[0], initial)?;
    for (index, step) in steps.iter().enumerate() {
        folded.prove_step(&pp, step)?;
        eprintln!("Completed fold {}", index + 1);
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
