//! Exact v1 two-leaf, two-party NUMS funding commitment.

use ff::PrimeField;
use nova_snark::frontend::{
    gadgets::{sha256::sha256_compression_function, uint32::UInt32},
    Boolean, ConstraintSystem, SynthesisError,
};
use sha2::{Digest, Sha256};

use crate::bip340::{require_below, SCALAR_ORDER};
use crate::nullifier::{tagged_digest, DigestBits};
use crate::secp256k1::Secp256k1;
use crate::summary_policy::require_different;
use crate::wire::{constants, enforce_same_bits, less_than_le, require_nonzero};

// First valid even-Y x-coordinate from SHA256("UTXORef DLC funding NUMS
// internal key v1:" || decimal_counter), as pinned in dlc_funding_output.js.
const NUMS_X: [u8; 32] = [
    0xc9, 0x9e, 0x99, 0x65, 0x16, 0x6e, 0x7f, 0xf8, 0x05, 0x16, 0x49, 0x47, 0x09, 0xdb, 0x8f, 0xdf,
    0xdc, 0x31, 0xb0, 0x62, 0x65, 0x00, 0xbb, 0x70, 0xdc, 0x36, 0x52, 0xfc, 0x2f, 0xf5, 0x84, 0xab,
];

/// Check the funding script from the exact party keys and the two
/// little-endian CSV bytes, each represented MSB-first as on the v1 wire.
pub fn verify_funding_script<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    curve: &Secp256k1<F>,
    trader: &DigestBits,
    maker: &DigestBits,
    csv: &[Boolean; 16],
    script: &[Boolean; 272],
) -> Result<(), SynthesisError> {
    enforce_same_bits(
        cs.namespace(|| "P2TR version and program length"),
        &script[..16],
        &constants(&[0x51, 0x20]),
    )?;
    curve.lift_x(cs.namespace(|| "validate trader key"), trader)?;
    curve.lift_x(cs.namespace(|| "validate maker key"), maker)?;
    let tweak = funding_tweak(
        cs.namespace(|| "derive TapTweak scalar"),
        trader,
        maker,
        csv,
    )?;
    let nums = curve.lift_x(cs.namespace(|| "lift pinned NUMS key"), &nums_bits())?;
    let tweak_point = curve.multiply_generator(cs.namespace(|| "tweak times generator"), &tweak)?;
    let output = curve.add(cs.namespace(|| "Taproot output key"), &nums, &tweak_point)?;
    let output_x = std::array::from_fn(|i| script[16 + i].clone());
    curve.require_x(cs.namespace(|| "committed output key"), &output, &output_x)
}

/// Rebuild the canonical CET and refund leaves and constrain the exact
/// tweak scalar, including BIP341's rejection of tweaks at least n.
pub fn funding_tweak<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    trader: &DigestBits,
    maker: &DigestBits,
    csv: &[Boolean; 16],
) -> Result<DigestBits, SynthesisError> {
    let nums = nums_bits();
    require_different(cs.namespace(|| "party keys differ"), trader, maker)?;
    require_different(
        cs.namespace(|| "trader key differs from NUMS"),
        trader,
        &nums,
    )?;
    require_different(cs.namespace(|| "maker key differs from NUMS"), maker, &nums)?;
    require_nonzero(cs.namespace(|| "positive refund CSV"), csv)?;
    let (first, second) = sorted(cs.namespace(|| "sort party keys"), trader, maker)?;
    let mut cet = constants(&[0x20]);
    cet.extend(first);
    cet.extend(constants(&[0xad, 0x20]));
    cet.extend(second);
    cet.extend(constants(&[0xac]));
    let cet_leaf = tapleaf(cs.namespace(|| "CET leaf"), &cet)?;
    let refund_leaf = refund_leaf(cs.namespace(|| "refund leaf"), csv, &cet)?;
    let (left, right) = sorted(cs.namespace(|| "sort leaf hashes"), &cet_leaf, &refund_leaf)?;
    let mut children = left.to_vec();
    children.extend(right);
    let root = bip_hash(cs.namespace(|| "merkle root"), b"TapBranch", &children)?;
    let mut payload = nums.to_vec();
    payload.extend(root);
    let tweak = bip_hash(cs.namespace(|| "TapTweak"), b"TapTweak", &payload)?;
    require_below(
        cs.namespace(|| "TapTweak below group order"),
        &tweak,
        &SCALAR_ORDER,
    )?;
    Ok(tweak)
}

