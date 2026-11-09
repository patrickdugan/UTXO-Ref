//! Statement parsing and policy, on the M16 guest's real block-170 statement (executed by the
//! guest, `m16/README.md`) and on mutations of it. No proof is involved here: `proof.rs` covers
//! the final-proof layer.
mod common;
use common::*;
use kan_payment_gate::policy::{GatePolicy, Network, RegisteredScript};
use kan_payment_gate::statement::{self, CHAIN_BYTES, STATEMENT_BYTES};
use kan_payment_gate::{sha256, Refusal};

fn st() -> Vec<u8> {
    fixture("m16-block170-statement.bin")
}

fn check(policy: &GatePolicy, bytes: &[u8]) -> Result<kan_payment_gate::policy::Accepted, Refusal> {
    statement::parse(bytes).and_then(|s| policy.check(&s))
}

fn reason<T: std::fmt::Debug>(r: Result<T, Refusal>) -> &'static str {
    r.unwrap_err().reason
}

#[test]
fn fixture_is_the_recorded_statement() {
    assert_eq!(hex::encode(sha256(&st())), "67a9deb95cb04d9d7fa7615d9aba45a2a0c95256a5d8e853191706c8b9a25c71");
}

#[test]
fn parses_block_170_payment() {
    let s = statement::parse(&st()).unwrap();
    assert_eq!(&s.magic, b"NHC1");
    assert_eq!((s.k, s.steps), (1, 800));
    assert_eq!(s.start.height, 0);
    assert_eq!(hex::encode(s.start.hash), Network::Mainnet.genesis_hash());
    assert_eq!(hex::encode(s.start.chainwork).trim_start_matches('0'), "100010001");
    assert_eq!(s.tip.height, 800);
    assert_eq!(hex::encode(s.tip.hash), "00000000def8545899ea7274e5c59bda5982f8f960052774df45b7d5c64f9c5d");
    let p = &s.payment;
    assert_eq!((p.segments, p.block_height, p.confirmations, p.vout, p.value_sats, p.script_len), (2, 170, 631, 0, 1_000_000_000, 67));
    assert_eq!(hex::encode(p.txid), "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16");
    assert_eq!(hex::encode(p.block_hash), "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee");
    assert_eq!(hex::encode(p.script_sha256), BLOCK170_SCRIPT_SHA256);
}

#[test]
fn genesis_pins_name_the_genesis_states() {
    // The mainnet pin is the block-170 statement's z0, which decodes to the genesis block.
    let s = statement::parse(&st()).unwrap();
    assert_eq!(hex::encode(sha256(&s.z0)), gate_pins("mainnet", "m16_chain_and_payment").genesis_z0_sha256);
    // The testnet4 pin is the z0 of m12's testnet4 bundle (consensus genesis state).
    assert_eq!(gate_pins("testnet4", "m16_chain_and_payment").genesis_z0_sha256, "9c82dffe8b6005378775c8f2028b7644039defadb0fcc1d77820b7aaced6de9c");
}

#[test]
fn accepts_block_170_payment() {
    let a = check(&block170_policy(), &st()).unwrap();
    assert_eq!(a.outpoint, "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16:0");
    assert_eq!((a.value_sats, a.confirmations, a.tip_height), (1_000_000_000, 631, 800));
    assert_eq!(a.script_id, "block-170-p2pk");
}

#[test]
fn statement_shape_refusals() {
    let b = st();
    assert_eq!(reason(statement::parse(&b[..CHAIN_BYTES])), "no_payment_record");
    assert_eq!(reason(statement::parse(&b[..STATEMENT_BYTES - 1])), "statement_length");
    assert_eq!(reason(statement::parse(&[b.clone(), vec![0]].concat())), "statement_length");
    assert_eq!(reason(statement::parse(&[])), "statement_length");

    let mut m = b.clone();
    m[CHAIN_BYTES] ^= 1;
    assert_eq!(reason(statement::parse(&m)), "payment_record_magic");

    // A tip height with bytes above the low four is not a committed state.
    let mut m = b.clone();
    m[12 + 544 + 8] = 1;
    assert_eq!(reason(statement::parse(&m)), "statement_state_encoding");

    // Confirmations that disagree with the tip and block heights.
    let mut m = b.clone();
    m[CHAIN_BYTES + 44] ^= 1;
    assert_eq!(reason(statement::parse(&m)), "statement_inconsistent");
    let mut m = b;
    m[CHAIN_BYTES + 44..CHAIN_BYTES + 48].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(reason(statement::parse(&m)), "statement_inconsistent");
}

