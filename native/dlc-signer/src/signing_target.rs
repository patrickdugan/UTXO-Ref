//! MAIN-3: derive what the signer is allowed to sign.
//!
//! The request carries a signing context - the validated transaction set,
//! the CET's txid and the oracle announcements - instead of a bare sighash.
//! This module re-derives, independently of the host:
//!
//! - the CET-set and funding-template digests (which the validator-signed
//!   authorization payload must name),
//! - the two-party funding output from the party keys and refund delay
//!   (NUMS internal key, 2-of-2 CET leaf, CSV 2-of-2 refund leaf), which
//!   must equal the committed funding scriptPubKey,
//! - the BIP341 script-path sighash of the CET leaf for the named CET,
//! - the adaptor point: the sum of the outcome points of the CET's oracle
//!   subset, each from an announcement whose BIP340 signature verifies.
//!
//! It mirrors bitvm3/utxo_referee/dlc_funding_output.js,
//! dlc_signature_validator.js and dlc_signing_target.js. Both sides are
//! checked against tests/signing_target_vectors.json.

use k256::{
    AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar,
    elliptic_curve::{
        bigint::U256,
        ff::PrimeField,
        group::Group,
        ops::Reduce,
        sec1::{FromEncodedPoint, ToEncodedPoint},
    },
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{Result, canonical_json};

const NUMS_DOMAIN: &str = "UTXORef DLC funding NUMS internal key v1";
const LEAF_VERSION_TAPSCRIPT: u8 = 0xc0;
const ANNOUNCEMENT_KIND: &str = "tradelayer_dlc_oracle_announcement_v1";
const MAX_CETS: usize = 4096;
const MAX_ANNOUNCEMENTS: usize = 16;
const MAX_TX_BYTES: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningTarget {
    pub cet_txid: String,
    pub sighash: [u8; 32],
    pub adaptor_x: [u8; 32],
    pub adaptor_y: [u8; 32],
    pub cet_set_digest: String,
    pub funding_template_digest: String,
    pub oracle_announcements_digest: String,
    pub oracle_event_id: String,
    pub funding_script_pubkey: String,
    pub party_pubkeys: [String; 2],
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn tagged_hash(tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    let tag_hash = sha256(tag.as_bytes());
    let mut digest = Sha256::new();
    digest.update(tag_hash);
    digest.update(tag_hash);
    for part in parts {
        digest.update(part);
    }
    digest.finalize().into()
}

fn object<'a>(value: &'a Value, name: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{name} must be an object"))
}

fn field<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a Value> {
    object.get(name).ok_or_else(|| format!("{name} is required"))
}

fn string<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str> {
    field(object, name)?
        .as_str()
        .ok_or_else(|| format!("{name} must be a string"))
}

fn array<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a Vec<Value>> {
    field(object, name)?
        .as_array()
        .ok_or_else(|| format!("{name} must be an array"))
}

fn small_u64(object: &Map<String, Value>, name: &str) -> Result<u64> {
    let value = field(object, name)?
        .as_u64()
        .ok_or_else(|| format!("{name} must be a non-negative integer"))?;
    if value > 9_007_199_254_740_991 {
        return Err(format!("{name} exceeds the safe integer range"));
    }
    Ok(value)
}

fn lower_hex(value: &str, bytes: usize, name: &str) -> Result<Vec<u8>> {
    if value.len() != bytes * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{name} must be lowercase {bytes}-byte hex"));
    }
    hex::decode(value).map_err(|error| error.to_string())
}

fn hex32(value: &str, name: &str) -> Result<[u8; 32]> {
    lower_hex(value, 32, name)?
        .try_into()
        .map_err(|_| format!("{name} must contain 32 bytes"))
}

fn digest_hex(value: &Value) -> Result<String> {
    Ok(hex::encode(sha256(canonical_json(value)?.as_bytes())))
}

fn reduce(bytes: [u8; 32]) -> Scalar {
    <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(bytes))
}

/// BIP340 lift_x: the even-y point with this x coordinate.
fn lift_x(x: &[u8; 32]) -> Result<ProjectivePoint> {
    let mut encoded = [0u8; 33];
    encoded[0] = 0x02;
    encoded[1..].copy_from_slice(x);
    let encoded = EncodedPoint::from_bytes(encoded).map_err(|error| error.to_string())?;
    Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&encoded))
        .map(ProjectivePoint::from)
        .ok_or_else(|| "x coordinate is not on secp256k1".to_owned())
}