fn refund_leaf<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    csv: &[Boolean; 16],
    cet: &[Boolean],
) -> Result<DigestBits, SynthesisError> {
    let refund_tail = [constants(&[0xb2, 0x75]), cet.to_vec()].concat();
    // For 1..16, 0x50 + the value encodes OP_1 through OP_16.
    let opcode = [
        Boolean::constant(false),
        Boolean::constant(true),
        csv[3].clone(),
        csv[3].not(),
        csv[4].clone(),
        csv[5].clone(),
        csv[6].clone(),
        csv[7].clone(),
    ];
    let scripts = [
        opcode.to_vec(),
        [constants(&[1]), csv[..8].to_vec()].concat(),
        [constants(&[2]), csv.to_vec()].concat(),
        [constants(&[3]), csv.to_vec(), constants(&[0])].concat(),
    ];
    let tails = scripts.map(|mut script| {
        script.extend_from_slice(&refund_tail);
        padded_tapleaf_tail(&script)
    });

    let csv_le: Vec<_> = csv
        .chunks_exact(8)
        .flat_map(|byte| byte.iter().rev().cloned())
        .collect();
    let mut selected = tails[3].clone();
    for (i, cutoff) in [(2, 32768u16), (1, 128), (0, 17)] {
        let cutoff_le = constants(&cutoff.to_le_bytes())
            .chunks_exact(8)
            .flat_map(|byte| byte.iter().rev().cloned())
            .collect::<Vec<_>>();
        let use_shorter = less_than_le(
            cs.namespace(|| format!("CSV below {cutoff}")),
            &csv_le,
            &cutoff_le,
        )?;
        selected = select(
            cs.namespace(|| format!("select CSV encoding {i}")),
            &use_shorter,
            &tails[i],
            &selected,
        )?;
    }
    // The four encodings all occupy two SHA-256 blocks after the fixed
    // doubled tag. Select their padded bytes before compressing them.
    let tag: [u8; 32] = Sha256::digest(b"TapLeaf").into();
    let tag_block = [constants(&tag), constants(&tag)].concat();
    let initial = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ]
    .map(UInt32::constant);
    let mut state =
        sha256_compression_function(cs.namespace(|| "TapLeaf tag"), &tag_block, &initial)?;
    for (i, block) in selected.chunks_exact(512).enumerate() {
        state = sha256_compression_function(
            cs.namespace(|| format!("selected TapLeaf block {i}")),
            block,
            &state,
        )?;
    }
    Ok(state
        .into_iter()
        .flat_map(UInt32::into_bits_be)
        .collect::<Vec<_>>()
        .try_into()
        .unwrap())
}

fn padded_tapleaf_tail(script: &[Boolean]) -> [Boolean; 1024] {
    let mut tail = constants(&[0xc0, (script.len() / 8) as u8]);
    tail.extend_from_slice(script);
    let bit_length = 512 + tail.len() as u64;
    tail.push(Boolean::constant(true));
    tail.resize(1024 - 64, Boolean::constant(false));
    tail.extend(constants(&bit_length.to_be_bytes()));
    tail.try_into().unwrap()
}

fn tapleaf<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: CS,
    script: &[Boolean],
) -> Result<DigestBits, SynthesisError> {
    // All template lengths are byte-aligned and below 253.
    let mut payload = constants(&[0xc0, (script.len() / 8) as u8]);
    payload.extend_from_slice(script);
    bip_hash(cs, b"TapLeaf", &payload)
}

fn bip_hash<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: CS,
    tag: &[u8],
    payload: &[Boolean],
) -> Result<DigestBits, SynthesisError> {
    tagged_digest(cs, &Sha256::digest(tag).into(), payload)
}

fn sorted<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    left: &DigestBits,
    right: &DigestBits,
) -> Result<(DigestBits, DigestBits), SynthesisError> {
    let reverse = |x: &DigestBits| std::array::from_fn::<_, 256, _>(|i| x[255 - i].clone());
    let keep = less_than_le(
        cs.namespace(|| "lexicographic order"),
        &reverse(left),
        &reverse(right),
    )?;
    Ok((
        select(cs.namespace(|| "low"), &keep, left, right)?,
        select(cs.namespace(|| "high"), &keep, right, left)?,
    ))
}

