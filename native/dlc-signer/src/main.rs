#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
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
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const PROCESS_REQUEST_KIND: &str = "utxoref_dlc_native_signer_process_request_v1";
const PROCESS_RESPONSE_KIND: &str = "utxoref_dlc_native_signer_process_response_v1";
const SIGN_REQUEST_KIND: &str = "utxoref_dlc_native_adaptor_sign_request_v1";
const AUTHORIZATION_KIND: &str = "utxoref_dlc_adaptor_sign_authorization_v2";
const PRESIGNATURE_KIND: &str = "tradelayer_dlc_adaptor_presig_v1";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

type Result<T> = std::result::Result<T, String>;

#[derive(Serialize)]
struct Presignature {
    kind: &'static str,
    rx: String,
    s0: String,
    #[serde(rename = "R0x")]
    r0x: String,
    #[serde(rename = "R0y")]
    r0y: String,
    #[serde(rename = "Tx")]
    tx: String,
    #[serde(rename = "Ty")]
    ty: String,
}

fn canonical_json(value: &Value) -> Result<String> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(if *value { "true" } else { "false" }.to_owned()),
        Value::String(value) => serde_json::to_string(value).map_err(|error| error.to_string()),
        Value::Number(value) => {
            const MAX_SAFE: u64 = 9_007_199_254_740_991;
            if let Some(unsigned) = value.as_u64() {
                if unsigned > MAX_SAFE {
                    return Err("JSON integer exceeds JavaScript safe range".to_owned());
                }
                Ok(unsigned.to_string())
            } else if let Some(signed) = value.as_i64() {
                if signed.unsigned_abs() > MAX_SAFE {
                    return Err("JSON integer exceeds JavaScript safe range".to_owned());
                }
                Ok(signed.to_string())
            } else {
                Err("floating-point JSON values are forbidden".to_owned())
            }
        }
        Value::Array(values) => {
            let encoded = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("[{}]", encoded.join(",")))
        }
        Value::Object(values) => {
            let sorted: BTreeMap<&String, &Value> = values.iter().collect();
            let encoded = sorted
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|error| error.to_string())?,
                        canonical_json(value)?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("{{{}}}", encoded.join(",")))
        }
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(sha256(bytes))
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

fn string<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str> {
    object
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} must be a string"))
}

fn safe_u64(object: &Map<String, Value>, name: &str) -> Result<u64> {
    let value = object
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{name} must be a non-negative integer"))?;
    if value > 9_007_199_254_740_991 {
        return Err(format!("{name} exceeds the safe integer range"));
    }
    Ok(value)
}

fn decode_hex_32(value: &str, name: &str) -> Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{name} must be lowercase 32-byte hex"));
    }
    let decoded = hex::decode(value).map_err(|error| error.to_string())?;
    decoded
        .try_into()
        .map_err(|_| format!("{name} must contain 32 bytes"))
}

fn scalar_from_bytes(bytes: [u8; 32], name: &str) -> Result<Scalar> {
    let scalar = Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(bytes)))
        .ok_or_else(|| format!("{name} is outside the secp256k1 scalar field"))?;
    if bool::from(scalar.is_zero()) {
        return Err(format!("{name} must be nonzero"));
    }
    Ok(scalar)
}

fn reduce_scalar(bytes: [u8; 32]) -> Scalar {
    <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(bytes))
}

fn affine_coordinates(point: ProjectivePoint, name: &str) -> Result<([u8; 32], [u8; 32])> {
    if bool::from(point.is_identity()) {
        return Err(format!("{name} is the point at infinity"));
    }
    let encoded = AffinePoint::from(point).to_encoded_point(false);
    let x_bytes = encoded
        .x()
        .ok_or_else(|| format!("{name} has no x coordinate"))?;
    let x: [u8; 32] = x_bytes[..]
        .try_into()
        .map_err(|_| format!("{name} x coordinate is malformed"))?;
    let y_bytes = encoded
        .y()
        .ok_or_else(|| format!("{name} has no y coordinate"))?;
    let y: [u8; 32] = y_bytes[..]
        .try_into()
        .map_err(|_| format!("{name} y coordinate is malformed"))?;
    Ok((x, y))
}

