//! secp256k1 point constraints over the Nova circuit field.

mod field;
pub mod fold;

use ff::{Field, PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{Boolean, ConstraintSystem, SynthesisError},
    provider::secp_secq::secp256k1::Base,
};

use crate::nullifier::DigestBits;

use field::{FieldContext, FieldVar};

const GENERATOR_X: [u8; 32] = [
    0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b, 0x07,
    0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
];
const GENERATOR_Y: [u8; 32] = [
    0x48, 0x3a, 0xda, 0x77, 0x26, 0xa3, 0xc4, 0x65, 0x5d, 0xa4, 0xfb, 0xfc, 0x0e, 0x11, 0x08, 0xa8,
    0xfd, 0x17, 0xb4, 0x48, 0xa6, 0x85, 0x54, 0x19, 0x9c, 0x47, 0xd0, 0x8f, 0xfb, 0x10, 0xd4, 0xb8,
];

/// Constrained affine point. The internal pair (0, 0) encodes infinity.
#[derive(Clone)]
pub struct PointVar<F: PrimeField> {
    x: FieldVar<F>,
    y: FieldVar<F>,
}

pub struct Secp256k1<F: PrimeField> {
    field: FieldContext<F>,
    generator: PointVar<F>,
    identity: PointVar<F>,
    seven: FieldVar<F>,
}

impl<F: PrimeField> Secp256k1<F> {
    pub fn new<CS: ConstraintSystem<F>>() -> Result<Self, SynthesisError> {
        let field = FieldContext::<F>::new::<CS>()?;
        let generator = PointVar {
            x: FieldVar::constant::<CS>(from_be_bytes(GENERATOR_X)),
            y: FieldVar::constant::<CS>(from_be_bytes(GENERATOR_Y)),
        };
        let identity = PointVar {
            x: field.zero.clone(),
            y: field.zero.clone(),
        };
        Ok(Self {
            field,
            generator,
            identity,
            seven: FieldVar::constant::<CS>(Base::from(7)),
        })
    }

