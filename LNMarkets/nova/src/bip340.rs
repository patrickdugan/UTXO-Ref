//! Canonical BIP340 encodings and the tagged challenge for the curve equation.

use ff::PrimeField;
use nova_snark::frontend::{Boolean, ConstraintSystem, SynthesisError};
use sha2::{Digest, Sha256};

use crate::nullifier::{bits, tagged_digest, DigestBits};
use crate::secp256k1::Secp256k1;
use crate::wire::{constants, less_than_le, require_nonzero};

pub(crate) const BASE_MODULUS: [u8; 32] = {
    let mut bytes = [0xff; 32];
    bytes[27] = 0xfe;
    bytes[30] = 0xfc;
    bytes[31] = 0x2f;
    bytes
};
pub(crate) const SCALAR_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// MSB-first bit strings for the x-coordinate, signature scalar and
/// reduced challenge. The curve relation still needs to verify that
/// sG - eP is a finite even-Y point whose x-coordinate is r.
pub struct SchnorrComponents {
    pub r: DigestBits,
    pub s: DigestBits,
    pub e: DigestBits,
}

/// Apply the complete BIP340 check to a private signature and the exact
/// key and message bits used by the application statement.
pub fn verify_signature<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    curve: &Secp256k1<F>,
    key: &DigestBits,
    message: &DigestBits,
    signature: &[Boolean; 512],
) -> Result<(), SynthesisError> {
    let parts = signature_transcript(
        cs.namespace(|| "signature transcript"),
        key,
        message,
        signature,
    )?;
    let key = curve.lift_x(cs.namespace(|| "verify public key lift"), key)?;
    curve.verify_schnorr_equation(
        cs.namespace(|| "verify BIP340 equation"),
        &key,
        &parts.s,
        &parts.e,
        &parts.r,
    )
}

/// Check the signature encoding used by the pinned native k256 verifier
/// and constrain e to H_BIP0340/challenge(r || key || message) mod n.
pub fn signature_transcript<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    key: &DigestBits,
    message: &DigestBits,
    signature: &[Boolean; 512],
) -> Result<SchnorrComponents, SynthesisError> {
    let r = std::array::from_fn(|i| signature[i].clone());
    let s = std::array::from_fn(|i| signature[256 + i].clone());
    require_below(cs.namespace(|| "public key x range"), key, &BASE_MODULUS)?;
    require_below(cs.namespace(|| "signature r range"), &r, &BASE_MODULUS)?;
    require_below(cs.namespace(|| "signature s range"), &s, &SCALAR_ORDER)?;
    require_nonzero(cs.namespace(|| "nonzero signature r"), &r)?;
    require_nonzero(cs.namespace(|| "nonzero signature s"), &s)?;
    let mut payload = Vec::with_capacity(768);
    payload.extend_from_slice(&r);
    payload.extend_from_slice(key);
    payload.extend_from_slice(message);
    let raw = tagged_digest(
        cs.namespace(|| "BIP340 challenge digest"),
        &Sha256::digest(b"BIP0340/challenge").into(),
        &payload,
    )?;
    let e = reduce_challenge(cs.namespace(|| "challenge mod n"), &raw)?;
    Ok(SchnorrComponents { r, s, e })
}

pub(crate) fn require_below<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    input: &DigestBits,
    limit: &[u8; 32],
) -> Result<(), SynthesisError> {
    let in_le = std::array::from_fn::<_, 256, _>(|i| input[255 - i].clone());
    let mut limit_le = constants(limit);
    limit_le.reverse();
    let valid = less_than_le(cs.namespace(|| "compare to modulus"), &in_le, &limit_le)?;
    Boolean::enforce_equal(
        cs.namespace(|| "within modulus"),
        &valid,
        &Boolean::constant(true),
    )
}