fn coordinates(point: ProjectivePoint) -> Result<([u8; 32], [u8; 32])> {
    if bool::from(point.is_identity()) {
        return Err("point at infinity".to_owned());
    }
    let encoded = AffinePoint::from(point).to_encoded_point(false);
    let x: [u8; 32] = encoded.x().ok_or("no x coordinate")?[..]
        .try_into()
        .map_err(|_| "malformed x coordinate".to_owned())?;
    let y: [u8; 32] = encoded.y().ok_or("no y coordinate")?[..]
        .try_into()
        .map_err(|_| "malformed y coordinate".to_owned())?;
    Ok((x, y))
}

pub fn schnorr_verify(public_x: &[u8; 32], message: &[u8; 32], signature: &[u8; 64]) -> bool {
    let Ok(public) = lift_x(public_x) else {
        return false;
    };
    let r: [u8; 32] = signature[..32].try_into().expect("32 bytes");
    let s_bytes: [u8; 32] = signature[32..].try_into().expect("32 bytes");
    let Some(s) = Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(s_bytes))) else {
        return false;
    };
    let e = reduce(tagged_hash("BIP0340/challenge", &[&r, public_x, message]));
    let point = ProjectivePoint::GENERATOR * s - public * e;
    match coordinates(point) {
        Ok((x, y)) => y[31] & 1 == 0 && x == r,
        Err(_) => false,
    }
}

fn compact_size(value: usize) -> Vec<u8> {
    match value {
        0..=0xfc => vec![value as u8],
        0xfd..=0xffff => {
            let mut bytes = vec![0xfd];
            bytes.extend_from_slice(&(value as u16).to_le_bytes());
            bytes
        }
        _ => {
            let mut bytes = vec![0xfe];
            bytes.extend_from_slice(&(value as u32).to_le_bytes());
            bytes
        }
    }
}

// ---- funding output (dlc_funding_output.js) ----

