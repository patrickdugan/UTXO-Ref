//! One Nova step per level of the v1 sparse authorization tree.

use ff::{PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{num::AllocatedNum, AllocatedBit, Boolean, ConstraintSystem, SynthesisError},
    traits::circuit::StepCircuit,
};
use sha2::{Digest, Sha256};

use crate::nullifier::{bits, nullifier_parents, tag_hash, tagged_digest, DigestBits};

const LIMB_BITS: usize = 128;
const STATE_ARITY: usize = 6;
pub const NULLIFIER_PATH_STEPS: usize = 256;

/// One private sibling in a leaf-to-root path. The verifier pins the exact
/// step count and supplies the initial state independently of the prover.
#[derive(Clone, Debug)]
pub struct NullifierPathStep(pub [u8; 32]);

/// The constrained start nodes for a private outpoint.
pub struct NullifierLeaves {
    pub key: DigestBits,
    pub empty: DigestBits,
    pub occupied: DigestBits,
}

/// Derive the leaf-to-root path inputs inside the circuit. The txid uses
/// display-order bytes. The index uses little-endian bytes. Each byte's
/// bits are most-significant first.
pub fn outpoint_leaves<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    txid: &DigestBits,
    vout: &[Boolean; 32],
) -> Result<NullifierLeaves, SynthesisError> {
    let mut outpoint = txid.to_vec();
    outpoint.extend_from_slice(vout);
    let key = tagged_digest(
        cs.namespace(|| "outpoint authorization key"),
        &tag_hash("consumed-outpoint-authorization"),
        &outpoint,
    )?;
    let empty_digest = tagged_hash("nullifier-empty-leaf", &[]);
    let empty =
        std::array::from_fn(|i| Boolean::constant(empty_digest[i / 8] & (0x80 >> (i % 8)) != 0));
    let occupied = tagged_digest(
        cs.namespace(|| "occupied leaf"),
        &tag_hash("nullifier-used-leaf"),
        &key,
    )?;
    Ok(NullifierLeaves {
        key,
        empty,
        occupied,
    })
}

/// Public input for a standalone path proof for the specified outpoint.
/// The txid is in display order, and vout is serialized little-endian.
pub fn initial_state<F: PrimeField>(txid: &[u8; 32], vout: u32) -> [F; STATE_ARITY] {
    let mut outpoint = [0u8; 36];
    outpoint[..32].copy_from_slice(txid);
    outpoint[32..].copy_from_slice(&vout.to_le_bytes());
    let key = tagged_hash("consumed-outpoint-authorization", &outpoint);
    let empty = tagged_hash("nullifier-empty-leaf", &[]);
    let occupied = tagged_hash("nullifier-used-leaf", &key);
    state(&key, &empty, &occupied)
}

/// Expected output after exactly `NULLIFIER_PATH_STEPS` verified steps.
pub fn final_state<F: PrimeField>(
    old_root: &[u8; 32],
    inserted_root: &[u8; 32],
) -> [F; STATE_ARITY] {
    state(&[0; 32], old_root, inserted_root)
}

fn tagged_hash(tag: &str, payload: &[u8]) -> [u8; 32] {
    let tag = tag_hash(tag);
    Sha256::new()
        .chain_update(tag)
        .chain_update(tag)
        .chain_update(payload)
        .finalize()
        .into()
}

fn state<F: PrimeField>(key: &[u8; 32], old: &[u8; 32], new: &[u8; 32]) -> [F; STATE_ARITY] {
    let limb = |bytes: &[u8]| F::from_u128(u128::from_be_bytes(bytes.try_into().unwrap()));
    [
        limb(&key[..16]),
        limb(&key[16..]),
        limb(&old[..16]),
        limb(&old[16..]),
        limb(&new[..16]),
        limb(&new[16..]),
    ]
}

impl<F: PrimeFieldBits> StepCircuit<F> for NullifierPathStep {
    fn arity(&self) -> usize {
        STATE_ARITY
    }

    fn synthesize<CS: ConstraintSystem<F>>(
        &self,
        cs: &mut CS,
        z: &[AllocatedNum<F>],
    ) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        if F::CAPACITY < LIMB_BITS as u32 {
            return Err(SynthesisError::Unsatisfiable(
                "nullifier state needs 128-bit field limbs".into(),
            ));
        }
        let [key_hi, key_lo, old_hi, old_lo, new_hi, new_lo] = z else {
            return Err(SynthesisError::Unsatisfiable(
                "invalid nullifier state arity".into(),
            ));
        };
        let key = unpack_digest(cs.namespace(|| "remaining key"), key_hi, key_lo)?;
        let old = unpack_digest(cs.namespace(|| "old node"), old_hi, old_lo)?;
        let new = unpack_digest(cs.namespace(|| "inserted node"), new_hi, new_lo)?;
        let sibling = allocate_digest(cs.namespace(|| "shared sibling"), &self.0)?;

