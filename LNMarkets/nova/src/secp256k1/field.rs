use ff::{Field, PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{
        num::AllocatedNum, AllocatedBit, Boolean, ConstraintSystem, LinearCombination,
        SynthesisError,
    },
    gadgets::nonnative::bignat::{nat_to_limbs, BigNat, BigNatParams},
    provider::secp_secq::secp256k1::Base,
};
use num_bigint::{BigInt, Sign};

use crate::bip340::{require_below, BASE_MODULUS};
use crate::nullifier::DigestBits;

const WIDTH: usize = 64;
const LIMBS: usize = 4;

/// Canonical secp256k1 base field values in four little-endian 64-bit limbs.
#[derive(Clone)]
pub(super) struct FieldVar<F: PrimeField>(BigNat<F>);

pub(super) struct FieldContext<F: PrimeField> {
    modulus: BigNat<F>,
    pub zero: FieldVar<F>,
}

impl<F: PrimeField> FieldContext<F> {
    pub fn new<CS: ConstraintSystem<F>>() -> Result<Self, SynthesisError> {
        // At most four products of two 64-bit limbs contribute to a
        // coefficient. Nova's integer carries also fit with this margin.
        if F::CAPACITY < 200 {
            return Err(SynthesisError::Unsatisfiable(
                "secp256k1 arithmetic needs at least 200 circuit field bits".into(),
            ));
        }
        let mut modulus = constant_nat::<F, CS>(BigInt::from_bytes_be(Sign::Plus, &BASE_MODULUS));
        modulus.params.min_bits = WIDTH * LIMBS;
        Ok(Self {
            modulus,
            zero: FieldVar::constant::<CS>(Base::ZERO),
        })
    }

    pub fn add<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        a: &FieldVar<F>,
        b: &FieldVar<F>,
    ) -> Result<FieldVar<F>, SynthesisError> {
        let value = a.value().zip(b.value()).map(|(a, b)| a + b);
        let result = FieldVar::alloc(cs.namespace(|| "canonical sum"), value)?;
        self.require_sum(cs.namespace(|| "modular sum"), a, b, &result)?;
        Ok(result)
    }

    pub fn sub<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        a: &FieldVar<F>,
        b: &FieldVar<F>,
    ) -> Result<FieldVar<F>, SynthesisError> {
        let value = a.value().zip(b.value()).map(|(a, b)| a - b);
        let result = FieldVar::alloc(cs.namespace(|| "canonical difference"), value)?;
        self.require_sum(cs.namespace(|| "modular difference"), b, &result, a)?;
        Ok(result)
    }

    pub fn mul<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        a: &FieldVar<F>,
        b: &FieldVar<F>,
    ) -> Result<FieldVar<F>, SynthesisError> {
        let (_, result) = a.0.mult_mod(
            cs.namespace(|| "integer product and quotient"),
            &b.0,
            &self.modulus,
        )?;
        let result = FieldVar(result);
        result.require_canonical(cs.namespace(|| "canonical product"))?;
        Ok(result)
    }

    fn require_sum<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        a: &FieldVar<F>,
        b: &FieldVar<F>,
        result: &FieldVar<F>,
    ) -> Result<(), SynthesisError> {
        // Canonical operands bound the exact integer sum below 2p. A single
        // Boolean chooses whether p was removed, and integer carries bind it.
        let integer_sum = a.0.add(&b.0)?;
        let overflow = integer_sum
            .value
            .as_ref()
            .zip(self.modulus.value.as_ref())
            .map(|(sum, modulus)| sum >= modulus);
        let overflow = AllocatedBit::alloc(cs.namespace(|| "sum at least p"), overflow)?.into();
        let carry = select_nat(
            cs.namespace(|| "modulus or zero"),
            &overflow,
            &self.modulus,
            &self.zero.0,
        )?;
        let lifted = result.0.add(&carry)?;
        integer_sum.equal_when_carried_regroup(cs.namespace(|| "exact carry relation"), &lifted)
    }
}