pub fn nums_internal_key() -> Result<[u8; 32]> {
    for counter in 0..1024u32 {
        let candidate = sha256(format!("{NUMS_DOMAIN}:{counter}").as_bytes());
        if lift_x(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("failed to derive the DLC funding NUMS internal key".to_owned())
}

fn push_script_num(value: u64) -> Vec<u8> {
    if value <= 16 {
        return vec![0x50 + value as u8];
    }
    let mut bytes = Vec::new();
    let mut remaining = value;
    while remaining > 0 {
        bytes.push((remaining & 0xff) as u8);
        remaining >>= 8;
    }
    if bytes.last().is_some_and(|last| last & 0x80 != 0) {
        bytes.push(0);
    }
    let mut script = vec![bytes.len() as u8];
    script.extend(bytes);
    script
}

fn two_of_two(first: &[u8; 32], second: &[u8; 32]) -> Vec<u8> {
    let mut script = vec![0x20];
    script.extend_from_slice(first);
    script.extend_from_slice(&[0xad, 0x20]);
    script.extend_from_slice(second);
    script.push(0xac);
    script
}

fn tap_leaf_hash(script: &[u8]) -> [u8; 32] {
    let mut data = vec![LEAF_VERSION_TAPSCRIPT];
    data.extend(compact_size(script.len()));
    data.extend_from_slice(script);
    tagged_hash("TapLeaf", &[&data])
}

fn tap_branch_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    if left <= right {
        tagged_hash("TapBranch", &[left, right])
    } else {
        tagged_hash("TapBranch", &[right, left])
    }
}

pub struct FundingOutput {
    pub script_pubkey: [u8; 34],
    pub cet_leaf_hash: [u8; 32],
    pub refund_leaf_hash: [u8; 32],
}

pub fn dlc_funding_output(party: &[[u8; 32]; 2], refund_csv_blocks: u64) -> Result<FundingOutput> {
    if party[0] >= party[1] {
        return Err("partyPubkeyXs must be two distinct keys in ascending order".to_owned());
    }
    for key in party {
        lift_x(key).map_err(|_| "a party key is not a valid x-only public key".to_owned())?;
    }
    if !(1..=0xffff).contains(&refund_csv_blocks) {
        return Err("refundCsvBlocks must be an integer in 1..65535".to_owned());
    }
    let internal = nums_internal_key()?;
    if party.contains(&internal) {
        return Err("a party key must not equal the NUMS internal key".to_owned());
    }
    let cet_script = two_of_two(&party[0], &party[1]);
    let mut refund_script = push_script_num(refund_csv_blocks);
    refund_script.extend_from_slice(&[0xb2, 0x75]);
    refund_script.extend(two_of_two(&party[0], &party[1]));
    let cet_leaf_hash = tap_leaf_hash(&cet_script);
    let refund_leaf_hash = tap_leaf_hash(&refund_script);
    let root = tap_branch_hash(&cet_leaf_hash, &refund_leaf_hash);
    let tweak = reduce(tagged_hash("TapTweak", &[&internal, &root]));
    let (output_x, _) = coordinates(lift_x(&internal)? + ProjectivePoint::GENERATOR * tweak)?;
    let mut script_pubkey = [0u8; 34];
    script_pubkey[0] = 0x51;
    script_pubkey[1] = 0x20;
    script_pubkey[2..].copy_from_slice(&output_x);
    Ok(FundingOutput {
        script_pubkey,
        cet_leaf_hash,
        refund_leaf_hash,
    })
}

// ---- transactions (dlc_transaction_validator.js / dlc_signature_validator.js) ----

struct UnsignedTransaction {
    version: u32,
    input_outpoint: [u8; 36],
    input_sequence: u32,
    outputs: Vec<(u64, Vec<u8>)>,
    locktime: u32,
    txid: String,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Reader<'_> {
    fn take(&mut self, length: usize) -> Result<&[u8]> {
        if self.bytes.len() - self.offset < length {
            return Err("truncated CET transaction".to_owned());
        }
        let slice = &self.bytes[self.offset..self.offset + length];
        self.offset += length;
        Ok(slice)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("4 bytes")))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().expect("8 bytes")))
    }
    fn compact(&mut self) -> Result<usize> {
        let prefix = self.take(1)?[0];
        let value = match prefix {
            0..=0xfc => prefix as u64,
            0xfd => {
                let value = u16::from_le_bytes(self.take(2)?.try_into().expect("2 bytes")) as u64;
                if value < 0xfd {
                    return Err("non-canonical CompactSize".to_owned());
                }
                value
            }
            0xfe => {
                let value = self.u32()? as u64;
                if value <= 0xffff {
                    return Err("non-canonical CompactSize".to_owned());
                }
                value
            }
            _ => return Err("CompactSize too large".to_owned()),
        };
        if value > MAX_TX_BYTES as u64 {
            return Err("CompactSize exceeds the transaction bound".to_owned());
        }
        Ok(value as usize)
    }
}

fn parse_unsigned_transaction(raw_hex: &str) -> Result<UnsignedTransaction> {
    if raw_hex.len() > MAX_TX_BYTES * 2 || raw_hex.len() % 2 != 0 {
        return Err("CET rawTxHex is not bounded even-length hex".to_owned());
    }
    let raw = lower_hex(raw_hex, raw_hex.len() / 2, "CET rawTxHex")?;
    let mut reader = Reader {
        bytes: &raw,
        offset: 0,
    };
    let version = reader.u32()?;
    if version != 2 && version != 3 {
        return Err("CET version must be 2 or 3".to_owned());
    }
    if reader.compact()? != 1 {
        return Err("CET must spend exactly one input".to_owned());
    }
    let input_outpoint: [u8; 36] = reader.take(36)?.try_into().expect("36 bytes");
    if reader.compact()? != 0 {
        return Err("CET input scriptSig must be empty".to_owned());
    }
    let input_sequence = reader.u32()?;
    let output_count = reader.compact()?;
    if output_count < 1 || output_count > 1000 {
        return Err("CET must contain 1..1000 outputs".to_owned());
    }
    let mut outputs = Vec::with_capacity(output_count);
    for _ in 0..output_count {
        let value = reader.u64()?;
        let length = reader.compact()?;
        outputs.push((value, reader.take(length)?.to_vec()));
    }
    let locktime = reader.u32()?;
    if reader.offset != raw.len() {
        return Err("CET transaction has trailing bytes".to_owned());
    }
    let mut txid = sha256(&sha256(&raw));
    txid.reverse();
    Ok(UnsignedTransaction {
        version,
        input_outpoint,
        input_sequence,
        outputs,
        locktime,
        txid: hex::encode(txid),
    })
}

