//! Nova steps for the ordered signature and Taproot curve equations.

use std::sync::Arc;

use ff::{PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{
        gadgets::poseidon::{
            Elt, IOPattern, PoseidonConstants, Simplex, Sponge, SpongeAPI, SpongeCircuit, SpongeOp,
            SpongeTrait, Strength,
        },
        num::AllocatedNum,
        AllocatedBit, Boolean, ConstraintSystem, SynthesisError,
    },
    traits::circuit::StepCircuit,
};
use typenum::U12;

use crate::nullifier::DigestBits;
use crate::nullifier_batch::{advance_level, choose};
use crate::nullifier_path::{pack_limb, unpack_bits, unpack_digest};
use crate::wire::allocate_bytes;
use crate::MAX_BATCH_ROWS;

use super::{field::FieldVar, PointVar, Secp256k1, GENERATOR_X};

const BITS_PER_STEP: usize = 8;
const LEVEL_BITS: usize = 5;
pub const STEPS_PER_EQUATION: usize = 1 << LEVEL_BITS;
const EQUATIONS_PER_ROW: usize = 7;
const STATE_ARITY: usize = 15;
const DOMAIN: u32 = 0x4c4e4d43; // LNMC

/// A private equation sG - eP with an expected finite x-coordinate.
#[derive(Clone, Debug)]
pub struct CurveEquation {
    pub salt: [u8; 32],
    pub key: [u8; 32],
    pub s: [u8; 32],
    pub e: [u8; 32],
    pub result_x: [u8; 32],
    pub even_y: bool,
}

/// The same equation inputs expressed as constrained, MSB-first bits.
pub struct EquationBits {
    pub salt: DigestBits,
    pub key: DigestBits,
    pub s: DigestBits,
    pub e: DigestBits,
    pub result_x: DigestBits,
    pub even_y: Boolean,
}

impl EquationBits {
    pub fn witness(&self) -> Result<CurveEquation, SynthesisError> {
        let bytes = |bits: &DigestBits| {
            let mut bytes = [0; 32];
            for (i, bit) in bits.iter().enumerate() {
                let bit = bit.get_value().ok_or(SynthesisError::AssignmentMissing)?;
                bytes[i / 8] |= u8::from(bit) << (7 - i % 8);
            }
            Ok::<_, SynthesisError>(bytes)
        };
        Ok(CurveEquation {
            salt: bytes(&self.salt)?,
            key: bytes(&self.key)?,
            s: bytes(&self.s)?,
            e: bytes(&self.e)?,
            result_x: bytes(&self.result_x)?,
            even_y: self
                .even_y
                .get_value()
                .ok_or(SynthesisError::AssignmentMissing)?,
        })
    }
}

/// The internal proof linkage uses the pinned Nova Poseidon sponge. The
/// Bitcoin and BIP340 hashes are checked independently in the main relation.
#[derive(Clone)]
pub struct CurveBinding<F: PrimeField>(Arc<PoseidonConstants<F, U12>>);

impl<F: PrimeField> Default for CurveBinding<F> {
    fn default() -> Self {
        Self(Arc::new(Sponge::<F, U12>::api_constants(
            Strength::Standard,
        )))
    }
}

impl<F: PrimeField> CurveBinding<F> {
    pub fn append(&self, prior: F, equation: &CurveEquation) -> F {
        let mut inputs = Vec::with_capacity(12);
        inputs.push(prior);
        for bytes in [
            &equation.salt,
            &equation.key,
            &equation.s,
            &equation.e,
            &equation.result_x,
        ] {
            inputs.extend(
                bytes
                    .chunks_exact(16)
                    .map(|limb| F::from_u128(u128::from_be_bytes(limb.try_into().unwrap()))),
            );
        }
        inputs.push(F::from(u64::from(equation.even_y)));
        let mut sponge = Sponge::new_with_constants(&self.0, Simplex);
        sponge.start(pattern(), Some(DOMAIN), &mut ());
        SpongeAPI::absorb(&mut sponge, 12, &inputs, &mut ());
        let output = SpongeAPI::squeeze(&mut sponge, 1, &mut ())[0];
        sponge.finish(&mut ()).expect("fixed Poseidon I/O");
        output
    }

