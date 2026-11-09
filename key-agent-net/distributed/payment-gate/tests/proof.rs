//! The final-proof layer, on a real final proof: guest A's (nova-bitvm3 `m13/fixtures`,
//! testnet4 heights 0–4 from genesis, chain record only). Guest A is a different program from
//! M16, which lets one real proof exercise every proof-layer refusal.
#![cfg(feature = "verify")]
mod common;
use common::*;
use kan_payment_gate::proof::{self, MAX_PROOF_BYTES};

fn a_proof() -> Vec<u8> {
    fixture("guest-a-wrap-blake3-v2.bin")
}

fn a_digest() -> String {
    pins()["programs"]["guest_a_chain_only"]["committed_values_sha256"].as_str().unwrap().to_string()
}

#[test]
fn guest_a_proof_verifies_under_its_own_pins() {
    let got = proof::verify_digest(&a_proof(), &a_digest(), &gate_pins("testnet4", "guest_a_chain_only")).unwrap();
    assert_eq!(got.program_vk_digest, "5df3760fed1620671151183a73c9407d528b2239a5cd243b14cf5c7b4d4af46b");
    assert_eq!((got.exit_code, got.is_complete), (0, 1));
}

#[test]
fn valid_proof_bound_to_other_statement_bytes() {
    // The STARK passes; the M16 statement is not what guest A committed.
    let r = proof::verify(&a_proof(), &fixture("m16-block170-statement.bin"), &gate_pins("testnet4", "guest_a_chain_only"));
    assert_eq!(r.unwrap_err().reason, "statement_digest_mismatch");
}

#[test]
fn valid_proof_of_another_program() {
    let r = proof::verify_digest(&a_proof(), &a_digest(), &gate_pins("mainnet", "m16_chain_and_payment"));
    assert_eq!(r.unwrap_err().reason, "proof_wrong_program");
}

#[test]
fn wrap_key_and_recursion_root_pins() {
    let mut pins = gate_pins("testnet4", "guest_a_chain_only");
    pins.recursion_vk_root = "00".repeat(32);
    assert_eq!(proof::verify_digest(&a_proof(), &a_digest(), &pins).unwrap_err().reason, "proof_recursion_root");
    let mut pins = gate_pins("testnet4", "guest_a_chain_only");
    pins.wrap_vk_sha256 = "00".repeat(32);
    assert_eq!(proof::verify_digest(&a_proof(), &a_digest(), &pins).unwrap_err().reason, "proof_wrap_key");
}

#[test]
fn tampered_proof() {
    let pins = gate_pins("testnet4", "guest_a_chain_only");
    let mut p = a_proof();
    let mid = p.len() / 2;
    p[mid] ^= 1;
    assert_eq!(proof::verify_digest(&p, &a_digest(), &pins).unwrap_err().reason, "proof_rejected");
}

#[test]
fn malformed_and_oversized_proofs() {
    let pins = gate_pins("testnet4", "guest_a_chain_only");
    let p = a_proof();
    assert_eq!(proof::verify_digest(&p[..p.len() - 1], &a_digest(), &pins).unwrap_err().reason, "proof_malformed");
    assert_eq!(proof::verify_digest(&[], &a_digest(), &pins).unwrap_err().reason, "proof_malformed");
    assert_eq!(proof::verify_digest(&[p.clone(), vec![0]].concat(), &a_digest(), &pins).unwrap_err().reason, "proof_malformed");
    assert_eq!(proof::verify_digest(&vec![0u8; MAX_PROOF_BYTES + 1], &a_digest(), &pins).unwrap_err().reason, "proof_too_large");
}
