//! kan-payment-gate: the check Custodian A's signer runs before releasing a payment-gated
//! signature.
//!
//!   kan-payment-gate check --proof WRAP.bin --statement STATEMENT.bin --policy GATE.json
//!       Verify the final proof, bind it to the statement, parse the statement, apply the policy.
//!       Prints one JSON line: {"status":"accepted",...} (exit 0) or {"status":"refused",...} (exit 1).
//!   kan-payment-gate inspect --statement STATEMENT.bin
//!       Parse a statement without a proof or policy and print its fields.
//!
//! Exit 2 is a usage or I/O error.
use kan_payment_gate::{policy::GatePolicy, proof, sha256, statement, Refusal};
use serde_json::json;

fn arg(args: &[String], name: &str) -> Result<String, String> {
    let i = args.iter().position(|a| a == name).ok_or(format!("missing {name}"))?;
    args.get(i + 1).cloned().ok_or(format!("{name} needs a value"))
}

fn read(path: &str, limit: usize) -> Result<Vec<u8>, String> {
    let len = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?.len();
    if len > limit as u64 {
        return Err(format!("{path}: {len} bytes, over the {limit}-byte limit"));
    }
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

fn refused(r: &Refusal) -> serde_json::Value {
    json!({"status": "refused", "reason": r.reason, "detail": r.detail})
}

fn check(args: &[String]) -> Result<serde_json::Value, String> {
    let proof_bytes = read(&arg(args, "--proof")?, proof::MAX_PROOF_BYTES + 1)?;
    let st_bytes = read(&arg(args, "--statement")?, statement::STATEMENT_BYTES + 1)?;
    let policy_text = String::from_utf8(read(&arg(args, "--policy")?, 1 << 20)?).map_err(|_| "policy is not UTF-8".to_string())?;
    let policy = match GatePolicy::from_json(&policy_text) {
        Ok(p) => p,
        Err(r) => return Ok(refused(&r)),
    };
    let fin = match proof::verify(&proof_bytes, &st_bytes, &policy.pins) {
        Ok(f) => f,
        Err(r) => return Ok(refused(&r)),
    };
    let accepted = match statement::parse(&st_bytes).and_then(|st| policy.check(&st)) {
        Ok(a) => a,
        Err(r) => return Ok(refused(&r)),
    };
    Ok(json!({
        "status": "accepted",
        "payment": accepted,
        "statement_sha256": fin.committed_values_sha256,
        "program_vk_digest": fin.program_vk_digest,
    }))
}

fn inspect(args: &[String]) -> Result<serde_json::Value, String> {
    let st_bytes = read(&arg(args, "--statement")?, statement::STATEMENT_BYTES + 1)?;
    let st = match statement::parse(&st_bytes) {
        Ok(s) => s,
        Err(r) => return Ok(refused(&r)),
    };
    let p = &st.payment;
    Ok(json!({
        "status": "parsed",
        "network": String::from_utf8_lossy(&st.magic),
        "k": st.k, "steps": st.steps,
        "start": {"height": st.start.height, "hash": hex::encode(st.start.hash), "chainwork": hex::encode(st.start.chainwork)},
        "tip": {"height": st.tip.height, "hash": hex::encode(st.tip.hash), "chainwork": hex::encode(st.tip.chainwork)},
        "z0_sha256": hex::encode(sha256(&st.z0)),
        "nova_vk_sha256": hex::encode(st.nova_vk_sha256),
        "payment": {
            "segments": p.segments, "block_height": p.block_height, "block_hash": hex::encode(p.block_hash),
            "confirmations": p.confirmations, "txid": hex::encode(p.txid), "vout": p.vout,
            "value_sats": p.value_sats, "script_bytes": p.script_len, "script_sha256": hex::encode(p.script_sha256),
        },
        "statement_sha256": hex::encode(sha256(&st_bytes)),
    }))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = match args.get(1).map(String::as_str) {
        Some("check") => check(&args),
        Some("inspect") => inspect(&args),
        _ => Err("usage: kan-payment-gate check --proof F --statement F --policy F | inspect --statement F".into()),
    };
    match out {
        Ok(v) => {
            println!("{v}");
            let ok = v["status"] == "accepted" || v["status"] == "parsed";
            std::process::exit(if ok { 0 } else { 1 });
        }
        Err(e) => {
            eprintln!("kan-payment-gate: {e}");
            std::process::exit(2);
        }
    }
}