impl<F: PrimeField> FieldVar<F> {
    pub fn constant<CS: ConstraintSystem<F>>(value: Base) -> Self {
        Self(constant_nat::<F, CS>(native_to_nat(value)))
    }

    pub fn alloc<CS: ConstraintSystem<F>>(
        mut cs: CS,
        value: Option<Base>,
    ) -> Result<Self, SynthesisError> {
        let number = Self(BigNat::alloc_from_nat(
            cs.namespace(|| "allocate field limbs"),
            || {
                value
                    .map(native_to_nat)
                    .ok_or(SynthesisError::AssignmentMissing)
            },
            WIDTH,
            LIMBS,
        )?);
        number.require_canonical(cs.namespace(|| "check canonical encoding"))?;
        Ok(number)
    }

    pub fn from_bits<CS: ConstraintSystem<F>>(
        mut cs: CS,
        bits: &DigestBits,
    ) -> Result<Self, SynthesisError> {
        let value = bits.iter().try_fold(BigInt::from(0), |value, bit| {
            bit.get_value().map(|bit| (value << 1) + u8::from(bit))
        });
        let number = Self(BigNat::alloc_from_nat(
            cs.namespace(|| "allocate wire limbs"),
            || value.ok_or(SynthesisError::AssignmentMissing),
            WIDTH,
            LIMBS,
        )?);
        number.bind_bits(cs.namespace(|| "limbs equal input bits"), bits);
        require_below(
            cs.namespace(|| "canonical wire encoding"),
            bits,
            &BASE_MODULUS,
        )?;
        Ok(number)
    }

    pub fn value(&self) -> Option<Base> {
        let (_, bytes) = self.0.value.as_ref()?.to_bytes_le();
        let mut repr = <Base as PrimeField>::Repr::default();
        repr.as_mut()[..bytes.len()].copy_from_slice(&bytes);
        // If an input's wire encoding is out of range, its range constraint
        // fails. Provide a dummy witness so downstream checks can still run.
        Some(Base::from_repr(repr).unwrap_or(Base::ZERO))
    }

