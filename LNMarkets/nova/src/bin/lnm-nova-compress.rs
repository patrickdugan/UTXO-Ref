use std::io::{self, BufReader, BufWriter, Read, Write};
use std::time::Instant;

use ff::Field;
use lnmarkets_nova::authorization::step::{AuthorizationLayout, AuthorizationStep};
use lnmarkets_nova::nullifier_batch::BatchNullifierStep;
use lnmarkets_nova::proof_set::{proof_parameters, BatchScalar, CompressedProof, RecursiveProof};
use lnmarkets_nova::secp256k1::fold::CurveStep;
use lnmarkets_nova::settlement_amounts::SettlementAmountStep;
use nova_snark::traits::circuit::StepCircuit;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(feature = "gpu") {
        return Err("build lnm-nova-compress without the gpu feature".into());
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [stage] if stage == "curve" => compress(&CurveStep::<BatchScalar>::blank()),
        [stage] if stage == "nullifier" => compress(&BatchNullifierStep::default()),
        [stage] if stage == "settlement-amounts" => compress(&SettlementAmountStep {
            collateral: 0,
            trader: 0,
            maker: 0,
            anchor: 0,
            fee: 0,
        }),
        [stage, rows, transaction_size] if stage == "authorization" => {
            let layout =
                AuthorizationLayout::from_transaction_size(rows.parse()?, transaction_size.parse()?)?;
            compress(&AuthorizationStep::blank(layout))
        }
        _ => Err("usage: lnm-nova-compress {curve | nullifier | settlement-amounts | authorization ROWS TRANSACTION_BYTES}".into()),
    }
}

fn compress<C: StepCircuit<BatchScalar>>(circuit: &C) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    // The local GPU parent owns this pipe. It carries the uncompressed
    // fold, which must stay private even after successful compression.
    let mut input = BufReader::new(io::stdin().lock());
    let config = bincode::config::standard();
    let (count, initial, expected, folded): (
        usize,
        Vec<BatchScalar>,
        Vec<BatchScalar>,
        RecursiveProof<C>,
    ) = bincode::serde::decode_from_std_read(&mut input, config)?;
    if count == 0 || initial.len() != circuit.arity() || expected.len() != circuit.arity() {
        return Err("invalid recursive compression input".into());
    }
    if input.read(&mut [0u8; 1])? != 0 {
        return Err("trailing bytes in recursive compression input".into());
    }
    eprintln!("Preparing CPU compression parameters");
    let params = proof_parameters(circuit)?;
    if folded.verify(&params, count, &initial)? != expected {
        return Err("GPU fold differs from its expected public output".into());
    }
    let (key, verifier) = CompressedProof::<C>::setup(&params)?;
    eprintln!(
        "Compressing on CPU after {:.1}s",
        started.elapsed().as_secs_f64()
    );
    let proof = CompressedProof::<C>::prove(&params, &key, &folded)?;
    if proof.verify(&verifier, count, &initial)? != expected {
        return Err("CPU compression changed the public output".into());
    }
    let mut changed = initial;
    changed[0] += BatchScalar::ONE;
    if proof.verify(&verifier, count, &changed).is_ok() {
        return Err("compressed proof accepted altered public input".into());
    }
    eprintln!(
        "Verified CPU-compressed proof after {:.1}s",
        started.elapsed().as_secs_f64()
    );
    let mut output = BufWriter::new(io::stdout().lock());
    bincode::serde::encode_into_std_write(&proof, &mut output, config)?;
    output.flush()?;
    Ok(())
}