fn select<F: PrimeField, CS: ConstraintSystem<F>, const N: usize>(
    mut cs: CS,
    flag: &Boolean,
    yes: &[Boolean; N],
    no: &[Boolean; N],
) -> Result<[Boolean; N], SynthesisError> {
    let output = yes
        .iter()
        .zip(no)
        .enumerate()
        .map(|(i, (yes, no))| {
            Boolean::sha256_ch(cs.namespace(|| format!("bit {i}")), flag, yes, no)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(output.try_into().unwrap())
}

pub(crate) fn nums_bits() -> DigestBits {
    constants(&NUMS_X).try_into().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{allocated, decode, ConstraintCheck};

    const TRADER: &str = "774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb";
    const MAKER: &str = "d01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a";

    #[test]
    fn csv_script_encodings_match_utxoref_at_every_boundary() {
        let vectors = [
            (
                16u16,
                "aef22a76069d277fabf33ecd4bfd542758578421549d4531eedec2c84b97fce9",
            ),
            (
                17,
                "578320787ca872c220ce847ba5692058d0fe2a62cd9d11961a4f9893f478acbc",
            ),
            (
                127,
                "3132c604b102cb377b5933f028ff5b30d745257d6e092dc0331de010f0020860",
            ),
            (
                128,
                "9236f8ae4e50aec429899bf951a6f434b42dc894adb31e9476528756a3d74bf9",
            ),
            (
                32767,
                "4203cdaef0019d143a1be395df80a78b1aa6b73daf3fe30e32237efdbc3f44ff",
            ),
            (
                32768,
                "b5493ec0c1e532eb2fecc1b5e9dc91d5d2293954e6ad7805886df40c5f7e88a0",
            ),
        ];
        for (index, (delay, expected)) in vectors.into_iter().enumerate() {
            let mut cs = ConstraintCheck::new();
            let trader = allocated(cs.namespace(|| "trader"), &decode::<32>(TRADER))
                .try_into()
                .unwrap();
            let maker = allocated(cs.namespace(|| "maker"), &decode::<32>(MAKER))
                .try_into()
                .unwrap();
            let csv = allocated(cs.namespace(|| "CSV"), &delay.to_le_bytes())
                .try_into()
                .unwrap();
            let (first, second) = if index % 2 == 0 {
                (&trader, &maker)
            } else {
                (&maker, &trader)
            };
            let tweak =
                funding_tweak(cs.namespace(|| "funding tweak"), first, second, &csv).unwrap();
            enforce_same_bits(
                cs.namespace(|| "exact tweak from UTXORef"),
                &tweak,
                &constants(&decode::<32>(expected)),
            )
            .unwrap();
            assert_eq!(cs.first_failure, None, "CSV {delay}");
        }
    }

    #[test]
    fn funding_curve_equation_checks_the_exact_saved_output() {
        let mut expected =
            decode::<34>("5120b855eac8771861baee8061e84ebc00d5b940834e3b276edb981d6d0dc57aa9cd");
        for valid in [true, false] {
            let mut cs = ConstraintCheck::new();
            let curve = Secp256k1::new::<ConstraintCheck>().unwrap();
            let trader = allocated(cs.namespace(|| "trader"), &decode::<32>(TRADER))
                .try_into()
                .unwrap();
            let maker = allocated(cs.namespace(|| "maker"), &decode::<32>(MAKER))
                .try_into()
                .unwrap();
            let csv = allocated(cs.namespace(|| "CSV"), &144u16.to_le_bytes())
                .try_into()
                .unwrap();
            let script = allocated(cs.namespace(|| "funding script"), &expected)
                .try_into()
                .unwrap();
            verify_funding_script(
                cs.namespace(|| "funding commitment"),
                &curve,
                &trader,
                &maker,
                &csv,
                &script,
            )
            .unwrap();
            assert_eq!(cs.first_failure.is_none(), valid, "{:?}", cs.first_failure);
            expected[33] ^= 1;
        }
    }
}
