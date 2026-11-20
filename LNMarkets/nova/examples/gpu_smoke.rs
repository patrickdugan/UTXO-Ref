use ff::Field;
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
    let steps = [Multiply(F::from(3)), Multiply(F::from(7))];
    let initial = [F::ONE];
    let expected = [F::from(21)];
    eprintln!("Preparing Nova parameters");
    let pp =
        PublicParams::<E1, E2, Multiply>::setup(&steps[0], &*S1::ck_floor(), &*S2::ck_floor())?;
    eprintln!("Creating the first Nova instance");
    let mut folded = RecursiveSNARK::new(&pp, &steps[0], &initial)?;
    for (index, step) in steps.iter().enumerate() {
        folded.prove_step(&pp, step)?;
        eprintln!("Completed fold {}", index + 1);
    }
    assert_eq!(folded.verify(&pp, steps.len(), &initial)?, expected);
    eprintln!("Compressing the fold with Spartan IPA");
    let (pk, vk) = CompressedSNARK::<_, _, _, S1, S2>::setup(&pp)?;
    let compressed = CompressedSNARK::prove(&pp, &pk, &folded)?;
    assert_eq!(compressed.verify(&vk, steps.len(), &initial)?, expected);
    assert!(compressed.verify(&vk, steps.len(), &[F::from(2)]).is_err());
    println!("Nova GPU smoke proof verified and altered public input rejected");
    Ok(())
}