fn parse_point(x: &str, y: &str) -> Result<ProjectivePoint> {
    let x = decode_hex_32(x, "adaptorPoint.x")?;
    let y = decode_hex_32(y, "adaptorPoint.y")?;
    let mut encoded = [0u8; 65];
    encoded[0] = 4;
    encoded[1..33].copy_from_slice(&x);
    encoded[33..].copy_from_slice(&y);
    let encoded = EncodedPoint::from_bytes(encoded).map_err(|error| error.to_string())?;
    let point = Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&encoded))
        .ok_or_else(|| "adaptor point is not on secp256k1".to_owned())?;
    Ok(ProjectivePoint::from(point))
}

fn challenge(rx: &[u8; 32], px: &[u8; 32], message: &[u8; 32]) -> Scalar {
    reduce_scalar(tagged_hash("BIP0340/challenge", &[rx, px, message]))
}

fn adaptor_sign(
    secret_bytes: [u8; 32],
    message: [u8; 32],
    adaptor_x: &str,
    adaptor_y: &str,
) -> Result<Presignature> {
    let mut secret = scalar_from_bytes(secret_bytes, "signer secret")?;
    let public_point = ProjectivePoint::GENERATOR * secret;
    let (public_x, public_y) = affine_coordinates(public_point, "signer public key")?;
    if public_y[31] & 1 == 1 {
        secret = -secret;
    }
    let mut auxiliary = [0u8; 32];
    OsRng.fill_bytes(&mut auxiliary);
    let aux_hash = tagged_hash("BIP0340/aux", &[&auxiliary]);
    let mut tbase = secret.to_bytes();
    for (left, right) in tbase.iter_mut().zip(aux_hash) {
        *left ^= right;
    }
    auxiliary.zeroize();
    let adaptor_point = parse_point(adaptor_x, adaptor_y)?;
    let (tx, ty) = affine_coordinates(adaptor_point, "adaptor point")?;
    let compressed_prefix = if ty[31] & 1 == 0 { 0x02 } else { 0x03 };
    let mut compressed_adaptor = [0u8; 33];
    compressed_adaptor[0] = compressed_prefix;
    compressed_adaptor[1..].copy_from_slice(&tx);

    for counter in 0u8..64 {
        let nonce_hash = tagged_hash(
            "TradeLayer/dlc/adaptor/nonce",
            &[
                &tbase[..],
                &public_x,
                &message,
                &compressed_adaptor,
                &[counter],
            ],
        );
        let nonce = reduce_scalar(nonce_hash);
        if bool::from(nonce.is_zero()) {
            continue;
        }
        let r0_point = ProjectivePoint::GENERATOR * nonce;
        let effective_point = r0_point + adaptor_point;
        if bool::from(effective_point.is_identity()) {
            continue;
        }
        let (rx, ry) = affine_coordinates(effective_point, "effective nonce")?;
        if ry[31] & 1 == 1 {
            continue;
        }
        let (r0x, r0y) = affine_coordinates(r0_point, "nonce point")?;
        let response = nonce + challenge(&rx, &public_x, &message) * secret;
        tbase.zeroize();
        secret.zeroize();
        return Ok(Presignature {
            kind: PRESIGNATURE_KIND,
            rx: hex::encode(rx),
            s0: hex::encode(response.to_bytes()),
            r0x: hex::encode(r0x),
            r0y: hex::encode(r0y),
            tx: hex::encode(tx),
            ty: hex::encode(ty),
        });
    }
    tbase.zeroize();
    secret.zeroize();
    Err("failed to derive an even-y adaptor nonce".to_owned())
}

fn ed25519_public_from_spki(value: &str) -> Result<(VerifyingKey, String)> {
    let decoded = BASE64.decode(value).map_err(|error| error.to_string())?;
    if decoded.len() != 44 || decoded[..12] != ED25519_SPKI_PREFIX {
        return Err("validator public key is not canonical Ed25519 SPKI".to_owned());
    }
    let key: [u8; 32] = decoded[12..]
        .try_into()
        .map_err(|_| "validator Ed25519 key is malformed".to_owned())?;
    let verifying_key = VerifyingKey::from_bytes(&key).map_err(|error| error.to_string())?;
    Ok((verifying_key, sha256_hex(&decoded)))
}