/// BIP341 script-path signature hash, SIGHASH_DEFAULT, single input.
fn script_path_sighash(
    transaction: &UnsignedTransaction,
    funding_value: u64,
    funding_script_pubkey: &[u8; 34],
    leaf_hash: &[u8; 32],
) -> [u8; 32] {
    let sha_prevouts = sha256(&transaction.input_outpoint);
    let sha_amounts = sha256(&funding_value.to_le_bytes());
    let mut script_pubkeys = compact_size(funding_script_pubkey.len());
    script_pubkeys.extend_from_slice(funding_script_pubkey);
    let sha_script_pubkeys = sha256(&script_pubkeys);
    let sha_sequences = sha256(&transaction.input_sequence.to_le_bytes());
    let mut outputs = Vec::new();
    for (value, script) in &transaction.outputs {
        outputs.extend_from_slice(&value.to_le_bytes());
        outputs.extend(compact_size(script.len()));
        outputs.extend_from_slice(script);
    }
    let sha_outputs = sha256(&outputs);
    let mut preimage = vec![0x00, 0x00];
    preimage.extend_from_slice(&transaction.version.to_le_bytes());
    preimage.extend_from_slice(&transaction.locktime.to_le_bytes());
    preimage.extend_from_slice(&sha_prevouts);
    preimage.extend_from_slice(&sha_amounts);
    preimage.extend_from_slice(&sha_script_pubkeys);
    preimage.extend_from_slice(&sha_sequences);
    preimage.extend_from_slice(&sha_outputs);
    preimage.push(0x02);
    preimage.extend_from_slice(&0u32.to_le_bytes());
    preimage.extend_from_slice(leaf_hash);
    preimage.push(0x00);
    preimage.extend_from_slice(&[0xff; 4]);
    tagged_hash("TapSighash", &[&preimage])
}

// ---- oracle announcements (tradelayer_dlc_adaptor_sig.js) ----

fn length_prefixed(bytes: &[u8]) -> Result<Vec<u8>> {
    let length = u16::try_from(bytes.len()).map_err(|_| "field exceeds 65535 bytes".to_owned())?;
    let mut data = length.to_be_bytes().to_vec();
    data.extend_from_slice(bytes);
    Ok(data)
}

struct Announcement {
    event_id: String,
    px: [u8; 32],
    rx: [u8; 32],
    outcomes: Vec<[u8; 32]>,
}

fn verified_announcement(value: &Value, index: usize) -> Result<Announcement> {
    let name = format!("oracleAnnouncements[{index}]");
    let announcement = object(value, &name)?;
    if announcement.len() != 6 || string(announcement, "kind")? != ANNOUNCEMENT_KIND {
        return Err(format!("{name} has the wrong schema"));
    }
    let event_id = string(announcement, "eventId")?;
    if event_id.is_empty() || event_id.len() > 256 {
        return Err(format!("{name}.eventId must be 1..256 bytes"));
    }
    let px = hex32(string(announcement, "px")?, "announcement px")?;
    let rx = hex32(string(announcement, "rx")?, "announcement rx")?;
    let outcome_values = array(announcement, "outcomeMessages")?;
    if outcome_values.is_empty() || outcome_values.len() > 1024 {
        return Err(format!("{name}.outcomeMessages must be non-empty"));
    }
    let mut outcomes = Vec::with_capacity(outcome_values.len());
    let mut message = length_prefixed(event_id.as_bytes())?;
    message.extend_from_slice(&px);
    message.extend_from_slice(&rx);
    for outcome in outcome_values {
        let outcome = hex32(
            outcome.as_str().ok_or("outcome must be a string")?,
            "announcement outcome",
        )?;
        if outcomes.contains(&outcome) {
            return Err(format!("{name} outcomes must be unique"));
        }
        message.extend(length_prefixed(&outcome)?);
        outcomes.push(outcome);
    }
    let signature: [u8; 64] = lower_hex(string(announcement, "signature")?, 64, "announcement signature")?
        .try_into()
        .expect("64 bytes");
    let digest = tagged_hash("TradeLayer/dlc/oracle/announcement/v1", &[&message]);
    if !schnorr_verify(&px, &digest, &signature) {
        return Err(format!("{name} signature does not verify under its oracle key"));
    }
    Ok(Announcement {
        event_id: event_id.to_owned(),
        px,
        rx,
        outcomes,
    })
}