    pub fn append_constrained<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        prior: &AllocatedNum<F>,
        equation: &EquationBits,
    ) -> Result<AllocatedNum<F>, SynthesisError> {
        let mut inputs = vec![Elt::Allocated(prior.clone())];
        for (i, digest) in [
            &equation.salt,
            &equation.key,
            &equation.s,
            &equation.e,
            &equation.result_x,
        ]
        .into_iter()
        .enumerate()
        {
            let mut ns = cs.namespace(|| format!("equation digest {i}"));
            inputs.push(Elt::Allocated(pack_limb(
                ns.namespace(|| "high limb"),
                &digest[..128],
            )?));
            inputs.push(Elt::Allocated(pack_limb(
                ns.namespace(|| "low limb"),
                &digest[128..],
            )?));
        }
        let parity = pack_limb(
            cs.namespace(|| "even-y requirement"),
            std::slice::from_ref(&equation.even_y),
        )?;
        inputs.push(Elt::Allocated(parity));
        let mut sponge = SpongeCircuit::new_with_constants(&self.0, Simplex);
        let output = {
            let mut ns = cs.namespace(|| "Poseidon binding");
            sponge.start(pattern(), Some(DOMAIN), &mut ns);
            SpongeAPI::absorb(&mut sponge, 12, &inputs, &mut ns);
            let output = SpongeAPI::squeeze(&mut sponge, 1, &mut ns);
            sponge.finish(&mut ns).expect("fixed Poseidon I/O");
            output
        };
        output[0].ensure_allocated(&mut cs.namespace(|| "binding output"))
    }
}

fn pattern() -> IOPattern {
    IOPattern(vec![SpongeOp::Absorb(12), SpongeOp::Squeeze(1)])
}

pub fn step_count(row_count: usize) -> Option<usize> {
    (1..=MAX_BATCH_ROWS)
        .contains(&row_count)
        .then(|| row_count * EQUATIONS_PER_ROW * STEPS_PER_EQUATION)
}

pub fn initial_state<F: PrimeField>() -> [F; STATE_ARITY] {
    [F::ZERO; STATE_ARITY]
}

pub fn final_state<F: PrimeField>(binding: F) -> [F; STATE_ARITY] {
    let mut state = initial_state();
    state[1] = binding;
    state
}

#[derive(Clone)]
pub struct CurveStep<F: PrimeField> {
    binding: CurveBinding<F>,
    equation: Option<CurveEquation>,
}

impl<F: PrimeField> CurveStep<F> {
    /// Supply the fixed circuit for independent setup without private rows.
    pub fn blank() -> Self {
        Self {
            binding: CurveBinding::default(),
            equation: None,
        }
    }

    pub fn for_equations(binding: CurveBinding<F>, equations: &[CurveEquation]) -> Vec<Self> {
        equations
            .iter()
            .flat_map(|equation| {
                (0..STEPS_PER_EQUATION).map(|i| Self {
                    binding: binding.clone(),
                    equation: (i == 0).then(|| equation.clone()),
                })
            })
            .collect()
    }
}

impl<F: PrimeFieldBits> StepCircuit<F> for CurveStep<F> {
    fn arity(&self) -> usize {
        STATE_ARITY
    }

    fn synthesize<CS: ConstraintSystem<F>>(
        &self,
        cs: &mut CS,
        state: &[AllocatedNum<F>],
    ) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        if state.len() != STATE_ARITY {
            return Err(SynthesisError::Unsatisfiable(
                "invalid curve fold state".into(),
            ));
        }
        let curve = Secp256k1::new::<CS>()?;
        let level = unpack_bits(cs.namespace(|| "chunk index"), &state[0], LEVEL_BITS)?;
        let old_parity = unpack_bits(cs.namespace(|| "prior parity"), &state[2], 1)?;
        let (level, first, last) = advance_level(cs.namespace(|| "advance chunk"), &level)?;
        let mut registers = Vec::with_capacity(6);
        for (i, name) in [
            "key",
            "scalar s",
            "scalar e",
            "target x",
            "accumulator x",
            "accumulator y",
        ]
        .into_iter()
        .enumerate()
        {
            registers.push(unpack_digest(
                cs.namespace(|| name),
                &state[3 + 2 * i],
                &state[4 + 2 * i],
            )?);
        }
        let [key, s, e, r, x, y]: [DigestBits; 6] = registers.try_into().unwrap();
        let equation = self.allocate_equation(cs.namespace(|| "equation witness"))?;
        let new_binding = self.binding.append_constrained(
            cs.namespace(|| "hash ordered equation"),
            &state[1],
            &equation,
        )?;
        let binding = select_number(
            cs.namespace(|| "update binding once"),
            &first,
            &new_binding,
            &state[1],
        )?;