#[test]
fn wrong_script() {
    let mut p = block170_policy();
    p.scripts[0].script_sha256 = hex::encode(sha256(b"a script the coordinator registered"));
    assert_eq!(reason(check(&p, &st())), "script_not_registered");
}

#[test]
fn too_few_confirmations() {
    let mut p = block170_policy();
    p.min_confirmations = 632;
    assert_eq!(reason(check(&p, &st())), "too_few_confirmations");
    p.min_confirmations = 631;
    check(&p, &st()).unwrap();
}

#[test]
fn wrong_genesis() {
    // The policy pins testnet4's genesis state while expecting mainnet.
    let mut p = block170_policy();
    p.pins.genesis_z0_sha256 = gate_pins("testnet4", "m16_chain_and_payment").genesis_z0_sha256;
    assert_eq!(reason(check(&p, &st())), "wrong_genesis");
    // A start state other than genesis (its block hash changed), under the right pin.
    let mut m = st();
    m[12 + 32] ^= 1;
    assert_eq!(reason(check(&block170_policy(), &m)), "wrong_genesis");
    // A policy pin that matches a non-genesis z0 still fails the genesis-hash check.
    let mut p = block170_policy();
    p.pins.genesis_z0_sha256 = hex::encode(sha256(&m[12..12 + 544]));
    assert_eq!(reason(check(&p, &m)), "wrong_genesis");
}

#[test]
fn wrong_network_and_key() {
    let mut p = block170_policy();
    p.network = Network::Testnet4;
    assert_eq!(reason(check(&p, &st())), "wrong_network");
    let mut p = block170_policy();
    p.pins.nova_vk_sha256 = gate_pins("testnet4", "m16_chain_and_payment").nova_vk_sha256;
    assert_eq!(reason(check(&p, &st())), "wrong_nova_key");
    let mut m = st();
    m[4] = 2;
    assert_eq!(reason(check(&block170_policy(), &m)), "wrong_fold_width");
}

#[test]
fn chainwork_floor() {
    let mut p = block170_policy();
    p.min_tip_chainwork = "32103210322".into();
    assert_eq!(reason(check(&p, &st())), "chainwork_below_floor");
    p.min_tip_chainwork = "0x0000032103210321".into();
    check(&p, &st()).unwrap();
}

#[test]
fn value_floor() {
    let mut p = block170_policy();
    p.scripts[0].min_value_sats = 1_000_000_001;
    assert_eq!(reason(check(&p, &st())), "value_below_policy");
}

#[test]
fn second_registered_script_is_found() {
    let mut p = block170_policy();
    p.scripts.insert(0, RegisteredScript { id: "other".into(), script_sha256: hex::encode([7u8; 32]), min_value_sats: 1 });
    assert_eq!(check(&p, &st()).unwrap().script_id, "block-170-p2pk");
}

#[test]
fn policy_file_validation() {
    let good = serde_json::to_value(block170_policy()).unwrap();
    GatePolicy::from_json(&good.to_string()).unwrap();
    let bad = |edit: &dyn Fn(&mut serde_json::Value)| {
        let mut v = good.clone();
        edit(&mut v);
        GatePolicy::from_json(&v.to_string()).unwrap_err().reason
    };
    assert_eq!(bad(&|v| v["pins"]["wrap_vk_sha256"] = "D42C".into()), "policy_invalid");
    assert_eq!(bad(&|v| v["pins"]["recursion_vk_root"] = serde_json::Value::from("ab".repeat(31))), "policy_invalid");
    assert_eq!(bad(&|v| v["scripts"][0]["script_sha256"] = serde_json::Value::from("AB".repeat(32))), "policy_invalid");
    assert_eq!(bad(&|v| v["min_confirmations"] = 0.into()), "policy_invalid");
    assert_eq!(bad(&|v| v["scripts"] = serde_json::json!([])), "policy_invalid");
    assert_eq!(bad(&|v| v["min_tip_chainwork"] = "zz".into()), "policy_invalid");
    assert_eq!(bad(&|v| v["extra"] = 1.into()), "policy_invalid");
    assert_eq!(bad(&|v| v["network"] = "signet".into()), "policy_invalid");
}