fn read_secret_file(path: &Path, name: &str) -> Result<Zeroizing<String>> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("{name}: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 {
        return Err(format!("{name} must be a small regular non-symlink file"));
    }
    let value =
        Zeroizing::new(fs::read_to_string(path).map_err(|error| format!("{name}: {error}"))?);
    Ok(value)
}

fn load_validator_policy(path: &Path, expected_digest: &str) -> Result<Vec<String>> {
    decode_hex_32(expected_digest, "validator policy digest")?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("validator policy: {error}"))?;
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 65_536
    {
        return Err(
            "validator policy must be a bounded absolute regular non-symlink file".to_owned(),
        );
    }
    let bytes = fs::read(path).map_err(|error| format!("validator policy: {error}"))?;
    if sha256_hex(&bytes) != expected_digest {
        return Err("validator policy digest differs from the audited launch argument".to_owned());
    }
    let policy: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if canonical_json(&policy)?.as_bytes() != bytes {
        return Err("validator policy is not canonical JSON".to_owned());
    }
    let policy_object = object(&policy, "validator policy")?;
    if policy_object.len() != 2
        || string(policy_object, "kind")? != "utxoref_dlc_native_validator_policy_v1"
    {
        return Err("validator policy schema is invalid".to_owned());
    }
    let ids = policy_object
        .get("validatorKeyIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "validator policy validatorKeyIds must be an array".to_owned())?;
    if ids.is_empty() || ids.len() > 16 {
        return Err("validator policy must pin between 1 and 16 validators".to_owned());
    }
    let mut normalized = Vec::with_capacity(ids.len());
    for value in ids {
        let id = value
            .as_str()
            .ok_or_else(|| "validator policy key IDs must be strings".to_owned())?;
        decode_hex_32(id, "validator policy key ID")?;
        if id != id.to_ascii_lowercase() {
            return Err("validator policy key IDs must be lowercase hex".to_owned());
        }
        normalized.push(id.to_owned());
    }
    if normalized.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err("validator policy key IDs must be sorted and unique".to_owned());
    }
    Ok(normalized)
}