        let parity = Boolean::sha256_ch(
            cs.namespace(|| "active parity policy"),
            &first,
            &equation.even_y,
            &old_parity[0],
        )?;
        let key = choose(cs.namespace(|| "active key"), &first, &equation.key, &key)?;
        let s = choose(cs.namespace(|| "active scalar s"), &first, &equation.s, &s)?;
        let e = choose(cs.namespace(|| "active scalar e"), &first, &equation.e, &e)?;
        let r = choose(
            cs.namespace(|| "active target"),
            &first,
            &equation.result_x,
            &r,
        )?;
        let point = curve.lift_x(cs.namespace(|| "even lift of active key"), &key)?;
        let (negative_key, generator_minus_key) =
            curve.joint_bases(cs.namespace(|| "base combinations"), &point)?;
        let running = PointVar {
            x: FieldVar::from_bits(cs.namespace(|| "unpack accumulator x"), &x)?,
            y: FieldVar::from_bits(cs.namespace(|| "unpack accumulator y"), &y)?,
        };
        let result = curve.advance_joint(
            cs.namespace(|| "advance eight joint scalar bits"),
            running,
            &negative_key,
            &generator_minus_key,
            &s[..BITS_PER_STEP],
            &e[..BITS_PER_STEP],
        )?;
        require_result(
            cs.namespace(|| "check completed equation"),
            &curve,
            &result,
            &r,
            &parity,
            &last,
        )?;

        let parity = Boolean::and(
            cs.namespace(|| "clear completed parity policy"),
            &last.not(),
            &parity,
        )?;
        let mut next = vec![
            pack_limb(cs.namespace(|| "next chunk index"), &level)?,
            binding,
            pack_limb(cs.namespace(|| "next parity"), &[parity])?,
        ];
        for (name, digest) in [
            ("next key", key),
            ("next scalar s", shift(&s)),
            ("next scalar e", shift(&e)),
            ("next target", r),
            (
                "next accumulator x",
                result.x.bits(cs.namespace(|| "result x bits"))?,
            ),
            (
                "next accumulator y",
                result.y.bits(cs.namespace(|| "result y bits"))?,
            ),
        ] {
            let mut ns = cs.namespace(|| name);
            let zero = std::array::from_fn(|_| Boolean::constant(false));
            let digest = choose(
                ns.namespace(|| "clear completed register"),
                &last,
                &zero,
                &digest,
            )?;
            next.push(pack_limb(ns.namespace(|| "high limb"), &digest[..128])?);
            next.push(pack_limb(ns.namespace(|| "low limb"), &digest[128..])?);
        }
        Ok(next)
    }
}

impl<F: PrimeField> CurveStep<F> {
    fn allocate_equation<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
    ) -> Result<EquationBits, SynthesisError> {
        let fallback = CurveEquation {
            salt: [0; 32],
            key: GENERATOR_X,
            s: [0; 32],
            e: [0; 32],
            result_x: [0; 32],
            even_y: false,
        };
        let equation = self.equation.as_ref().unwrap_or(&fallback);
        let mut digest = |name, bytes: &[u8; 32]| {
            allocate_bytes(cs.namespace(|| name), bytes).map(|bits| bits.try_into().unwrap())
        };
        Ok(EquationBits {
            salt: digest("salt", &equation.salt)?,
            key: digest("key", &equation.key)?,
            s: digest("s", &equation.s)?,
            e: digest("e", &equation.e)?,
            result_x: digest("target x", &equation.result_x)?,
            even_y: AllocatedBit::alloc(cs.namespace(|| "even-y policy"), Some(equation.even_y))?
                .into(),
        })
    }
}

fn require_result<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    curve: &Secp256k1<F>,
    result: &PointVar<F>,
    target: &DigestBits,
    even: &Boolean,
    last: &Boolean,
) -> Result<(), SynthesisError> {
    let identity = curve.is_identity(cs.namespace(|| "result at infinity"), result)?;
    let invalid = Boolean::and(
        cs.namespace(|| "infinite completed result"),
        last,
        &identity,
    )?;
    Boolean::enforce_equal(
        cs.namespace(|| "finite result"),
        &invalid,
        &Boolean::constant(false),
    )?;
    let target = FieldVar::from_bits(cs.namespace(|| "expected x coordinate"), target)?;
    result
        .x
        .require_equal(cs.namespace(|| "completed result x"), &target, last);
    let y = result.y.bits(cs.namespace(|| "result y parity"))?;
    let needs_even = Boolean::and(cs.namespace(|| "completed BIP340 equation"), last, even)?;
    let odd = Boolean::and(cs.namespace(|| "odd BIP340 result"), &needs_even, &y[255])?;
    Boolean::enforce_equal(
        cs.namespace(|| "required even result"),
        &odd,
        &Boolean::constant(false),
    )
}