fn reduce_challenge<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    digest: &DigestBits,
) -> Result<DigestBits, SynthesisError> {
    let order: Vec<_> = bits(&SCALAR_ORDER).collect();
    let mut borrow = Boolean::constant(false);
    let mut difference = Vec::with_capacity(256);
    // A 256-bit digest is below 2n. Compute its difference from n and
    // keep the original digest when the subtraction underflows.
    for (i, (input, order_bit)) in digest.iter().zip(order).rev().enumerate() {
        let mut ns = cs.namespace(|| format!("subtract bit {i}"));
        let low_bit = Boolean::xor(ns.namespace(|| "difference"), input, &borrow)?;
        if order_bit {
            difference.push(low_bit.not());
            borrow = Boolean::or(ns.namespace(|| "borrow"), &input.not(), &borrow)?;
        } else {
            difference.push(low_bit);
            borrow = Boolean::and(ns.namespace(|| "borrow"), &input.not(), &borrow)?;
        }
    }
    let output = digest
        .iter()
        .zip(difference.into_iter().rev())
        .enumerate()
        .map(|(i, (original, reduced))| {
            Boolean::sha256_ch(
                cs.namespace(|| format!("choose bit {i}")),
                &borrow,
                original,
                &reduced,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(output.try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{
        enforce_same_bits,
        fixture::{allocated, decode, ConstraintCheck, F},
    };
    use nova_snark::frontend::test_cs::TestConstraintSystem;

    const KEY: &str = "774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb";
    const MESSAGE: &str = "503a6fc266116b5ac714bacfef296aeeb21f3b86c4b8bcf865f32e423112e05b";
    const CHALLENGE: &str = "ecc375e3ca1fef52006c1797f9c9a0a90b3f264c2c4715dea34025ddd5643d34";
    const SIGNATURE: &str = concat!(
        "e8961da50e0bc6b65a8f7acc12e1e6ecba40b997542216d10a436e43515958060b",
        "d8cf62008b6071e944eff4f1758561612530df89ad8ce3a355b58bc8636f29"
    );

    fn check_curve_relation(wire_signature: &[u8; 64]) -> Option<String> {
        let mut cs = ConstraintCheck::new();
        let curve = Secp256k1::new::<ConstraintCheck>().unwrap();
        let mut allocate = |wire: &[u8]| allocated(cs.namespace(|| "test input"), wire);
        let key = allocate(&decode::<32>(KEY)).try_into().unwrap();
        let message = allocate(&decode::<32>(MESSAGE)).try_into().unwrap();
        let signature = allocate(wire_signature).try_into().unwrap();
        verify_signature(
            cs.namespace(|| "signature verification"),
            &curve,
            &key,
            &message,
            &signature,
        )
        .unwrap();
        cs.first_failure
    }

    #[test]
    fn checks_the_full_saved_trader_signature_and_rejects_changed_scalar() {
        let mut signature = decode(SIGNATURE);
        assert_eq!(check_curve_relation(&signature), None);
        signature[63] ^= 1;
        assert!(check_curve_relation(&signature).is_some());
    }

    fn verify_transcript(
        key: [u8; 32],
        message: [u8; 32],
        signature: [u8; 64],
        expected: [u8; 32],
    ) -> bool {
        let mut cs = TestConstraintSystem::<F>::new();
        let key = allocated(cs.namespace(|| "x"), &key).try_into().unwrap();
        let message = allocated(cs.namespace(|| "message"), &message)
            .try_into()
            .unwrap();
        let signature = allocated(cs.namespace(|| "signature"), &signature)
            .try_into()
            .unwrap();
        let components =
            signature_transcript(cs.namespace(|| "transcript"), &key, &message, &signature)
                .unwrap();
        enforce_same_bits(
            cs.namespace(|| "expected challenge"),
            &components.e,
            &constants(&expected),
        )
        .unwrap();
        cs.is_satisfied()
    }

    fn fixture_challenge(key: &[u8; 32], message: &[u8; 32], signature: &[u8; 64]) -> [u8; 32] {
        let tag = Sha256::digest(b"BIP0340/challenge");
        let digest: [u8; 32] = Sha256::new()
            .chain_update(tag)
            .chain_update(tag)
            .chain_update(&signature[..32])
            .chain_update(key)
            .chain_update(message)
            .finalize()
            .into();
        assert!(digest < SCALAR_ORDER);
        digest
    }

    #[test]
    fn binds_the_saved_trader_summary_signature_to_the_exact_message() {
        let message = decode(MESSAGE);
        let signature = decode(SIGNATURE);
        let expected = decode(CHALLENGE);
        assert!(verify_transcript(decode(KEY), message, signature, expected));
        let mut changed = message;
        changed[0] ^= 1;
        assert!(!verify_transcript(
            decode(KEY),
            changed,
            signature,
            expected
        ));
    }

    #[test]
    fn rejects_noncanonical_coordinates_and_signature_scalars() {
        let signature: [u8; 64] = decode(SIGNATURE);
        let message = decode(MESSAGE);
        assert!(!verify_transcript(
            BASE_MODULUS,
            message,
            signature,
            fixture_challenge(&BASE_MODULUS, &message, &signature),
        ));
        for (offset, bytes) in [
            (0, BASE_MODULUS),
            (32, SCALAR_ORDER),
            (0, [0; 32]),
            (32, [0; 32]),
        ] {
            let mut invalid = signature;
            invalid[offset..offset + 32].copy_from_slice(&bytes);
            let key = decode(KEY);
            assert!(!verify_transcript(
                key,
                message,
                invalid,
                fixture_challenge(&key, &message, &invalid),
            ));
        }
    }

    #[test]
    fn reduces_the_challenge_on_both_sides_of_the_order() {
        let mut below_order = SCALAR_ORDER;
        below_order[31] -= 1;
        let mut above_order = SCALAR_ORDER;
        above_order[31] += 1;
        let mut one = [0u8; 32];
        one[31] = 1;
        for (input, expected) in [
            (below_order, below_order),
            (SCALAR_ORDER, [0u8; 32]),
            (above_order, one),
        ] {
            let mut cs = TestConstraintSystem::<F>::new();
            let input = allocated(cs.namespace(|| "input"), &input)
                .try_into()
                .unwrap();
            let reduced = reduce_challenge(cs.namespace(|| "reduce"), &input).unwrap();
            enforce_same_bits(cs.namespace(|| "expected"), &reduced, &constants(&expected))
                .unwrap();
            assert!(cs.is_satisfied());
        }
    }
}