        // The leaf-to-root path consumes the outpoint hash from its LSB.
        let (old, new) = nullifier_parents(
            cs.namespace(|| "nullifier parents"),
            &old,
            &new,
            &sibling,
            &key[255],
        )?;
        let shifted = std::array::from_fn(|i| {
            if i == 0 {
                Boolean::constant(false)
            } else {
                key[i - 1].clone()
            }
        });
        let mut result = Vec::with_capacity(STATE_ARITY);
        for (name, digest) in [
            ("next key", shifted),
            ("old parent", old),
            ("inserted parent", new),
        ] {
            let mut ns = cs.namespace(|| name);
            result.push(pack_limb(
                ns.namespace(|| "high limb"),
                &digest[..LIMB_BITS],
            )?);
            result.push(pack_limb(
                ns.namespace(|| "low limb"),
                &digest[LIMB_BITS..],
            )?);
        }
        Ok(result)
    }
}

fn allocate_digest<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    digest: &[u8; 32],
) -> Result<DigestBits, SynthesisError> {
    let values = bits(digest)
        .enumerate()
        .map(|(index, value)| {
            AllocatedBit::alloc(cs.namespace(|| format!("bit {index}")), Some(value))
                .map(Boolean::from)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values.try_into().unwrap())
}

fn unpack_digest<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
    high: &AllocatedNum<F>,
    low: &AllocatedNum<F>,
) -> Result<DigestBits, SynthesisError> {
    let mut bits = unpack_limb(cs.namespace(|| "high limb"), high)?;
    bits.extend(unpack_limb(cs.namespace(|| "low limb"), low)?);
    Ok(bits.try_into().unwrap())
}

fn unpack_limb<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
    limb: &AllocatedNum<F>,
) -> Result<Vec<Boolean>, SynthesisError> {
    let value = limb.get_value().map(|number| number.to_le_bits());
    let bits = (0..LIMB_BITS)
        .rev()
        .map(|index| {
            let bit = value.as_ref().map(|bits| bits[index]);
            AllocatedBit::alloc(cs.namespace(|| format!("bit {index}")), bit).map(Boolean::from)
        })
        .collect::<Result<Vec<_>, _>>()?;
    bind_limb(&mut cs, limb, &bits);
    Ok(bits)
}

fn pack_limb<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    bits: &[Boolean],
) -> Result<AllocatedNum<F>, SynthesisError> {
    let limb = AllocatedNum::alloc(cs.namespace(|| "packed limb"), || {
        let value = bits.iter().try_fold(0u128, |value, bit| {
            bit.get_value().map(|bit| (value << 1) | u128::from(bit))
        });
        value
            .map(F::from_u128)
            .ok_or(SynthesisError::AssignmentMissing)
    })?;
    bind_limb(&mut cs, &limb, bits);
    Ok(limb)
}

