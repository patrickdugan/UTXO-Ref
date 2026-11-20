//! Recursive authorization paths linked to the ordered private v1 summaries.

use ff::{PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{num::AllocatedNum, AllocatedBit, Boolean, ConstraintSystem, SynthesisError},
    traits::circuit::StepCircuit,
};

use crate::nullifier::{bits, nullifier_parents, tag_hash, tagged_digest, DigestBits};
use crate::nullifier_path::{
    allocate_digest, outpoint_leaves, pack_limb, tagged_hash, unpack_bits, unpack_digest,
    NullifierLeaves, NULLIFIER_PATH_STEPS,
};
use crate::{MAX_BATCH_ROWS, V1_SUMMARY_BYTES};

const STATE_ARITY: usize = 11;
const ZERO: [u8; 32] = [0; 32];

/// One leaf-to-root level. At level zero, the private salt and outpoint
/// initialize the path and extend its binding to the main batch circuit.
#[derive(Clone, Debug, Default)]
pub struct BatchNullifierStep {
    pub salt: [u8; 32],
    pub txid: [u8; 32],
    pub vout: u32,
    pub sibling: [u8; 32],
}

impl BatchNullifierStep {
    /// Compute the row binding for fixture preparation or prover diagnostics.
    /// A batch verifier compares both proved bindings.
    pub fn extend_row_binding(&self, prior: &[u8; 32]) -> [u8; 32] {
        let mut payload = [0; 100];
        payload[..32].copy_from_slice(prior);
        payload[32..64].copy_from_slice(&self.salt);
        payload[64..96].copy_from_slice(&self.txid);
        payload[96..].copy_from_slice(&self.vout.to_le_bytes());
        tagged_hash("nova-ordered-outpoint", &payload)
    }
}

/// Start from the old root pinned in the independently retained journal.
pub fn initial_state<F: PrimeField>(old_root: &[u8; 32]) -> [F; STATE_ARITY] {
    boundary_state(old_root, &ZERO)
}

/// Pin all registers after a complete set of paths, including the binding
/// to the main circuit's ordered summaries and the journal's new root.
pub fn final_state<F: PrimeField>(new_root: &[u8; 32], row_binding: &[u8; 32]) -> [F; STATE_ARITY] {
    boundary_state(new_root, row_binding)
}

/// The verifier takes row_count from the independently retained journal.
pub fn step_count(row_count: usize) -> Option<usize> {
    (1..=MAX_BATCH_ROWS)
        .contains(&row_count)
        .then(|| row_count * NULLIFIER_PATH_STEPS)
}

/// Compute the linker digest from the same wire bits used for the signed
/// summaries. Row salts should be private and generated from fresh entropy.
pub fn bind_summary_outpoints<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    summaries: &[&[Boolean]],
) -> Result<DigestBits, SynthesisError> {
    if step_count(summaries.len()).is_none()
        || summaries
            .iter()
            .any(|row| row.len() != V1_SUMMARY_BYTES * 8)
    {
        return Err(SynthesisError::Unsatisfiable(
            "invalid nullifier binding summary dimensions".into(),
        ));
    }
    let mut binding = zero_digest();
    for (i, row) in summaries.iter().enumerate() {
        binding = extend_binding(
            cs.namespace(|| format!("bind summary {i}")),
            &binding,
            &row[..32 * 8],
            &row[128 * 8..160 * 8],
            &row[160 * 8..164 * 8],
        )?;
    }
    Ok(binding)
}

impl<F: PrimeFieldBits> StepCircuit<F> for BatchNullifierStep {
    fn arity(&self) -> usize {
        STATE_ARITY
    }

    fn synthesize<CS: ConstraintSystem<F>>(
        &self,
        cs: &mut CS,
        z: &[AllocatedNum<F>],
    ) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        if F::CAPACITY < 128 || z.len() != STATE_ARITY {
            return Err(SynthesisError::Unsatisfiable(
                "invalid batch nullifier state".into(),
            ));
        }
        let level = unpack_bits(cs.namespace(|| "level counter"), &z[0], 8)?;
        let (next_level, first, last) = advance_level(cs.namespace(|| "advance level"), &level)?;
        let mut digests = Vec::with_capacity(5);
        for (i, name) in ["key", "empty path", "occupied path", "root", "row binding"]
            .iter()
            .enumerate()
        {
            digests.push(unpack_digest(
                cs.namespace(|| *name),
                &z[1 + 2 * i],
                &z[2 + 2 * i],
            )?);
        }
        let [key, before, after, root, binding] = <[_; 5]>::try_from(digests).unwrap();