    /// Constrain the BIP340 even-Y lift of an x-only key.
    pub fn lift_x<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        x: &DigestBits,
    ) -> Result<PointVar<F>, SynthesisError> {
        let x = FieldVar::from_bits(cs.namespace(|| "canonical x"), x)?;
        let y_value = x.value().map(|x| {
            let y = (x.square() * x + Base::from(7))
                .sqrt()
                .unwrap_or(Base::ZERO);
            if y.to_le_bits()[0] {
                -y
            } else {
                y
            }
        });
        let y = FieldVar::alloc(cs.namespace(|| "canonical y"), y_value)?;
        let x_squared = self.field.mul(cs.namespace(|| "x squared"), &x, &x)?;
        let x_cubed = self.field.mul(cs.namespace(|| "x cubed"), &x_squared, &x)?;
        let rhs = self
            .field
            .add(cs.namespace(|| "x cubed plus seven"), &x_cubed, &self.seven)?;
        let y_squared = self.field.mul(cs.namespace(|| "y squared"), &y, &y)?;
        y_squared.require_equal(
            cs.namespace(|| "curve equation"),
            &rhs,
            &Boolean::constant(true),
        );
        self.require_even(cs.namespace(|| "BIP340 even root"), &y)?;
        Ok(PointVar { x, y })
    }

    /// Check the affine x-coordinate of a finite result.
    pub fn require_x<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        point: &PointVar<F>,
        x: &DigestBits,
    ) -> Result<(), SynthesisError> {
        let identity = self.is_identity(cs.namespace(|| "point at infinity"), point)?;
        Boolean::enforce_equal(
            cs.namespace(|| "finite point"),
            &identity,
            &Boolean::constant(false),
        )?;
        let x = FieldVar::from_bits(cs.namespace(|| "expected x coordinate"), x)?;
        point
            .x
            .require_equal(cs.namespace(|| "compare x"), &x, &Boolean::constant(true));
        Ok(())
    }

    /// Constrain the complete BIP340 curve equation once the signature
    /// transcript and its scalar encodings have been checked separately.
    pub fn verify_schnorr_equation<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        key: &PointVar<F>,
        s: &DigestBits,
        e: &DigestBits,
        r: &DigestBits,
    ) -> Result<(), SynthesisError> {
        let result = self.schnorr_lincomb(cs.namespace(|| "sG minus eP"), key, s, e)?;
        self.require_x(cs.namespace(|| "finite R with x equal to r"), &result, r)?;
        self.require_even(cs.namespace(|| "even R"), &result.y)
    }

    /// Compute scalar times G from the MSB-first scalar bits. The caller
    /// constrains the scalar order for uses such as the Taproot tweak.
    pub fn multiply_generator<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        scalar: &DigestBits,
    ) -> Result<PointVar<F>, SynthesisError> {
        let mut result = self.identity.clone();
        for (i, bit) in scalar.iter().enumerate() {
            let mut ns = cs.namespace(|| format!("scalar bit {i}"));
            let doubled = self.double(ns.namespace(|| "double accumulator"), &result)?;
            let added = self.add(ns.namespace(|| "add generator"), &doubled, &self.generator)?;
            result = self.select(ns.namespace(|| "select accumulator"), bit, &added, &doubled)?;
        }
        Ok(result)
    }

    pub fn add<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        a: &PointVar<F>,
        b: &PointVar<F>,
    ) -> Result<PointVar<F>, SynthesisError> {
        let a_identity = self.is_identity(cs.namespace(|| "left identity"), a)?;
        let b_identity = self.is_identity(cs.namespace(|| "right identity"), b)?;
        let same_x = a.x.equal(cs.namespace(|| "same x"), &b.x)?;
        let same_y = a.y.equal(cs.namespace(|| "same y"), &b.y)?;
        let tangent = Boolean::and(cs.namespace(|| "same point"), &same_x, &same_y)?;
        let inverse = Boolean::and(
            cs.namespace(|| "opposite finite points"),
            &same_x,
            &same_y.not(),
        )?;
        let either_identity =
            Boolean::or(cs.namespace(|| "either identity"), &a_identity, &b_identity)?;
        let inactive = Boolean::or(
            cs.namespace(|| "no finite sum formula"),
            &either_identity,
            &inverse,
        )?;
        let secant_numerator = self
            .field
            .sub(cs.namespace(|| "secant numerator"), &b.y, &a.y)?;
        let secant_denominator =
            self.field
                .sub(cs.namespace(|| "secant denominator"), &b.x, &a.x)?;
        let (tangent_numerator, tangent_denominator) =
            self.tangent(cs.namespace(|| "tangent"), a)?;
        let numerator = FieldVar::select(
            cs.namespace(|| "choose numerator"),
            &tangent,
            &tangent_numerator,
            &secant_numerator,
        )?;
        let denominator = FieldVar::select(
            cs.namespace(|| "choose denominator"),
            &tangent,
            &tangent_denominator,
            &secant_denominator,
        )?;
        let sum = self.affine_sum(
            cs.namespace(|| "finite sum"),
            a,
            b,
            &numerator,
            &denominator,
            &inactive.not(),
        )?;
        let sum = self.select(
            cs.namespace(|| "opposite points sum to identity"),
            &inverse,
            &self.identity,
            &sum,
        )?;
        let sum = self.select(cs.namespace(|| "identity on right"), &b_identity, a, &sum)?;
        self.select(cs.namespace(|| "identity on left"), &a_identity, b, &sum)
    }

    fn schnorr_lincomb<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        key: &PointVar<F>,
        s: &[Boolean],
        e: &[Boolean],
    ) -> Result<PointVar<F>, SynthesisError> {
        assert_eq!(s.len(), e.len());
        let (negative_key, generator_minus_key) =
            self.joint_bases(cs.namespace(|| "base combinations"), key)?;
        self.advance_joint(
            cs.namespace(|| "joint multiplication"),
            self.identity.clone(),
            &negative_key,
            &generator_minus_key,
            s,
            e,
        )
    }

    fn joint_bases<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        key: &PointVar<F>,
    ) -> Result<(PointVar<F>, PointVar<F>), SynthesisError> {
        let negative_key = PointVar {
            x: key.x.clone(),
            y: self
                .field
                .sub(cs.namespace(|| "negative key y"), &self.field.zero, &key.y)?,
        };
        let generator_minus_key =
            self.add(cs.namespace(|| "G minus P"), &self.generator, &negative_key)?;
        Ok((negative_key, generator_minus_key))
    }

    fn advance_joint<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        mut result: PointVar<F>,
        negative_key: &PointVar<F>,
        generator_minus_key: &PointVar<F>,
        s: &[Boolean],
        e: &[Boolean],
    ) -> Result<PointVar<F>, SynthesisError> {
        assert_eq!(s.len(), e.len());
        for (i, (s, e)) in s.iter().zip(e).enumerate() {
            let mut ns = cs.namespace(|| format!("joint scalar bit {i}"));
            let without_generator = self.select(
                ns.namespace(|| "choose identity or negative key"),
                e,
                negative_key,
                &self.identity,
            )?;
            let with_generator = self.select(
                ns.namespace(|| "choose generator or generator minus key"),
                e,
                generator_minus_key,
                &self.generator,
            )?;
            let addend = self.select(
                ns.namespace(|| "select base combination"),
                s,
                &with_generator,
                &without_generator,
            )?;
            result = self.double(ns.namespace(|| "double accumulator"), &result)?;
            result = self.add(ns.namespace(|| "add selected base"), &result, &addend)?;
        }
        Ok(result)
    }

    fn double<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        point: &PointVar<F>,
    ) -> Result<PointVar<F>, SynthesisError> {
        let identity = self.is_identity(cs.namespace(|| "input identity"), point)?;
        let (numerator, denominator) = self.tangent(cs.namespace(|| "tangent"), point)?;
        let result = self.affine_sum(
            cs.namespace(|| "finite double"),
            point,
            point,
            &numerator,
            &denominator,
            &identity.not(),
        )?;
        self.select(
            cs.namespace(|| "identity doubled"),
            &identity,
            &self.identity,
            &result,
        )
    }

    fn tangent<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        point: &PointVar<F>,
    ) -> Result<(FieldVar<F>, FieldVar<F>), SynthesisError> {
        let squared = self
            .field
            .mul(cs.namespace(|| "x squared"), &point.x, &point.x)?;
        let twice_squared = self
            .field
            .add(cs.namespace(|| "2 x squared"), &squared, &squared)?;
        let numerator = self
            .field
            .add(cs.namespace(|| "3 x squared"), &twice_squared, &squared)?;
        let denominator = self.field.add(cs.namespace(|| "2 y"), &point.y, &point.y)?;
        Ok((numerator, denominator))
    }

    fn affine_sum<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        a: &PointVar<F>,
        b: &PointVar<F>,
        numerator: &FieldVar<F>,
        denominator: &FieldVar<F>,
        active: &Boolean,
    ) -> Result<PointVar<F>, SynthesisError> {
        let zero_denominator =
            denominator.equal(cs.namespace(|| "zero denominator"), &self.field.zero)?;
        let invalid = Boolean::and(
            cs.namespace(|| "undefined finite slope"),
            active,
            &zero_denominator,
        )?;
        Boolean::enforce_equal(
            cs.namespace(|| "slope is defined"),
            &invalid,
            &Boolean::constant(false),
        )?;
        let slope_value = numerator
            .value()
            .zip(denominator.value())
            .map(|(n, d)| n * d.invert().unwrap_or(Base::ZERO));
        let slope = FieldVar::alloc(cs.namespace(|| "canonical slope"), slope_value)?;
        let product = self.field.mul(
            cs.namespace(|| "slope times denominator"),
            &slope,
            denominator,
        )?;
        product.require_equal(cs.namespace(|| "bind active slope"), numerator, active);
        let squared = self
            .field
            .mul(cs.namespace(|| "slope squared"), &slope, &slope)?;
        let sum_x = self
            .field
            .add(cs.namespace(|| "a.x plus b.x"), &a.x, &b.x)?;
        let x = self
            .field
            .sub(cs.namespace(|| "result x"), &squared, &sum_x)?;
        let diff_x = self
            .field
            .sub(cs.namespace(|| "a.x minus result x"), &a.x, &x)?;
        let term = self
            .field
            .mul(cs.namespace(|| "slope times x difference"), &slope, &diff_x)?;
        let y = self.field.sub(cs.namespace(|| "result y"), &term, &a.y)?;
        Ok(PointVar { x, y })
    }

    fn select<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        pick: &Boolean,
        yes: &PointVar<F>,
        no: &PointVar<F>,
    ) -> Result<PointVar<F>, SynthesisError> {
        Ok(PointVar {
            x: FieldVar::select(cs.namespace(|| "choose x"), pick, &yes.x, &no.x)?,
            y: FieldVar::select(cs.namespace(|| "choose y"), pick, &yes.y, &no.y)?,
        })
    }

    fn is_identity<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        point: &PointVar<F>,
    ) -> Result<Boolean, SynthesisError> {
        let x_zero = point
            .x
            .equal(cs.namespace(|| "x is zero"), &self.field.zero)?;
        let y_zero = point
            .y
            .equal(cs.namespace(|| "y is zero"), &self.field.zero)?;
        Boolean::and(cs.namespace(|| "both coordinates zero"), &x_zero, &y_zero)
    }

    fn require_even<CS: ConstraintSystem<F>>(
        &self,
        mut cs: CS,
        y: &FieldVar<F>,
    ) -> Result<(), SynthesisError> {
        let bits = y.bits(cs.namespace(|| "y coordinate"))?;
        Boolean::enforce_equal(
            cs.namespace(|| "low bit is zero"),
            &bits[255],
            &Boolean::constant(false),
        )
    }
}

