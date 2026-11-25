use std::fs::File;
use std::io::Read;

use ff::PrimeField;
use lnmarkets_nova::journal_binding::V1_JOURNAL_BYTES;
use lnmarkets_nova::proof_set::{
    verify_batch_proofs, verify_curve_proof, BatchProofs, BatchScalar, MAX_PROOF_BYTES,
};
use sha2::{Digest, Sha256};

fn main() {
    if let Err(error) = verify() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let [mode, rows, binding, proof] = args.as_slice() {
        if mode == "--curve" {
            let binding = parse_binding(binding)?;
            let proof = read_file(proof, MAX_PROOF_BYTES)?;
            verify_curve_proof(&proof, rows.parse()?, binding)?;
            println!(
                r#"{{"status":"nova_curve_proof_verified","proof_sha256":"{:x}"}}"#,
                Sha256::digest(proof)
            );
            return Ok(());
        }
    }
    let [journal_path, output_count, authorization_path, curve_path, nullifier_path] =
        args.as_slice()
    else {
        return Err(
            "usage: lnm-nova-verify JOURNAL OUTPUT_COUNT AUTH_PROOF CURVE_PROOF NULLIFIER_PROOF | --curve ROWS BINDING_HEX PROOF"
                .into(),
        );
    };
    let journal: [u8; V1_JOURNAL_BYTES] = read_file(journal_path, V1_JOURNAL_BYTES)?
        .try_into()
        .map_err(|_| "journal must be 276 bytes")?;
    let output_count = output_count.parse()?;
    let authorization = read_file(authorization_path, MAX_PROOF_BYTES)?;
    let curve = read_file(curve_path, MAX_PROOF_BYTES)?;
    let nullifier = read_file(nullifier_path, MAX_PROOF_BYTES)?;
    verify_batch_proofs(
        &journal,
        output_count,
        BatchProofs {
            authorization: &authorization,
            curve: &curve,
            nullifier: &nullifier,
        },
    )?;
    println!(
        concat!(
            r#"{{"status":"nova_batch_proof_verified","network":"bitcoin-regtest","#,
            r#""journal_sha256":"{:x}","authorization_sha256":"{:x}", "#,
            r#""curve_sha256":"{:x}","nullifier_sha256":"{:x}"}}"#
        ),
        Sha256::digest(journal),
        Sha256::digest(authorization),
        Sha256::digest(curve),
        Sha256::digest(nullifier),
    );
    Ok(())
}

fn parse_binding(encoded: &str) -> Result<BatchScalar, Box<dyn std::error::Error>> {
    let mut repr = <BatchScalar as PrimeField>::Repr::default();
    if encoded.len() != 2 * repr.as_ref().len()
        || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("curve binding must be a canonical 32-byte field encoding".into());
    }
    for (i, byte) in repr.as_mut().iter_mut().enumerate() {
        *byte = u8::from_str_radix(&encoded[2 * i..2 * i + 2], 16)?;
    }
    Option::from(BatchScalar::from_repr(repr))
        .ok_or_else(|| "curve binding is outside the proof field".into())
}

fn read_file(path: &str, limit: usize) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit as u64 {
        return Err("unexpected proof or journal file size or type".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() {
        return Err("proof or journal size changed during read".into());
    }
    Ok(bytes)
}