fn outcome_point(announcement: &Announcement, outcome: &[u8; 32]) -> Result<ProjectivePoint> {
    if !announcement.outcomes.contains(outcome) {
        return Err("CET outcome is not committed by the oracle announcement".to_owned());
    }
    let e = reduce(tagged_hash(
        "BIP0340/challenge",
        &[&announcement.rx, &announcement.px, outcome],
    ));
    Ok(lift_x(&announcement.rx)? + lift_x(&announcement.px)? * e)
}

// ---- derivation ----

/// Derive the signing target from `signingContext` alone.
pub fn derive_signing_target(signing_context: &Value) -> Result<SigningTarget> {
    let context = object(signing_context, "signingContext")?;
    if context.len() != 3 {
        return Err("signingContext must contain transactionSet, cetTxid and oracleAnnouncements".to_owned());
    }
    let transaction_set = object(field(context, "transactionSet")?, "transactionSet")?;
    let cet_txid = string(context, "cetTxid")?;
    hex32(cet_txid, "cetTxid")?;

    // Commitments the validator-signed payload names.
    let cets = array(transaction_set, "cets")?;
    if cets.is_empty() || cets.len() > MAX_CETS {
        return Err("transactionSet must contain 1..4096 CETs".to_owned());
    }
    let cet_set_digest = digest_hex(field(transaction_set, "cets")?)?;
    if string(transaction_set, "cetSetDigest")? != cet_set_digest {
        return Err("transactionSet cetSetDigest does not match its CETs".to_owned());
    }
    let funding_value = field(transaction_set, "funding")?;
    let funding_template_digest = digest_hex(funding_value)?;
    if string(transaction_set, "fundingTemplateDigest")? != funding_template_digest {
        return Err("transactionSet fundingTemplateDigest does not match its funding".to_owned());
    }

    // The funding output is re-derived, not taken on trust.
    let funding = object(funding_value, "funding")?;
    let party_values = array(funding, "partyPubkeyXs")?;
    if party_values.len() != 2 {
        return Err("funding.partyPubkeyXs must contain exactly two keys".to_owned());
    }
    let party_strings: Vec<&str> = party_values
        .iter()
        .map(|value| value.as_str().ok_or("party key must be a string"))
        .collect::<std::result::Result<_, _>>()?;
    let party = [
        hex32(party_strings[0], "partyPubkeyXs[0]")?,
        hex32(party_strings[1], "partyPubkeyXs[1]")?,
    ];
    let output = dlc_funding_output(&party, small_u64(funding, "refundCsvBlocks")?)?;
    let funding_script_pubkey = hex::encode(output.script_pubkey);
    if string(funding, "scriptPubKeyHex")? != funding_script_pubkey {
        return Err(
            "funding scriptPubKey is not the two-party DLC output for the committed party keys and refund delay"
                .to_owned(),
        );
    }
    if string(funding, "cetLeafHash")? != hex::encode(output.cet_leaf_hash)
        || string(funding, "refundLeafHash")? != hex::encode(output.refund_leaf_hash)
    {
        return Err("funding leaf hashes do not match the two-party output".to_owned());
    }
    let funding_value_sats: u64 = string(funding, "valueSats")?
        .parse()
        .map_err(|_| "funding.valueSats must be a decimal string".to_owned())?;
    let funding_txid = hex32(string(funding, "txid")?, "funding.txid")?;
    let funding_vout = small_u64(funding, "vout")?;
    let funding_vout = u32::try_from(funding_vout).map_err(|_| "funding.vout is out of range".to_owned())?;
    let mut funding_outpoint = [0u8; 36];
    funding_outpoint[..32].copy_from_slice(&funding_txid);
    funding_outpoint[..32].reverse();
    funding_outpoint[32..].copy_from_slice(&funding_vout.to_le_bytes());

    // The named CET must be in the committed set and spend the funding outpoint.
    let cet = cets
        .iter()
        .map(|value| object(value, "CET"))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .find(|cet| cet.get("txid").and_then(Value::as_str) == Some(cet_txid))
        .ok_or_else(|| "signing context CET is absent from the committed CET set".to_owned())?;
    let transaction = parse_unsigned_transaction(string(cet, "rawTxHex")?)?;
    if transaction.txid != cet_txid {
        return Err("CET rawTxHex does not hash to the named txid".to_owned());
    }
    if transaction.input_outpoint != funding_outpoint {
        return Err("CET does not spend the committed funding outpoint".to_owned());
    }
    let sighash = script_path_sighash(
        &transaction,
        funding_value_sats,
        &output.script_pubkey,
        &output.cet_leaf_hash,
    );

    // Adaptor point from the announcements of the CET's oracle subset.
    let announcement_values = field(context, "oracleAnnouncements")?
        .as_array()
        .ok_or("oracleAnnouncements must be an array")?;
    if announcement_values.len() < 2 || announcement_values.len() > MAX_ANNOUNCEMENTS {
        return Err("oracleAnnouncements must contain 2..16 announcements".to_owned());
    }
    let oracle_announcements_digest = digest_hex(field(context, "oracleAnnouncements")?)?;
    let announcements = announcement_values
        .iter()
        .enumerate()
        .map(|(index, value)| verified_announcement(value, index))
        .collect::<Result<Vec<_>>>()?;
    if announcements.windows(2).any(|pair| pair[0].px >= pair[1].px) {
        return Err("oracleAnnouncements must be sorted by distinct oracle key".to_owned());
    }
    if announcements
        .iter()
        .any(|a| a.event_id != announcements[0].event_id || a.outcomes != announcements[0].outcomes)
    {
        return Err("oracle announcements must commit to the same event and ordered outcome set".to_owned());
    }
    let outcome = hex32(string(cet, "outcomeMessage")?, "CET outcomeMessage")?;
    let subset = array(cet, "oraclePubkeys")?;
    if subset.len() < 2 {
        return Err("CET oracle subset must contain at least two oracles".to_owned());
    }
    let mut previous: Option<[u8; 32]> = None;
    let mut adaptor = ProjectivePoint::IDENTITY;
    for key in subset {
        let key = hex32(key.as_str().ok_or("oracle key must be a string")?, "CET oracle key")?;
        if previous.is_some_and(|previous| previous >= key) {
            return Err("CET oracle subset must be sorted and unique".to_owned());
        }
        previous = Some(key);
        let announcement = announcements
            .iter()
            .find(|announcement| announcement.px == key)
            .ok_or_else(|| "CET oracle is not in the announcement set".to_owned())?;
        adaptor += outcome_point(announcement, &outcome)?;
    }
    let (adaptor_x, adaptor_y) = coordinates(adaptor)
        .map_err(|_| "combined oracle outcome point is infinity".to_owned())?;

    Ok(SigningTarget {
        cet_txid: cet_txid.to_owned(),
        sighash,
        adaptor_x,
        adaptor_y,
        cet_set_digest,
        funding_template_digest,
        oracle_announcements_digest,
        oracle_event_id: announcements[0].event_id.clone(),
        funding_script_pubkey,
        party_pubkeys: [party_strings[0].to_owned(), party_strings[1].to_owned()],
    })
}