        let txid = allocate_digest(cs.namespace(|| "outpoint txid"), &self.txid)?;
        let salt = allocate_digest(cs.namespace(|| "summary salt"), &self.salt)?;
        let vout = bits(&self.vout.to_le_bytes())
            .enumerate()
            .map(|(i, bit)| {
                AllocatedBit::alloc(cs.namespace(|| format!("index bit {i}")), Some(bit))
                    .map(Boolean::from)
            })
            .collect::<Result<Vec<_>, _>>()?
            .try_into()
            .unwrap();
        let sibling = allocate_digest(cs.namespace(|| "shared sibling"), &self.sibling)?;
        let NullifierLeaves {
            key: fresh_key,
            empty,
            occupied,
        } = outpoint_leaves(cs.namespace(|| "derive private path"), &txid, &vout)?;
        let extended = extend_binding(
            cs.namespace(|| "extend ordered outpoint binding"),
            &binding,
            &salt,
            &txid,
            &vout,
        )?;
        let key = choose(cs.namespace(|| "select key"), &first, &fresh_key, &key)?;
        let before = choose(
            cs.namespace(|| "select empty path"),
            &first,
            &empty,
            &before,
        )?;
        let after = choose(
            cs.namespace(|| "select used path"),
            &first,
            &occupied,
            &after,
        )?;
        let binding = choose(
            cs.namespace(|| "select row binding"),
            &first,
            &extended,
            &binding,
        )?;

        let (before, after) = nullifier_parents(
            cs.namespace(|| "path parents"),
            &before,
            &after,
            &sibling,
            &key[255],
        )?;
        for (i, (before, root)) in before.iter().zip(&root).enumerate() {
            cs.enforce(
                || format!("completed empty path matches current root bit {i}"),
                |lc| lc + &last.lc(CS::one(), F::ONE),
                |lc| lc + &before.lc(CS::one(), F::ONE) - &root.lc(CS::one(), F::ONE),
                |lc| lc,
            );
        }
        let shifted = std::array::from_fn(|i| {
            if i == 0 {
                Boolean::constant(false)
            } else {
                key[i - 1].clone()
            }
        });
        let zero = zero_digest();
        let mut next = vec![pack_limb(cs.namespace(|| "next level"), &next_level)?];
        for (name, digest) in [
            (
                "next key",
                choose(cs.namespace(|| "clear key"), &last, &zero, &shifted)?,
            ),
            (
                "next empty",
                choose(cs.namespace(|| "clear empty path"), &last, &zero, &before)?,
            ),
            (
                "next occupied",
                choose(cs.namespace(|| "clear used path"), &last, &zero, &after)?,
            ),
            (
                "next root",
                choose(cs.namespace(|| "advance root"), &last, &after, &root)?,
            ),
            ("next binding", binding),
        ] {
            let mut ns = cs.namespace(|| name);
            next.push(pack_limb(ns.namespace(|| "high limb"), &digest[..128])?);
            next.push(pack_limb(ns.namespace(|| "low limb"), &digest[128..])?);
        }
        Ok(next)
    }
}

fn boundary_state<F: PrimeField>(root: &[u8; 32], binding: &[u8; 32]) -> [F; STATE_ARITY] {
    let mut state = [F::ZERO; STATE_ARITY];
    for (i, bytes) in root
        .chunks_exact(16)
        .chain(binding.chunks_exact(16))
        .enumerate()
    {
        state[7 + i] = F::from_u128(u128::from_be_bytes(bytes.try_into().unwrap()));
    }
    state
}

fn extend_binding<F: PrimeField, CS: ConstraintSystem<F>>(
    cs: CS,
    binding: &DigestBits,
    salt: &[Boolean],
    txid: &[Boolean],
    vout: &[Boolean],
) -> Result<DigestBits, SynthesisError> {
    let mut payload = binding.to_vec();
    payload.extend_from_slice(salt);
    payload.extend_from_slice(txid);
    payload.extend_from_slice(vout);
    tagged_digest(cs, &tag_hash("nova-ordered-outpoint"), &payload)
}

fn advance_level<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    level: &[Boolean],
) -> Result<(Vec<Boolean>, Boolean, Boolean), SynthesisError> {
    let mut next = Vec::with_capacity(level.len());
    let mut carry = Boolean::constant(true);
    let mut any = Boolean::constant(false);
    for (i, bit) in level.iter().rev().enumerate() {
        let mut ns = cs.namespace(|| format!("counter bit {i}"));
        next.push(Boolean::xor(ns.namespace(|| "sum"), bit, &carry)?);
        carry = Boolean::and(ns.namespace(|| "carry"), bit, &carry)?;
        any = Boolean::or(ns.namespace(|| "any set"), bit, &any)?;
    }
    next.reverse();
    Ok((next, any.not(), carry))
}

