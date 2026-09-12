#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
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
const AUTHORIZATION_KIND: &str = "utxoref_dlc_adaptor_sign_authorization_v3";
const PRESIGNATURE_KIND: &str = "tradelayer_dlc_adaptor_presig_v1";
const MAX_AUTHORIZATION_TTL_SECONDS: u64 = 300;
const MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS: u64 = 30;
const CLOCK_OBSERVATION_KIND: &str = "utxoref_dlc_signer_clock_observation_v1";
const MAX_CLOCK_OBSERVATIONS: usize = 4096;
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

struct NativeValidatorPolicy {
    network: String,
    validator_key_ids: Vec<String>,
    signer_pubkeys: Vec<String>,
}

struct VerifiedRequest {
    signer_pubkey: String,
    message: [u8; 32],
    adaptor_x: String,
    adaptor_y: String,
    authorization_digest: String,
    issued_at: u64,
    expires_at: u64,
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

fn authorization_window(
    payload: &Map<String, Value>,
    authorization: &Map<String, Value>,
) -> Result<(u64, u64)> {
    let issued_at = safe_u64(payload, "issuedAtUnixSeconds")?;
    let expires_at = safe_u64(payload, "expiresAtUnixSeconds")?;
    if issued_at != safe_u64(authorization, "issuedAtUnixSeconds")?
        || expires_at != safe_u64(authorization, "expiresAtUnixSeconds")?
    {
        return Err("authorization lifetime differs from its signed payload".to_owned());
    }
    if expires_at <= issued_at || expires_at - issued_at > MAX_AUTHORIZATION_TTL_SECONDS {
        return Err(format!(
            "signing authorization lifetime must be 1..{MAX_AUTHORIZATION_TTL_SECONDS} seconds"
        ));
    }
    Ok((issued_at, expires_at))
}

fn current_unix_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the UNIX epoch".to_owned())?
        .as_secs())
}

fn verify_authorization_freshness(issued_at: u64, expires_at: u64, now: u64) -> Result<()> {
    if issued_at > now.saturating_add(MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS) {
        return Err("signing authorization is not yet valid".to_owned());
    }
    if expires_at < now {
        return Err("signing authorization has expired".to_owned());
    }
    Ok(())
}

fn clock_observation_payload(unix_seconds: u64, identity_key_id: &str) -> Value {
    serde_json::json!({
        "kind": CLOCK_OBSERVATION_KIND,
        "identityKeyId": identity_key_id,
        "unixSeconds": unix_seconds
    })
}

fn verify_clock_observation(
    path: &Path,
    runtime_key: &SigningKey,
    identity_key_id: &str,
) -> Result<u64> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("signer clock observation: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 2048 {
        return Err(
            "signer clock observation must be a bounded regular non-symlink file".to_owned(),
        );
    }
    let bytes = fs::read(path).map_err(|error| format!("signer clock observation: {error}"))?;
    let observation: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("signer clock observation: {error}"))?;
    if canonical_json(&observation)?.as_bytes() != bytes {
        return Err("signer clock observation is not canonical JSON".to_owned());
    }
    let observation_object = object(&observation, "signer clock observation")?;
    if observation_object.len() != 4
        || string(observation_object, "kind")? != CLOCK_OBSERVATION_KIND
        || string(observation_object, "identityKeyId")? != identity_key_id
    {
        return Err("signer clock observation schema or identity is invalid".to_owned());
    }
    let unix_seconds = safe_u64(observation_object, "unixSeconds")?;
    let expected_name = format!("{unix_seconds}.clock");
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err("signer clock observation filename differs from its timestamp".to_owned());
    }
    let signature_bytes = BASE64
        .decode(string(observation_object, "signature")?)
        .map_err(|error| error.to_string())?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| error.to_string())?;
    let payload = clock_observation_payload(unix_seconds, identity_key_id);
    runtime_key
        .verifying_key()
        .verify(canonical_json(&payload)?.as_bytes(), &signature)
        .map_err(|_| "signer clock observation signature is invalid".to_owned())?;
    Ok(unix_seconds)
}