/// Derive the target from the request's signing context and require the
/// validator-signed payload (and the request's claimed values) to name
/// exactly that target, for a signer that is a funding party.
pub fn verify_signing_target(
    request: &Map<String, Value>,
    payload: &Map<String, Value>,
) -> Result<SigningTarget> {
    let target = derive_signing_target(field(request, "signingContext")?)?;
    let signer = string(payload, "signerPubkeyX")?;
    if !target.party_pubkeys.iter().any(|party| party == signer) {
        return Err("signer is not a party to the two-party DLC funding output".to_owned());
    }
    let sighash = hex::encode(target.sighash);
    let expected = [
        ("cetTxid", target.cet_txid.as_str()),
        ("cetSetDigest", target.cet_set_digest.as_str()),
        ("fundingTemplateDigest", target.funding_template_digest.as_str()),
        ("oracleAnnouncementsDigest", target.oracle_announcements_digest.as_str()),
        // The event the contract's oracle policy names: announcements for any
        // other event by the same oracles must not be signed against.
        ("oracleEventId", target.oracle_event_id.as_str()),
        ("sighash", sighash.as_str()),
    ];
    for (name, value) in expected {
        if string(payload, name)? != value || string(request, name)? != value {
            return Err(format!("signed {name} differs from the value derived from the signing context"));
        }
    }
    let adaptor_x = hex::encode(target.adaptor_x);
    let adaptor_y = hex::encode(target.adaptor_y);
    for source in [payload, request] {
        let point = object(field(source, "adaptorPoint")?, "adaptorPoint")?;
        if string(point, "x")? != adaptor_x || string(point, "y")? != adaptor_y {
            return Err("signed adaptor point differs from the oracle outcome point of the CET".to_owned());
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/signing_target_vectors.json")).expect("vector JSON")
    }

    fn valid_case() -> (Value, Map<String, Value>) {
        let vectors = vectors();
        let case = vectors["valid"].clone();
        let expected = case["expected"].as_object().expect("expected").clone();
        (case["signingContext"].clone(), expected)
    }

    #[test]
    fn nums_key_matches_host() {
        let (_, expected) = valid_case();
        assert_eq!(
            hex::encode(nums_internal_key().unwrap()),
            expected["internalXonly"].as_str().unwrap()
        );
    }

    #[test]
    fn derives_the_host_signing_target() {
        let (context, expected) = valid_case();
        let target = derive_signing_target(&context).unwrap();
        assert_eq!(hex::encode(target.sighash), expected["sighash"].as_str().unwrap());
        assert_eq!(hex::encode(target.adaptor_x), expected["adaptorPoint"]["x"].as_str().unwrap());
        assert_eq!(hex::encode(target.adaptor_y), expected["adaptorPoint"]["y"].as_str().unwrap());
        assert_eq!(target.cet_set_digest, expected["cetSetDigest"].as_str().unwrap());
        assert_eq!(target.funding_template_digest, expected["fundingTemplateDigest"].as_str().unwrap());
        assert_eq!(
            target.oracle_announcements_digest,
            expected["oracleAnnouncementsDigest"].as_str().unwrap()
        );
        assert_eq!(target.oracle_event_id, expected["oracleEventId"].as_str().unwrap());
        assert_eq!(target.funding_script_pubkey, expected["scriptPubKeyHex"].as_str().unwrap());
    }

    #[test]
    fn every_negative_vector_is_rejected() {
        let vectors = vectors();
        for case in vectors["invalid"].as_array().unwrap() {
            let error = derive_signing_target(&case["signingContext"])
                .expect_err(case["name"].as_str().unwrap());
            let fragment = case["errorContains"].as_str().unwrap();
            assert!(error.contains(fragment), "{}: {error}", case["name"]);
        }
    }

    #[test]
    fn payload_must_name_the_derived_target() {
        let vectors = vectors();
        let case = &vectors["valid"];
        let request = case["request"].as_object().unwrap().clone();
        let payload = case["payload"].as_object().unwrap().clone();
        verify_signing_target(&request, &payload).unwrap();

        let mut other_event = payload.clone();
        other_event.insert("oracleEventId".to_owned(), Value::String("some-other-event".to_owned()));
        assert!(verify_signing_target(&request, &other_event).is_err());

        let mut wrong_sighash = payload.clone();
        wrong_sighash.insert("sighash".to_owned(), Value::String("00".repeat(32)));
        assert!(verify_signing_target(&request, &wrong_sighash).is_err());

        let mut wrong_point = payload.clone();
        wrong_point.insert(
            "adaptorPoint".to_owned(),
            serde_json::json!({ "x": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                                "y": "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8" }),
        );
        assert!(verify_signing_target(&request, &wrong_point).is_err());

        let mut outsider = payload.clone();
        outsider.insert(
            "signerPubkeyX".to_owned(),
            Value::String("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5".to_owned()),
        );
        assert!(verify_signing_target(&request, &outsider).is_err());
    }
}