fn verify_request(
    request: &Value,
    pinned_validator_key_ids: &[String],
) -> Result<(String, [u8; 32], String, String, String)> {
    let request_object = object(request, "request")?;
    if string(request_object, "kind")? != SIGN_REQUEST_KIND {
        return Err("wrong native adaptor signing request kind".to_owned());
    }
    if request_object.contains_key("secret") || request_object.contains_key("keyHandle") {
        return Err("host-supplied secrets and key handles are forbidden".to_owned());
    }
    let authorization = request_object
        .get("authorization")
        .ok_or_else(|| "authorization is required".to_owned())?;
    let authorization_object = object(authorization, "authorization")?;
    if string(authorization_object, "kind")? != AUTHORIZATION_KIND {
        return Err("wrong adaptor signing authorization kind".to_owned());
    }
    let payload_bytes = BASE64
        .decode(string(request_object, "authorizationPayload")?)
        .map_err(|error| error.to_string())?;
    let payload: Value =
        serde_json::from_slice(&payload_bytes).map_err(|error| error.to_string())?;
    if canonical_json(&payload)?.as_bytes() != payload_bytes {
        return Err("authorization payload is not canonical JSON".to_owned());
    }
    let payload_object = object(&payload, "authorization payload")?;
    if string(payload_object, "kind")? != AUTHORIZATION_KIND {
        return Err("wrong signed authorization kind".to_owned());
    }
    for name in [
        "contractId",
        "contractDigest",
        "stateRecordHash",
        "transcriptHash",
        "cetSetDigest",
        "network",
        "stage",
        "signerPubkeyX",
        "sighash",
    ] {
        if string(payload_object, name)? != string(request_object, name)? {
            return Err(format!("signed {name} differs from native request"));
        }
    }
    if safe_u64(payload_object, "revision")? != safe_u64(request_object, "revision")? {
        return Err("signed revision differs from native request".to_owned());
    }
    if string(payload_object, "authorizationId")?
        != string(authorization_object, "authorizationId")?
        || string(payload_object, "stateRecordHash")?
            != string(authorization_object, "stateRecordHash")?
        || string(payload_object, "signerPubkeyX")?
            != string(authorization_object, "signerPubkeyX")?
        || string(payload_object, "sighash")? != string(authorization_object, "sighash")?
    {
        return Err("authorization object differs from its signed payload".to_owned());
    }
    let payload_point = object(
        payload_object
            .get("adaptorPoint")
            .ok_or_else(|| "signed adaptorPoint is required".to_owned())?,
        "signed adaptorPoint",
    )?;
    let request_point = object(
        request_object
            .get("adaptorPoint")
            .ok_or_else(|| "request adaptorPoint is required".to_owned())?,
        "request adaptorPoint",
    )?;
    let authorization_point = object(
        authorization_object
            .get("adaptorPoint")
            .ok_or_else(|| "authorization adaptorPoint is required".to_owned())?,
        "authorization adaptorPoint",
    )?;
    for coordinate in ["x", "y"] {
        let expected = string(payload_point, coordinate)?;
        if expected != string(request_point, coordinate)?
            || expected != string(authorization_point, coordinate)?
        {
            return Err(format!(
                "adaptor point {coordinate} differs from signed authorization"
            ));
        }
    }
    let (validator, validator_key_id) =
        ed25519_public_from_spki(string(request_object, "validatorPublicKeySpki")?)?;
    if pinned_validator_key_ids
        .binary_search(&validator_key_id)
        .is_err()
    {
        return Err("validator identity is not pinned by the audited signer policy".to_owned());
    }
    if string(authorization_object, "validatorKeyId")? != validator_key_id {
        return Err("authorization validator key ID differs from its public key".to_owned());
    }
    let signature_bytes = BASE64
        .decode(string(authorization_object, "signature")?)
        .map_err(|error| error.to_string())?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| error.to_string())?;
    validator
        .verify(&payload_bytes, &signature)
        .map_err(|_| "validator authorization signature is invalid".to_owned())?;
    let authorization_digest = sha256_hex(canonical_json(authorization)?.as_bytes());
    if authorization_digest != string(request_object, "authorizationDigest")? {
        return Err("authorization digest mismatch".to_owned());
    }
    if string(payload_object, "stage")? != "COUNTERPARTY_SIGNATURES_VERIFIED" {
        return Err("authorization stage is not signable".to_owned());
    }
    Ok((
        string(request_object, "signerPubkeyX")?.to_owned(),
        decode_hex_32(string(request_object, "sighash")?, "sighash")?,
        string(request_point, "x")?.to_owned(),
        string(request_point, "y")?.to_owned(),
        authorization_digest,
    ))
}

fn consume_authorization(key_directory: &Path, authorization_digest: &str) -> Result<()> {
    decode_hex_32(authorization_digest, "authorization digest")?;
    let consumed_directory = key_directory.join("consumed-authorizations");
    match fs::create_dir(&consumed_directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("could not create signer replay store: {error}")),
    }
    let metadata = fs::symlink_metadata(&consumed_directory)
        .map_err(|error| format!("could not inspect signer replay store: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("signer replay store must be a regular non-symlink directory".to_owned());
    }
    let marker_path = consumed_directory.join(format!("{authorization_digest}.used"));
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker_path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "signer authorization was already durably consumed".to_owned()
            } else {
                format!("could not consume signer authorization: {error}")
            }
        })?;
    marker
        .write_all(format!("{authorization_digest}\n").as_bytes())
        .map_err(|error| format!("could not persist signer authorization: {error}"))?;
    marker
        .sync_all()
        .map_err(|error| format!("could not fsync signer authorization: {error}"))?;
    Ok(())
}

fn runtime_identity(key_directory: &Path) -> Result<(SigningKey, String)> {
    let seed_hex = read_secret_file(
        &key_directory.join("runtime-identity.key"),
        "runtime identity key",
    )?;
    let mut seed = decode_hex_32(seed_hex.trim(), "runtime identity seed")?;
    let signing_key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    let mut spki = Vec::with_capacity(44);
    spki.extend_from_slice(&ED25519_SPKI_PREFIX);
    spki.extend_from_slice(signing_key.verifying_key().as_bytes());
    Ok((signing_key, sha256_hex(&spki)))
}