    pub fn bits<CS: ConstraintSystem<F>>(&self, mut cs: CS) -> Result<DigestBits, SynthesisError> {
        let bits = (0..256)
            .map(|i| {
                let value = self.0.value.as_ref().map(|value| value.bit(255 - i));
                AllocatedBit::alloc(cs.namespace(|| format!("encoded bit {i}")), value)
                    .map(Boolean::from)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let bits = bits.try_into().unwrap();
        self.bind_bits(cs.namespace(|| "bits equal limbs"), &bits);
        Ok(bits)
    }

    pub fn select<CS: ConstraintSystem<F>>(
        cs: CS,
        pick: &Boolean,
        yes: &Self,
        no: &Self,
    ) -> Result<Self, SynthesisError> {
        Ok(Self(select_nat(cs, pick, &yes.0, &no.0)?))
    }

    pub fn equal<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        rhs: &Self,
    ) -> Result<Boolean, SynthesisError> {
        let mut result = Boolean::constant(true);
        let radix = F::from_u128(1u128 << WIDTH);
        for i in [0, 2] {
            let mut ns = cs.namespace(|| format!("compare limb pair {i}"));
            let value = self
                .0
                .limb_values
                .as_ref()
                .zip(rhs.0.limb_values.as_ref())
                .map(|(a, b)| (a[i] - b[i]) + radix * (a[i + 1] - b[i + 1]));
            let difference = self.0.limbs[i].clone() - &rhs.0.limbs[i]
                + (radix, &self.0.limbs[i + 1])
                - (radix, &rhs.0.limbs[i + 1]);
            let zero = AllocatedBit::alloc(
                ns.namespace(|| "equal"),
                value.map(|v| bool::from(v.is_zero())),
            )?;
            let inverse = AllocatedNum::alloc(ns.namespace(|| "inverse"), || {
                value
                    .map(|v| v.invert().unwrap_or(F::ZERO))
                    .ok_or(SynthesisError::AssignmentMissing)
            })?;
            ns.enforce(
                || "zero difference for equal pair",
                |_| difference.clone(),
                |lc| lc + zero.get_variable(),
                |lc| lc,
            );
            ns.enforce(
                || "invertible difference for unequal pair",
                |_| difference,
                |lc| lc + inverse.get_variable(),
                |lc| lc + CS::one() - zero.get_variable(),
            );
            result = Boolean::and(ns.namespace(|| "both pairs equal"), &result, &zero.into())?;
        }
        Ok(result)
    }

    pub fn require_equal<CS: ConstraintSystem<F>>(&self, mut cs: CS, rhs: &Self, when: &Boolean) {
        for i in 0..LIMBS {
            cs.enforce(
                || format!("equal limb {i}"),
                |lc| lc + &self.0.limbs[i] - &rhs.0.limbs[i],
                |lc| lc + &when.lc(CS::one(), F::ONE),
                |lc| lc,
            );
        }
    }

    fn require_canonical<CS: ConstraintSystem<F>>(&self, mut cs: CS) -> Result<(), SynthesisError> {
        let bits = self.bits(cs.namespace(|| "field bits"))?;
        require_below(cs.namespace(|| "below p"), &bits, &BASE_MODULUS)
    }

    fn bind_bits<CS: ConstraintSystem<F>>(&self, mut cs: CS, bits: &DigestBits) {
        for (i, (limb, bits)) in self
            .0
            .limbs
            .iter()
            .zip(bits.rchunks_exact(WIDTH))
            .enumerate()
        {
            cs.enforce(
                || format!("limb {i}"),
                |lc| {
                    bits.iter()
                        .rev()
                        .enumerate()
                        .fold(lc - limb, |lc, (i, bit)| {
                            lc + &bit.lc(CS::one(), F::from(1u64 << i))
                        })
                },
                |lc| lc + CS::one(),
                |lc| lc,
            );
        }
    }
}

fn select_nat<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    pick: &Boolean,
    yes: &BigNat<F>,
    no: &BigNat<F>,
) -> Result<BigNat<F>, SynthesisError> {
    let selected = BigNat::alloc_from_limbs(
        cs.namespace(|| "selected limbs"),
        || {
            pick.get_value()
                .and_then(|pick| (if pick { yes } else { no }).limb_values.clone())
                .ok_or(SynthesisError::AssignmentMissing)
        },
        None,
        WIDTH,
        LIMBS,
    )?;
    for i in 0..LIMBS {
        cs.enforce(
            || format!("select limb {i}"),
            |lc| lc + &pick.lc(CS::one(), F::ONE),
            |lc| lc + &yes.limbs[i] - &no.limbs[i],
            |lc| lc + &selected.limbs[i] - &no.limbs[i],
        );
    }
    Ok(selected)
}

fn constant_nat<F: PrimeField, CS: ConstraintSystem<F>>(value: BigInt) -> BigNat<F> {
    let values = nat_to_limbs::<F>(&value, WIDTH, LIMBS).unwrap();
    BigNat {
        limbs: values
            .iter()
            .map(|value| LinearCombination::zero() + (*value, CS::one()))
            .collect(),
        limb_values: Some(values),
        value: Some(value),
        params: BigNatParams::new(WIDTH, LIMBS),
    }
}

fn native_to_nat(value: Base) -> BigInt {
    let bits = value.to_le_bits();
    let bytes = std::array::from_fn::<_, 32, _>(|i| {
        (0..8).fold(0, |byte, j| byte | (u8::from(bits[8 * i + j]) << j))
    });
    BigInt::from_bytes_le(Sign::Plus, &bytes)
}