fn shift(digest: &DigestBits) -> DigestBits {
    std::array::from_fn(|i| {
        digest
            .get(i + BITS_PER_STEP)
            .cloned()
            .unwrap_or_else(|| Boolean::constant(false))
    })
}

fn select_number<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    pick: &Boolean,
    yes: &AllocatedNum<F>,
    no: &AllocatedNum<F>,
) -> Result<AllocatedNum<F>, SynthesisError> {
    let value = AllocatedNum::alloc(cs.namespace(|| "selected number"), || {
        pick.get_value()
            .and_then(|pick| (if pick { yes } else { no }).get_value())
            .ok_or(SynthesisError::AssignmentMissing)
    })?;
    cs.enforce(
        || "conditional field selection",
        |lc| lc + &pick.lc(CS::one(), F::ONE),
        |lc| lc + yes.get_variable() - no.get_variable(),
        |lc| lc + value.get_variable() - no.get_variable(),
    );
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{decode, step_shape, ConstraintCheck, F};
    use ff::Field;

    fn saved_signature() -> CurveEquation {
        CurveEquation {
            salt: [0x37; 32],
            key: decode("774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb"),
            s: decode("0bd8cf62008b6071e944eff4f1758561612530df89ad8ce3a355b58bc8636f29"),
            e: decode("ecc375e3ca1fef52006c1797f9c9a0a90b3f264c2c4715dea34025ddd5643d34"),
            result_x: decode("e8961da50e0bc6b65a8f7acc12e1e6ecba40b997542216d10a436e4351595806"),
            even_y: true,
        }
    }

    fn check(equations: &[CurveEquation], expected_binding: F) -> Option<String> {
        let binding = CurveBinding::default();
        let mut cs = ConstraintCheck::new();
        let mut state = initial_state::<F>()
            .into_iter()
            .map(|value| {
                AllocatedNum::alloc(cs.namespace(|| "initial state"), || Ok(value)).unwrap()
            })
            .collect::<Vec<_>>();
        for step in CurveStep::for_equations(binding, equations) {
            state = step.synthesize(&mut cs, &state).unwrap();
        }
        for (i, (actual, expected)) in state.iter().zip(final_state(expected_binding)).enumerate() {
            cs.enforce(
                || format!("expected final state {i}"),
                |lc| lc + actual.get_variable() - (expected, ConstraintCheck::one()),
                |lc| lc + ConstraintCheck::one(),
                |lc| lc,
            );
        }
        cs.first_failure
    }

    #[test]
    fn folds_real_signature_and_rejects_a_changed_scalar() {
        let binding = CurveBinding::default();
        let mut signature = saved_signature();
        let steps = CurveStep::for_equations(binding.clone(), std::slice::from_ref(&signature));
        let shape = step_shape(&CurveStep::blank());
        assert_eq!(step_shape(&steps[0]), shape);
        assert_eq!(step_shape(steps.last().unwrap()), shape);
        assert_eq!(
            check(
                std::slice::from_ref(&signature),
                binding.append(F::ZERO, &signature)
            ),
            None
        );
        signature.s[31] ^= 1;
        assert!(check(
            std::slice::from_ref(&signature),
            binding.append(F::ZERO, &signature)
        )
        .is_some());
    }

    #[test]
    fn completes_adjacent_equations_and_applies_each_parity_policy() {
        let binding = CurveBinding::default();
        let mut e = [0; 32];
        e[31] = 1;
        // 0G - G is an odd-Y point with x(G).
        let mut odd = CurveEquation {
            salt: [0x56; 32],
            key: GENERATOR_X,
            s: [0; 32],
            e,
            result_x: GENERATOR_X,
            even_y: false,
        };
        let signature = saved_signature();
        let ordered = binding.append(binding.append(F::ZERO, &signature), &odd);
        assert_ne!(
            ordered,
            binding.append(binding.append(F::ZERO, &odd), &signature)
        );
        assert_eq!(check(&[signature, odd.clone()], ordered), None);
        odd.even_y = true;
        assert!(check(std::slice::from_ref(&odd), binding.append(F::ZERO, &odd)).is_some());
        assert_eq!(step_count(2), Some(448));
    }
}