fn guard_signer_clock(
    key_directory: &Path,
    runtime_key: &SigningKey,
    identity_key_id: &str,
) -> Result<u64> {
    let observation_directory = key_directory.join("clock-observations");
    match fs::create_dir(&observation_directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("could not create signer clock store: {error}")),
    }
    let metadata = fs::symlink_metadata(&observation_directory)
        .map_err(|error| format!("could not inspect signer clock store: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("signer clock store must be a regular non-symlink directory".to_owned());
    }
    let mut paths = fs::read_dir(&observation_directory)
        .map_err(|error| format!("could not read signer clock store: {error}"))?
        .map(|entry| {
            entry
                .map(|value| value.path())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    paths.sort();
    if paths.len() > MAX_CLOCK_OBSERVATIONS {
        return Err(format!(
            "signer clock store exceeds {MAX_CLOCK_OBSERVATIONS} observations; reviewed rotation is required"
        ));
    }
    let mut floor = 0u64;
    for path in paths {
        floor = floor.max(verify_clock_observation(
            &path,
            runtime_key,
            identity_key_id,
        )?);
    }
    let now = current_unix_seconds()?;
    if floor > now.saturating_add(MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS) {
        return Err("signer clock rollback exceeds the permitted 30-second skew".to_owned());
    }
    let observation_path = observation_directory.join(format!("{now}.clock"));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&observation_path)
    {
        Ok(mut file) => {
            let payload = clock_observation_payload(now, identity_key_id);
            let signature = runtime_key.sign(canonical_json(&payload)?.as_bytes());
            let observation = serde_json::json!({
                "kind": CLOCK_OBSERVATION_KIND,
                "identityKeyId": identity_key_id,
                "unixSeconds": now,
                "signature": BASE64.encode(signature.to_bytes())
            });
            file.write_all(canonical_json(&observation)?.as_bytes())
                .map_err(|error| format!("could not persist signer clock observation: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("could not fsync signer clock observation: {error}"))?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if verify_clock_observation(&observation_path, runtime_key, identity_key_id)? != now {
                return Err("existing signer clock observation timestamp mismatch".to_owned());
            }
        }
        Err(error) => {
            return Err(format!(
                "could not create signer clock observation: {error}"
            ));
        }
    }
    Ok(now)
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

fn scalar_from_bytes(bytes: &[u8; 32], name: &str) -> Result<Scalar> {
    let mut representation = FieldBytes::from(*bytes);
    let candidate = Scalar::from_repr(representation);
    representation.zeroize();
    let scalar = Option::<Scalar>::from(candidate)
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
    secret_bytes: &[u8; 32],
    message: [u8; 32],
    adaptor_x: &str,
    adaptor_y: &str,
) -> Result<Presignature> {
    let mut secret = Zeroizing::new(scalar_from_bytes(secret_bytes, "signer secret")?);
    let public_point = ProjectivePoint::GENERATOR * *secret;
    let (public_x, public_y) = affine_coordinates(public_point, "signer public key")?;
    if public_y[31] & 1 == 1 {
        *secret = -*secret;
    }
    let mut auxiliary = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(&mut auxiliary[..]);
    let aux_hash = Zeroizing::new(tagged_hash("BIP0340/aux", &[&auxiliary[..]]));
    let mut tbase = Zeroizing::new(secret.to_bytes());
    for (left, right) in tbase.iter_mut().zip(aux_hash.iter().copied()) {
        *left ^= right;
    }
    let adaptor_point = parse_point(adaptor_x, adaptor_y)?;
    let (tx, ty) = affine_coordinates(adaptor_point, "adaptor point")?;
    let compressed_prefix = if ty[31] & 1 == 0 { 0x02 } else { 0x03 };
    let mut compressed_adaptor = [0u8; 33];
    compressed_adaptor[0] = compressed_prefix;
    compressed_adaptor[1..].copy_from_slice(&tx);

    for counter in 0u8..64 {
        let nonce_hash = Zeroizing::new(tagged_hash(
            "TradeLayer/dlc/adaptor/nonce",
            &[
                &tbase[..],
                &public_x,
                &message,
                &compressed_adaptor,
                &[counter],
            ],
        ));
        let nonce = Zeroizing::new(reduce_scalar(*nonce_hash));
        if bool::from(nonce.is_zero()) {
            continue;
        }
        let r0_point = ProjectivePoint::GENERATOR * *nonce;
        let effective_point = r0_point + adaptor_point;
        if bool::from(effective_point.is_identity()) {
            continue;
        }
        let (rx, ry) = affine_coordinates(effective_point, "effective nonce")?;
        if ry[31] & 1 == 1 {
            continue;
        }
        let (r0x, r0y) = affine_coordinates(r0_point, "nonce point")?;
        let response = Zeroizing::new(*nonce + challenge(&rx, &public_x, &message) * *secret);
        let response_bytes = Zeroizing::new(response.to_bytes());
        return Ok(Presignature {
            kind: PRESIGNATURE_KIND,
            rx: hex::encode(rx),
            s0: hex::encode(&response_bytes[..]),
            r0x: hex::encode(r0x),
            r0y: hex::encode(r0y),
            tx: hex::encode(tx),
            ty: hex::encode(ty),
        });
    }
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

fn validate_unwrapper(path: &Path, expected_digest: &str) -> Result<()> {
    decode_hex_32(expected_digest, "DPAPI unwrapper digest")?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("DPAPI unwrapper: {error}"))?;
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 65_536
    {
        return Err(
            "DPAPI unwrapper must be a bounded absolute regular non-symlink file".to_owned(),
        );
    }
    let bytes = fs::read(path).map_err(|error| format!("DPAPI unwrapper: {error}"))?;
    if sha256_hex(&bytes) != expected_digest {
        return Err("DPAPI unwrapper digest differs from the audited launch argument".to_owned());
    }
    Ok(())
}

fn reject_plaintext_key_files(key_directory: &Path) -> Result<()> {
    for entry in fs::read_dir(key_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "key directory contains a non-Unicode filename".to_owned())?;
        if name.to_ascii_lowercase().ends_with(".key") {
            return Err(
                "plaintext .key files are forbidden; provision DPAPI key blobs only".to_owned(),
            );
        }
    }
    Ok(())
}

fn powershell_path() -> Result<(PathBuf, String)> {
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("WINDIR"))
        .map_err(|_| "SystemRoot is required for the DPAPI key backend".to_owned())?;
    let executable = PathBuf::from(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let metadata = fs::symlink_metadata(&executable)
        .map_err(|error| format!("Windows PowerShell: {error}"))?;
    if !executable.is_absolute() || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(
            "Windows PowerShell must be an absolute regular non-symlink executable".to_owned(),
        );
    }
    Ok((executable, system_root))
}

fn unprotect_dpapi_secret(
    blob_path: &Path,
    unwrapper_path: &Path,
    name: &str,
) -> Result<Zeroizing<[u8; 32]>> {
    let metadata = fs::symlink_metadata(blob_path).map_err(|error| format!("{name}: {error}"))?;
    if !blob_path.is_absolute()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() < 64
        || metadata.len() > 4096
    {
        return Err(format!(
            "{name} must be a bounded absolute regular non-symlink DPAPI blob"
        ));
    }
    let (powershell, system_root) = powershell_path()?;
    let output = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(unwrapper_path)
        .arg("-BlobPath")
        .arg(blob_path)
        .env_clear()
        .env("SystemRoot", &system_root)
        .env("WINDIR", &system_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("{name} DPAPI helper failed to start: {error}"))?;
    let stdout = Zeroizing::new(output.stdout);
    let stderr = Zeroizing::new(output.stderr);
    if stdout.len() > 64 || stderr.len() > 4096 {
        return Err(format!("{name} DPAPI helper output exceeded its bound"));
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        return Err(format!("{name} DPAPI helper failed: {}", detail.trim()));
    }
    let encoded = std::str::from_utf8(&stdout)
        .map_err(|_| format!("{name} DPAPI helper returned non-UTF-8 output"))?;
    Ok(Zeroizing::new(decode_hex_32(encoded, name)?))
}

fn sorted_hex_array(
    policy_object: &Map<String, Value>,
    name: &str,
    maximum: usize,
) -> Result<Vec<String>> {
    let values = policy_object
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("validator policy {name} must be an array"))?;
    if values.is_empty() || values.len() > maximum {
        return Err(format!(
            "validator policy {name} must contain between 1 and {maximum} entries"
        ));
    }
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let entry = value
            .as_str()
            .ok_or_else(|| format!("validator policy {name} entries must be strings"))?;
        decode_hex_32(entry, &format!("validator policy {name} entry"))?;
        normalized.push(entry.to_owned());
    }
    if normalized.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(format!(
            "validator policy {name} entries must be sorted and unique"
        ));
    }
    Ok(normalized)
}