fn run() -> Result<()> {
    let arguments: Vec<String> = env::args().collect();
    if arguments.len() != 4 {
        return Err(
            "usage: utxoref-dlc-signer <absolute-key-directory> <absolute-validator-policy> <policy-sha256>"
                .to_owned(),
        );
    }
    let key_directory = PathBuf::from(&arguments[1]);
    let key_directory_metadata =
        fs::symlink_metadata(&key_directory).map_err(|error| error.to_string())?;
    if !key_directory.is_absolute()
        || !key_directory_metadata.is_dir()
        || key_directory_metadata.file_type().is_symlink()
    {
        return Err("key directory must be an existing absolute directory".to_owned());
    }
    let validator_policy = load_validator_policy(Path::new(&arguments[2]), &arguments[3])?;
    let mut input = Vec::new();
    io::stdin()
        .take(65_537)
        .read_to_end(&mut input)
        .map_err(|error| error.to_string())?;
    if input.len() > 65_536 {
        return Err("request exceeds 65536 bytes".to_owned());
    }
    let envelope: Value = serde_json::from_slice(&input).map_err(|error| error.to_string())?;
    let envelope_object = object(&envelope, "process envelope")?;
    if string(envelope_object, "kind")? != PROCESS_REQUEST_KIND {
        return Err("wrong process request kind".to_owned());
    }
    let challenge = string(envelope_object, "challenge")?;
    decode_hex_32(challenge, "challenge")?;
    let request = envelope_object
        .get("request")
        .ok_or_else(|| "request is required".to_owned())?;
    let request_json = canonical_json(request)?;
    let request_digest = sha256_hex(request_json.as_bytes());
    if request_digest != string(envelope_object, "requestDigest")? {
        return Err("process request digest mismatch".to_owned());
    }
    let (signer_pubkey, message, adaptor_x, adaptor_y, authorization_digest) =
        verify_request(request, &validator_policy)?;
    consume_authorization(&key_directory, &authorization_digest)?;
    let key_path = key_directory.join(format!("{signer_pubkey}.key"));
    let secret_hex = read_secret_file(&key_path, "DLC signer key")?;
    let mut secret_bytes = decode_hex_32(secret_hex.trim(), "DLC signer key")?;
    let mut secret_scalar = scalar_from_bytes(secret_bytes, "DLC signer key")?;
    let (derived_x, _) = affine_coordinates(
        ProjectivePoint::GENERATOR * secret_scalar,
        "DLC signer public key",
    )?;
    secret_scalar.zeroize();
    if hex::encode(derived_x) != signer_pubkey {
        secret_bytes.zeroize();
        return Err("DLC signer key does not match the authorized public key".to_owned());
    }
    let presignature = adaptor_sign(secret_bytes, message, &adaptor_x, &adaptor_y)?;
    secret_bytes.zeroize();
    let presignature_value =
        serde_json::to_value(&presignature).map_err(|error| error.to_string())?;
    let mut signature_payload = Map::new();
    signature_payload.insert(
        "kind".to_owned(),
        Value::String(PROCESS_RESPONSE_KIND.to_owned()),
    );
    signature_payload.insert("challenge".to_owned(), Value::String(challenge.to_owned()));
    signature_payload.insert(
        "requestDigest".to_owned(),
        Value::String(request_digest.clone()),
    );
    signature_payload.insert(
        "presignatureDigest".to_owned(),
        Value::String(sha256_hex(canonical_json(&presignature_value)?.as_bytes())),
    );
    let (runtime_key, identity_key_id) = runtime_identity(&key_directory)?;
    let signature = runtime_key.sign(canonical_json(&Value::Object(signature_payload))?.as_bytes());
    let response = serde_json::json!({
        "kind": PROCESS_RESPONSE_KIND,
        "challenge": challenge,
        "requestDigest": request_digest,
        "identityKeyId": identity_key_id,
        "presignature": presignature,
        "signature": BASE64.encode(signature.to_bytes())
    });
    let output = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    io::stdout()
        .write_all(&output)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "{error}");
        std::process::exit(1);
    }
}