fn bind_limb<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: &mut CS,
    limb: &AllocatedNum<F>,
    bits: &[Boolean],
) {
    cs.enforce(
        || "limb equals its 128-bit decomposition",
        |lc| {
            let mut value = lc - limb.get_variable();
            let mut weight = F::ONE;
            for bit in bits.iter().rev() {
                value = value + &bit.lc(CS::one(), weight);
                weight = weight.double();
            }
            value
        },
        |lc| lc + CS::one(),
        |lc| lc,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use ff::Field;
    use nova_snark::{
        frontend::test_cs::TestConstraintSystem, provider::Bn256EngineIPA, traits::Engine,
    };

    type F = <Bn256EngineIPA as Engine>::Scalar;

    fn decode(hex: &str) -> [u8; 32] {
        std::array::from_fn(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
    }

    fn parent(node: &[u8; 32], sibling: &[u8; 32], node_is_right: bool) -> [u8; 32] {
        let (left, right) = if node_is_right {
            (sibling, node)
        } else {
            (node, sibling)
        };
        let mut payload = [0u8; 64];
        payload[..32].copy_from_slice(left);
        payload[32..].copy_from_slice(right);
        tagged_hash("nullifier-node", &payload)
    }

    #[test]
    fn private_leaf_derivation_matches_saved_outpoint_and_binds_the_index() {
        let txid = decode("a7e8a1ffcbc6972db5d22cf0d715071b04534e9800783f2ad7f7ed77814c8bf3");
        let key = decode("fbcd49551899dd41824edaaf227a5f75cab5c37d2ba4b044aefa88a2caf27266");
        let expected = [
            key,
            tagged_hash("nullifier-empty-leaf", &[]),
            tagged_hash("nullifier-used-leaf", &key),
        ];
        for vout in [2u32, 3] {
            let mut cs = TestConstraintSystem::<F>::new();
            let txid_bits = allocate_digest(cs.namespace(|| "txid"), &txid).unwrap();
            let index_bits: [Boolean; 32] = bits(&vout.to_le_bytes())
                .enumerate()
                .map(|(i, bit)| {
                    AllocatedBit::alloc(cs.namespace(|| format!("vout bit {i}")), Some(bit))
                        .unwrap()
                        .into()
                })
                .collect::<Vec<_>>()
                .try_into()
                .unwrap();
            let leaves =
                outpoint_leaves(cs.namespace(|| "leaves"), &txid_bits, &index_bits).unwrap();
            for (i, (actual, digest)) in [leaves.key, leaves.empty, leaves.occupied]
                .iter()
                .zip(expected)
                .enumerate()
            {
                for (j, (bit, want)) in actual.iter().zip(bits(&digest)).enumerate() {
                    Boolean::enforce_equal(
                        cs.namespace(|| format!("expected digest {i} bit {j}")),
                        bit,
                        &Boolean::constant(want),
                    )
                    .unwrap();
                }
            }
            assert_eq!(cs.is_satisfied(), vout == 2);
        }
    }

    #[test]
    fn folds_the_saved_batch_key_across_two_levels() {
        let txid = decode("a7e8a1ffcbc6972db5d22cf0d715071b04534e9800783f2ad7f7ed77814c8bf3");
        let key = decode("fbcd49551899dd41824edaaf227a5f75cab5c37d2ba4b044aefa88a2caf27266");
        let mut old = tagged_hash("nullifier-empty-leaf", &[]);
        let mut new = tagged_hash("nullifier-used-leaf", &key);
        let initial = initial_state::<F>(&txid, 2);
        assert_eq!(initial, state(&key, &old, &new));
        assert_ne!(initial_state::<F>(&txid, 1), initial);

        let mut cs = TestConstraintSystem::<F>::new();
        let mut z = initial
            .iter()
            .enumerate()
            .map(|(index, value)| {
                AllocatedNum::alloc(cs.namespace(|| format!("input {index}")), || Ok(*value))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let mut remaining = key;
        for (level, sibling) in [[0x3c; 32], [0x9d; 32]].into_iter().enumerate() {
            let node_is_right = remaining[31] & 1 != 0;
            old = parent(&old, &sibling, node_is_right);
            new = parent(&new, &sibling, node_is_right);
            let shifted = std::array::from_fn(|i| {
                let carry = if i == 0 { 0 } else { remaining[i - 1] << 7 };
                (remaining[i] >> 1) | carry
            });
            remaining = shifted;
            z = NullifierPathStep(sibling)
                .synthesize(&mut cs.namespace(|| format!("level {level}")), &z)
                .unwrap();
            let expected = state::<F>(&remaining, &old, &new);
            assert!(z
                .iter()
                .zip(expected)
                .all(|(num, want)| num.get_value() == Some(want)));
        }
        assert!(cs.is_satisfied());
        cs.enforce(
            || "altered inserted root",
            |lc| lc + z[5].get_variable(),
            |lc| lc + TestConstraintSystem::<F>::one(),
            |lc| {
                lc + (
                    z[5].get_value().unwrap() + F::ONE,
                    TestConstraintSystem::<F>::one(),
                )
            },
        );
        assert!(!cs.is_satisfied());
    }

    #[test]
    fn oversized_limb_does_not_alias_an_in_range_value() {
        let mut cs = TestConstraintSystem::<F>::new();
        let oversized = F::from_u128(u128::MAX) + F::ONE;
        let limb =
            AllocatedNum::alloc(cs.namespace(|| "oversized limb"), || Ok(oversized)).unwrap();
        unpack_limb(cs.namespace(|| "range check"), &limb).unwrap();
        assert!(!cs.is_satisfied());
    }
}