fn load_validator_policy(path: &Path, expected_digest: &str) -> Result<NativeValidatorPolicy> {
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
    if policy_object.len() != 4
        || string(policy_object, "kind")? != "utxoref_dlc_native_validator_policy_v1"
    {
        return Err("validator policy schema is invalid".to_owned());
    }
    let network = string(policy_object, "network")?.to_owned();
    if network != "bitcoin-testnet4" {
        return Err("native signer policy permits only bitcoin-testnet4".to_owned());
    }
    Ok(NativeValidatorPolicy {
        network,
        validator_key_ids: sorted_hex_array(policy_object, "validatorKeyIds", 16)?,
        signer_pubkeys: sorted_hex_array(policy_object, "signerPubkeyXs", 64)?,
    })
}

fn verify_request(request: &Value, policy: &NativeValidatorPolicy) -> Result<VerifiedRequest> {
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
    if string(payload_object, "network")? != policy.network {
        return Err(
            "authorization network is not permitted by the audited signer policy".to_owned(),
        );
    }
    if policy
        .signer_pubkeys
        .binary_search(&string(payload_object, "signerPubkeyX")?.to_owned())
        .is_err()
    {
        return Err("signer public key is not pinned by the audited signer policy".to_owned());
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
    if policy
        .validator_key_ids
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
    let (issued_at, expires_at) = authorization_window(payload_object, authorization_object)?;
    verify_authorization_freshness(issued_at, expires_at, current_unix_seconds()?)?;
    let authorization_digest = sha256_hex(canonical_json(authorization)?.as_bytes());
    if authorization_digest != string(request_object, "authorizationDigest")? {
        return Err("authorization digest mismatch".to_owned());
    }
    if string(payload_object, "stage")? != "COUNTERPARTY_SIGNATURES_VERIFIED" {
        return Err("authorization stage is not signable".to_owned());
    }
    Ok(VerifiedRequest {
        signer_pubkey: string(request_object, "signerPubkeyX")?.to_owned(),
        message: decode_hex_32(string(request_object, "sighash")?, "sighash")?,
        adaptor_x: string(request_point, "x")?.to_owned(),
        adaptor_y: string(request_point, "y")?.to_owned(),
        authorization_digest,
        issued_at,
        expires_at,
    })
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

fn runtime_identity(key_directory: &Path, unwrapper_path: &Path) -> Result<(SigningKey, String)> {
    let mut seed = unprotect_dpapi_secret(
        &key_directory.join("runtime-identity.key.dpapi"),
        unwrapper_path,
        "runtime identity seed",
    )?;
    let signing_key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    let mut spki = Vec::with_capacity(44);
    spki.extend_from_slice(&ED25519_SPKI_PREFIX);
    spki.extend_from_slice(signing_key.verifying_key().as_bytes());
    Ok((signing_key, sha256_hex(&spki)))
}

fn run() -> Result<()> {
    let arguments: Vec<String> = env::args().collect();
    if arguments.len() != 6 {
        return Err(
            "usage: utxoref-dlc-signer <absolute-key-directory> <absolute-validator-policy> <policy-sha256> <absolute-dpapi-unwrapper> <unwrapper-sha256>"
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
    reject_plaintext_key_files(&key_directory)?;
    let validator_policy = load_validator_policy(Path::new(&arguments[2]), &arguments[3])?;
    let unwrapper_path = Path::new(&arguments[4]);
    validate_unwrapper(unwrapper_path, &arguments[5])?;
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
    let verified = verify_request(request, &validator_policy)?;
    consume_authorization(&key_directory, &verified.authorization_digest)?;
    let (runtime_key, identity_key_id) = runtime_identity(&key_directory, unwrapper_path)?;
    let guarded_now = guard_signer_clock(&key_directory, &runtime_key, &identity_key_id)?;
    verify_authorization_freshness(verified.issued_at, verified.expires_at, guarded_now)?;
    let key_path = key_directory.join(format!("{}.key.dpapi", verified.signer_pubkey));
    let secret_bytes = unprotect_dpapi_secret(&key_path, unwrapper_path, "DLC signer key")?;
    let secret_scalar = Zeroizing::new(scalar_from_bytes(&secret_bytes, "DLC signer key")?);
    let (derived_x, _) = affine_coordinates(
        ProjectivePoint::GENERATOR * *secret_scalar,
        "DLC signer public key",
    )?;
    if hex::encode(derived_x) != verified.signer_pubkey {
        return Err("DLC signer key does not match the authorized public key".to_owned());
    }
    let presignature = adaptor_sign(
        &secret_bytes,
        verified.message,
        &verified.adaptor_x,
        &verified.adaptor_y,
    )?;
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