fn from_be_bytes(mut bytes: [u8; 32]) -> Base {
    bytes.reverse();
    let mut repr = <Base as PrimeField>::Repr::default();
    repr.as_mut().copy_from_slice(&bytes);
    Base::from_repr(repr).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{allocated, decode, F};
    use nova_snark::frontend::test_cs::TestConstraintSystem;

    #[test]
    fn rejects_x_without_a_curve_lift() {
        let mut cs = TestConstraintSystem::<F>::new();
        let curve = Secp256k1::<F>::new::<TestConstraintSystem<F>>().unwrap();
        let x = allocated(cs.namespace(|| "input x"), &[0; 32])
            .try_into()
            .unwrap();
        curve.lift_x(cs.namespace(|| "lift"), &x).unwrap();
        assert!(!cs.is_satisfied());
    }

    #[test]
    fn affine_addition_covers_doubling_identity_and_opposites() {
        let mut cs = TestConstraintSystem::<F>::new();
        let curve = Secp256k1::<F>::new::<TestConstraintSystem<F>>().unwrap();
        let x = allocated(cs.namespace(|| "generator x"), &GENERATOR_X)
            .try_into()
            .unwrap();
        let g = curve.lift_x(cs.namespace(|| "lift G"), &x).unwrap();
        let d = curve.add(cs.namespace(|| "G plus G"), &g, &g).unwrap();
        let doubled_x =
            decode::<32>("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
        let two_g = allocated(cs.namespace(|| "expected 2G x"), &doubled_x)
            .try_into()
            .unwrap();
        curve
            .require_x(cs.namespace(|| "check 2G"), &d, &two_g)
            .unwrap();
        let g_plus_zero = curve
            .add(cs.namespace(|| "G plus identity"), &g, &curve.identity)
            .unwrap();
        curve
            .require_x(cs.namespace(|| "check G"), &g_plus_zero, &x)
            .unwrap();
        let negative_g = PointVar {
            x: g.x.clone(),
            y: curve
                .field
                .sub(cs.namespace(|| "negate G"), &curve.field.zero, &g.y)
                .unwrap(),
        };
        let sum = curve
            .add(cs.namespace(|| "G plus negative G"), &g, &negative_g)
            .unwrap();
        let identity = curve
            .is_identity(cs.namespace(|| "sum is identity"), &sum)
            .unwrap();
        Boolean::enforce_equal(
            cs.namespace(|| "check identity"),
            &identity,
            &Boolean::constant(true),
        )
        .unwrap();
        assert!(cs.is_satisfied(), "{:?}", cs.which_is_unsatisfied());
    }
}
