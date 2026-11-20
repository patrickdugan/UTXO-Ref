use ff::PrimeField;
use nova_snark::frontend::{sha256, Boolean, ConstraintSystem, SynthesisError};
use sha2::{Digest, Sha256};

const DOMAIN: &str = "UTXORef/LNMarkets/bitcoin-regtest/lnmarkets/v1/";
pub type DigestBits = [Boolean; 256];

/// Traverse one authorization tree level for both the old and inserted leaf.
/// The full fold must bind the direction to the outpoint key and link each
/// returned parent to the next level. Digests are in MSB-first byte order.
pub fn nullifier_parents<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    before: &DigestBits,
    after: &DigestBits,
    sibling: &DigestBits,
    node_is_right: &Boolean,
) -> Result<(DigestBits, DigestBits), SynthesisError> {
    let tag = tag_hash("nullifier-node");
    Ok((
        parent(
            cs.namespace(|| "before"),
            &tag,
            before,
            sibling,
            node_is_right,
        )?,
        parent(
            cs.namespace(|| "after"),
            &tag,
            after,
            sibling,
            node_is_right,
        )?,
    ))
}

fn parent<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    tag: &[u8; 32],
    node: &DigestBits,
    sibling: &DigestBits,
    node_is_right: &Boolean,
) -> Result<DigestBits, SynthesisError> {
    let mut left = Vec::with_capacity(256);
    let mut right = Vec::with_capacity(256);
    for (i, (node_bit, sibling_bit)) in node.iter().zip(sibling).enumerate() {
        let mut ns = cs.namespace(|| format!("branch bit {i}"));
        let difference = Boolean::xor(ns.namespace(|| "difference"), node_bit, sibling_bit)?;
        let swap = Boolean::and(ns.namespace(|| "swap"), node_is_right, &difference)?;
        left.push(Boolean::xor(ns.namespace(|| "left"), node_bit, &swap)?);
        right.push(Boolean::xor(ns.namespace(|| "right"), sibling_bit, &swap)?);
    }

    left.extend(right);
    tagged_digest(cs.namespace(|| "tagged node SHA256"), tag, &left)
}

pub(crate) fn tag_hash(label: &str) -> [u8; 32] {
    Sha256::digest(format!("{DOMAIN}{label}").as_bytes()).into()
}

pub(crate) fn tagged_digest<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: CS,
    tag: &[u8; 32],
    payload: &[Boolean],
) -> Result<DigestBits, SynthesisError> {
    let tag = bits(tag).map(Boolean::constant);
    let mut message = Vec::with_capacity(512 + payload.len());
    message.extend(tag.clone());
    message.extend(tag);
    message.extend_from_slice(payload);
    sha256(cs, &message)?
        .try_into()
        .map_err(|_| SynthesisError::Unsatisfiable("invalid SHA-256 digest length".into()))
}

pub(crate) fn bits(bytes: &[u8]) -> impl Iterator<Item = bool> + Clone + '_ {
    bytes
        .iter()
        .flat_map(|byte| (0..8).rev().map(move |bit| *byte & (1 << bit) != 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_snark::{
        frontend::{test_cs::TestConstraintSystem, AllocatedBit},
        provider::Bn256EngineIPA,
        traits::Engine,
    };

    type F = <Bn256EngineIPA as Engine>::Scalar;

    fn witness<CS: ConstraintSystem<F>>(mut cs: CS, hash: &[u8; 32]) -> DigestBits {
        bits(hash)
            .enumerate()
            .map(|(i, bit)| {
                AllocatedBit::alloc(cs.namespace(|| format!("digest bit {i}")), Some(bit))
                    .unwrap()
                    .into()
            })
            .collect::<Vec<Boolean>>()
            .try_into()
            .unwrap()
    }

    fn reference(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        let tag = tag_hash("nullifier-node");
        Sha256::new()
            .chain_update(tag)
            .chain_update(tag)
            .chain_update(left)
            .chain_update(right)
            .finalize()
            .into()
    }

    #[test]
    fn shared_path_obeys_both_key_directions_and_rejects_an_altered_parent() {
        let old = [0x43; 32];
        let new = [0x69; 32];
        let sibling = [0x92; 32];
        for node_is_right in [false, true] {
            let mut cs = TestConstraintSystem::<F>::new();
            let old_bits = witness(cs.namespace(|| "old node"), &old);
            let new_bits = witness(cs.namespace(|| "new node"), &new);
            let sibling_bits = witness(cs.namespace(|| "sibling"), &sibling);
            let direction = AllocatedBit::alloc(cs.namespace(|| "direction"), Some(node_is_right))
                .unwrap()
                .into();
            let (before, after) = nullifier_parents(
                cs.namespace(|| "path"),
                &old_bits,
                &new_bits,
                &sibling_bits,
                &direction,
            )
            .unwrap();
            for (node, result) in [(old, &before), (new, &after)] {
                let expected = if node_is_right {
                    reference(&sibling, &node)
                } else {
                    reference(&node, &sibling)
                };
                assert!(result
                    .iter()
                    .zip(bits(&expected))
                    .all(|(actual, bit)| actual.get_value() == Some(bit)));
            }
            assert!(cs.is_satisfied());
            let flipped = Boolean::constant(!after[0].get_value().unwrap());
            Boolean::enforce_equal(
                cs.namespace(|| "altered claimed parent"),
                &after[0],
                &flipped,
            )
            .unwrap();
            assert!(!cs.is_satisfied());
        }
    }
}
