use ff::PrimeField;
use nova_snark::frontend::{AllocatedBit, Boolean, ConstraintSystem, SynthesisError};

use crate::nullifier::bits;

/// Wire bytes are represented with the most significant bit first in each byte.
pub(crate) fn constants(bytes: &[u8]) -> Vec<Boolean> {
    bits(bytes).map(Boolean::constant).collect()
}

pub(crate) fn allocate_bytes<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    bytes: &[u8],
) -> Result<Vec<Boolean>, SynthesisError> {
    bits(bytes)
        .enumerate()
        .map(|(i, value)| {
            AllocatedBit::alloc(cs.namespace(|| format!("wire bit {i}")), Some(value))
                .map(Boolean::from)
        })
        .collect()
}

pub(crate) fn enforce_same_bits<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    actual: &[Boolean],
    expected: &[Boolean],
) -> Result<(), SynthesisError> {
    if actual.len() != expected.len() {
        return Err(SynthesisError::Unsatisfiable(
            "wire bit length mismatch".into(),
        ));
    }
    for (i, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        Boolean::enforce_equal(cs.namespace(|| format!("bit {i}")), actual, expected)?;
    }
    Ok(())
}

pub(crate) fn less_than_le<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    left: &[Boolean],
    right: &[Boolean],
) -> Result<Boolean, SynthesisError> {
    if left.len() != right.len() {
        return Err(SynthesisError::Unsatisfiable(
            "comparison bit length mismatch".into(),
        ));
    }
    let mut less = Boolean::constant(false);
    // A more significant differing bit overrides the lower-bit comparison.
    for (i, (a, b)) in left.iter().zip(right).enumerate() {
        let mut ns = cs.namespace(|| format!("compare bit {i}"));
        let different = Boolean::xor(ns.namespace(|| "different"), a, b)?;
        less = Boolean::sha256_ch(
            ns.namespace(|| "take significant bit"),
            &different,
            b,
            &less,
        )?;
    }
    Ok(less)
}

pub(crate) fn require_nonzero<F: PrimeField, CS: ConstraintSystem<F>>(
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
pub(crate) mod fixture {
    use super::*;
    use nova_snark::{
        frontend::{Index, LinearCombination, Variable},
        provider::Bn256EngineIPA,
        traits::Engine,
    };

    pub(crate) type F = <Bn256EngineIPA as Engine>::Scalar;
    pub(crate) const JOURNAL: &[u8; 276] =
        include_bytes!("../../evidence/sp1-two-trade-journal.bin");

    pub(crate) fn saved_context() -> [u8; 180] {
        let mut context = [0u8; 180];
        context[..48].copy_from_slice(&JOURNAL[40..88]);
        context[48..176].copy_from_slice(&JOURNAL[92..220]);
        context[176..].copy_from_slice(&JOURNAL[88..92]);
        context
    }

    pub(crate) fn decode<const N: usize>(hex: &str) -> [u8; N] {
        assert_eq!(hex.len(), N * 2);
        std::array::from_fn(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
    }

    pub(crate) fn allocated<CS: ConstraintSystem<F>>(cs: CS, bytes: &[u8]) -> Vec<Boolean> {
        allocate_bytes(cs, bytes).unwrap()
    }

    /// Evaluate every constraint while retaining only the assignments.
    /// Useful for multi-million-constraint group arithmetic fixtures.
    pub(crate) struct ConstraintCheck {
        inputs: Vec<F>,
        witness: Vec<F>,
        pub(crate) first_failure: Option<String>,
    }

    impl ConstraintSystem<F> for ConstraintCheck {
        type Root = Self;

        fn new() -> Self {
            Self {
                inputs: vec![F::from(1)],
                witness: Vec::new(),
                first_failure: None,
            }
        }

        fn alloc<C, A, AR>(&mut self, _name: A, witness: C) -> Result<Variable, SynthesisError>
        where
            C: FnOnce() -> Result<F, SynthesisError>,
            A: FnOnce() -> AR,
            AR: Into<String>,
        {
            let index = self.witness.len();
            self.witness.push(witness()?);
            Ok(Variable::new_unchecked(Index::Aux(index)))
        }

        fn alloc_input<C, A, AR>(
            &mut self,
            _name: A,
            witness: C,
        ) -> Result<Variable, SynthesisError>
        where
            C: FnOnce() -> Result<F, SynthesisError>,
            A: FnOnce() -> AR,
            AR: Into<String>,
        {
            let index = self.inputs.len();
            self.inputs.push(witness()?);
            Ok(Variable::new_unchecked(Index::Input(index)))
        }

        fn enforce<A, AR, LA, LB, LC>(&mut self, name: A, a: LA, b: LB, c: LC)
        where
            A: FnOnce() -> AR,
            AR: Into<String>,
            LA: FnOnce(LinearCombination<F>) -> LinearCombination<F>,
            LB: FnOnce(LinearCombination<F>) -> LinearCombination<F>,
            LC: FnOnce(LinearCombination<F>) -> LinearCombination<F>,
        {
            let a = a(LinearCombination::zero()).eval(&self.inputs, &self.witness);
            let b = b(LinearCombination::zero()).eval(&self.inputs, &self.witness);
            let c = c(LinearCombination::zero()).eval(&self.inputs, &self.witness);
            if a * b != c && self.first_failure.is_none() {
                self.first_failure = Some(name().into());
            }
        }

        fn push_namespace<NR, N>(&mut self, _name: N)
        where
            NR: Into<String>,
            N: FnOnce() -> NR,
        {
        }
        fn pop_namespace(&mut self) {}
        fn get_root(&mut self) -> &mut Self {
            self
        }
    }
}