fn choose<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    pick: &Boolean,
    yes: &DigestBits,
    no: &DigestBits,
) -> Result<DigestBits, SynthesisError> {
    let result = yes
        .iter()
        .zip(no)
        .enumerate()
        .map(|(i, (yes, no))| {
            Boolean::sha256_ch(cs.namespace(|| format!("bit {i}")), pick, yes, no)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result.try_into().unwrap())
}

fn zero_digest() -> DigestBits {
    std::array::from_fn(|_| Boolean::constant(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::fixture::{allocated, decode, F, JOURNAL};
    use crate::wire::{constants, enforce_same_bits};
    use nova_snark::frontend::test_cs::TestConstraintSystem;
    use sha2::{Digest, Sha256};

    fn rows() -> [BatchNullifierStep; 2] {
        [
            BatchNullifierStep {
                salt: Sha256::digest(b"public fixture salt 1").into(),
                txid: decode("a7e8a1ffcbc6972db5d22cf0d715071b04534e9800783f2ad7f7ed77814c8bf3"),
                vout: 2,
                ..Default::default()
            },
            BatchNullifierStep {
                salt: Sha256::digest(b"public fixture salt 0").into(),
                txid: decode("e8ecbcd0ede1ee0bea6942c535a13784661a36f1a9d89d4e31c47909a588ca75"),
                vout: 1,
                ..Default::default()
            },
        ]
    }

    fn branch(node: [u8; 32], sibling: [u8; 32], right: bool) -> [u8; 32] {
        let nodes = if right {
            [sibling, node]
        } else {
            [node, sibling]
        };
        tagged_hash("nullifier-node", nodes.as_flattened())
    }

    fn key(row: &BatchNullifierStep) -> [u8; 32] {
        let mut payload = row.txid.to_vec();
        payload.extend_from_slice(&row.vout.to_le_bytes());
        tagged_hash("consumed-outpoint-authorization", &payload)
    }

    fn direction(key: &[u8; 32], level: usize) -> bool {
        key[31 - level / 8] & (1 << (level % 8)) != 0
    }

    fn walk(key: &[u8; 32], leaf: [u8; 32], siblings: &[[u8; 32]]) -> Vec<[u8; 32]> {
        let mut nodes = vec![leaf];
        for (level, sibling) in siblings.iter().enumerate() {
            nodes.push(branch(nodes[level], *sibling, direction(key, level)));
        }
        nodes
    }

    fn update_path(
        path: &mut [[u8; 32]],
        target: &[u8; 32],
        inserted: &[u8; 32],
        new_nodes: &[[u8; 32]],
    ) {
        let fork = (0..path.len())
            .rev()
            .find(|&i| direction(target, i) != direction(inserted, i))
            .unwrap();
        path[fork] = new_nodes[fork];
    }

    fn journal_roots() -> ([u8; 32], [u8; 32]) {
        (
            JOURNAL[124..156].try_into().unwrap(),
            JOURNAL[156..188].try_into().unwrap(),
        )
    }

    fn check_step(
        step: &BatchNullifierStep,
        input: [F; STATE_ARITY],
        expected: [F; STATE_ARITY],
    ) -> bool {
        let mut cs = TestConstraintSystem::<F>::new();
        let z = input
            .into_iter()
            .enumerate()
            .map(|(i, value)| {
                AllocatedNum::alloc(cs.namespace(|| format!("state {i}")), || Ok(value)).unwrap()
            })
            .collect::<Vec<_>>();
        let next = step.synthesize(&mut cs.namespace(|| "step"), &z).unwrap();
        for (i, (num, value)) in next.iter().zip(expected).enumerate() {
            cs.enforce(
                || format!("pin output register {i}"),
                |lc| lc + num.get_variable() - (value, TestConstraintSystem::<F>::one()),
                |lc| lc + TestConstraintSystem::<F>::one(),
                |lc| lc,
            );
        }
        cs.is_satisfied()
    }

    fn interior(
        level: u8,
        key: &[u8; 32],
        before: [u8; 32],
        after: [u8; 32],
        root: &[u8; 32],
        binding: &[u8; 32],
    ) -> [F; STATE_ARITY] {
        let mut remaining = [0; 32];
        let shift = usize::from(level);
        for i in 0..NULLIFIER_PATH_STEPS - shift {
            remaining[31 - i / 8] |= u8::from(direction(key, i + shift)) << (i % 8);
        }
        let mut state = boundary_state(root, binding);
        state[0] = F::from(u64::from(level));
        for (i, chunk) in [&remaining, &before, &after]
            .into_iter()
            .flat_map(|value| value.chunks_exact(16))
            .enumerate()
        {
            state[1 + i] = F::from_u128(u128::from_be_bytes(chunk.try_into().unwrap()));
        }
        state
    }

    #[test]
    fn starts_and_completes_each_saved_path_and_rejects_stale_root() {
        let (old_root, new_root) = journal_roots();
        let [first, second] = rows();
        let [first_key, second_key] = [key(&first), key(&second)];
        let empty = tagged_hash("nullifier-empty-leaf", &[]);
        let mut defaults = vec![empty];
        for level in 0..256 {
            defaults.push(branch(defaults[level], defaults[level], false));
        }
        let prior_key = Sha256::digest(b"previously accepted synthetic authorization").into();
        let prior_nodes = walk(
            &prior_key,
            tagged_hash("nullifier-used-leaf", &prior_key),
            &defaults[..256],
        );
        assert_eq!(prior_nodes[256], old_root);
        let mut first_path = defaults[..256].to_vec();
        update_path(&mut first_path, &first_key, &prior_key, &prior_nodes);
        let first_before = walk(&first_key, empty, &first_path);
        assert_eq!(first_before[256], old_root);
        let first_nodes = walk(
            &first_key,
            tagged_hash("nullifier-used-leaf", &first_key),
            &first_path,
        );
        let mut second_path = defaults[..256].to_vec();
        update_path(&mut second_path, &second_key, &prior_key, &prior_nodes);
        update_path(&mut second_path, &second_key, &first_key, &first_nodes);
        let interim = first_nodes[256];
        let second_before = walk(&second_key, empty, &second_path);
        let second_after = walk(
            &second_key,
            tagged_hash("nullifier-used-leaf", &second_key),
            &second_path,
        );
        assert_eq!(second_before[256], interim);
        assert_eq!(second_after[256], new_root);

        let first_bound = first.extend_row_binding(&ZERO);
        let second_bound = second.extend_row_binding(&first_bound);
        let start = |row: &BatchNullifierStep, sibling| BatchNullifierStep {
            sibling,
            ..row.clone()
        };
        let end = |sibling| BatchNullifierStep {
            sibling,
            ..Default::default()
        };
        assert_eq!(step_count(2), Some(512));
        assert_eq!(step_count(0), None);
        assert_eq!(step_count(33), None);
        assert!(check_step(
            &start(&first, first_path[0]),
            initial_state(&old_root),
            interior(
                1,
                &first_key,
                first_before[1],
                first_nodes[1],
                &old_root,
                &first_bound
            ),
        ));
        assert!(check_step(
            &end(first_path[255]),
            interior(
                255,
                &first_key,
                first_before[255],
                first_nodes[255],
                &old_root,
                &first_bound
            ),
            final_state(&interim, &first_bound),
        ));
        assert!(check_step(
            &start(&second, second_path[0]),
            final_state(&interim, &first_bound),
            interior(
                1,
                &second_key,
                second_before[1],
                second_after[1],
                &interim,
                &second_bound
            ),
        ));
        let last_state = |root| {
            interior(
                255,
                &second_key,
                second_before[255],
                second_after[255],
                root,
                &second_bound,
            )
        };
        let want = final_state(&new_root, &second_bound);
        assert!(check_step(
            &end(second_path[255]),
            last_state(&interim),
            want
        ));
        assert!(!check_step(
            &end(second_path[255]),
            last_state(&old_root),
            want
        ));
    }

    #[test]
    fn linking_digest_binds_the_order_salt_and_outpoint_from_the_wire() {
        let [first, second] = rows();
        let expected = second.extend_row_binding(&first.extend_row_binding(&ZERO));
        let mut changed = second.clone();
        changed.vout += 1;
        let mut unsalted = second.clone();
        unsalted.salt[0] ^= 1;
        for (rows, valid) in [
            ([&first, &second], true),
            ([&second, &first], false),
            ([&first, &changed], false),
            ([&first, &unsalted], false),
        ] {
            let mut cs = TestConstraintSystem::<F>::new();
            let summaries = rows
                .into_iter()
                .enumerate()
                .map(|(i, row)| {
                    let mut bytes = [0; V1_SUMMARY_BYTES];
                    bytes[..32].copy_from_slice(&row.salt);
                    bytes[128..160].copy_from_slice(&row.txid);
                    bytes[160..164].copy_from_slice(&row.vout.to_le_bytes());
                    allocated(cs.namespace(|| format!("summary {i}")), &bytes)
                })
                .collect::<Vec<_>>();
            let binding = bind_summary_outpoints(
                cs.namespace(|| "main circuit binding"),
                &[&summaries[0], &summaries[1]],
            )
            .unwrap();
            enforce_same_bits(
                cs.namespace(|| "pin linking digest"),
                &binding,
                &constants(&expected),
            )
            .unwrap();
            assert_eq!(cs.is_satisfied(), valid);
        }
    }
}
