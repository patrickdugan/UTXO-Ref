//! Signed clock-observation store: the signer's rollback floor.
//!
//! Each signing run records the current time as a file signed by the runtime
//! identity key and refuses to sign if any recorded observation is more than
//! the permitted skew ahead of the clock. The floor is the newest
//! observation, so older ones carry no information once a newer one is
//! written: after each write the store keeps only the newest
//! `RETAINED_CLOCK_OBSERVATIONS` (MAIN-5). Nothing here is platform-specific.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use serde_json::{Map, Value};

use crate::{Result, canonical_json};

pub const CLOCK_OBSERVATION_KIND: &str = "utxoref_dlc_signer_clock_observation_v1";
pub const CLOCK_STORE_DIRECTORY: &str = "clock-observations";
pub const MAX_CLOCK_ROLLBACK_SECONDS: u64 = 30;
/// Observations kept after each write. The newest one is the floor.
pub const RETAINED_CLOCK_OBSERVATIONS: usize = 64;
/// Upper bound on observations read (and verified) per run. Stores written
/// before compaction could hold up to 4,097; they load and are compacted.
pub const MAX_CLOCK_OBSERVATIONS: usize = 8192;
const CLOCK_STORE_LOCK_FILE: &str = ".clock-store.lock";
const CLOCK_STORE_LOCK_ATTEMPTS: usize = 2000;

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

fn clock_observation_payload(unix_seconds: u64, identity_key_id: &str) -> Value {
    serde_json::json!({
        "kind": CLOCK_OBSERVATION_KIND,
        "identityKeyId": identity_key_id,
        "unixSeconds": unix_seconds
    })
}

/// The canonical bytes of a signed observation for `unix_seconds`.
pub fn signed_clock_observation(
    unix_seconds: u64,
    runtime_key: &SigningKey,
    identity_key_id: &str,
) -> Result<String> {
    let payload = clock_observation_payload(unix_seconds, identity_key_id);
    let signature = runtime_key.sign(canonical_json(&payload)?.as_bytes());
    canonical_json(&serde_json::json!({
        "kind": CLOCK_OBSERVATION_KIND,
        "identityKeyId": identity_key_id,
        "unixSeconds": unix_seconds,
        "signature": BASE64.encode(signature.to_bytes())
    }))
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

struct ClockStoreLock {
    file: fs::File,
}

impl Drop for ClockStoreLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn acquire_clock_store_lock(observation_directory: &Path) -> Result<ClockStoreLock> {
    let lock_path = observation_directory.join(CLOCK_STORE_LOCK_FILE);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("could not open signer clock-store lock: {error}"))?;
    let metadata = fs::symlink_metadata(&lock_path)
        .map_err(|error| format!("could not inspect signer clock-store lock: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 128 {
        return Err(
            "signer clock-store lock must be a bounded regular non-symlink file".to_owned(),
        );
    }
    for _ in 0..CLOCK_STORE_LOCK_ATTEMPTS {
        match file.try_lock() {
            Ok(()) => {
                file.set_len(0)
                    .map_err(|error| format!("could not reset signer clock-store lock: {error}"))?;
                file.write_all(format!("{}\n", std::process::id()).as_bytes())
                    .map_err(|error| {
                        format!("could not persist signer clock-store lock: {error}")
                    })?;
                file.sync_all()
                    .map_err(|error| format!("could not fsync signer clock-store lock: {error}"))?;
                return Ok(ClockStoreLock { file });
            }
            Err(fs::TryLockError::WouldBlock) => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(fs::TryLockError::Error(error)) => {
                return Err(format!("could not lock signer clock store: {error}"));
            }
        }
    }
    Err("signer clock store remained locked for twenty seconds".to_owned())
}

/// Verifies every stored observation, refuses a clock more than
/// `MAX_CLOCK_ROLLBACK_SECONDS` behind the newest one, records `clock()` and
/// drops all but the newest `RETAINED_CLOCK_OBSERVATIONS`. `clock` is read
/// under the store lock. Returns the recorded time.
pub fn guard_signer_clock(
    key_directory: &Path,
    runtime_key: &SigningKey,
    identity_key_id: &str,
    clock: impl FnOnce() -> Result<u64>,
) -> Result<u64> {
    let observation_directory = key_directory.join(CLOCK_STORE_DIRECTORY);
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
    let _clock_store_lock = acquire_clock_store_lock(&observation_directory)?;
    let mut paths = Vec::new();
    for entry in fs::read_dir(&observation_directory)
        .map_err(|error| format!("could not read signer clock store: {error}"))?
    {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.file_name().and_then(|name| name.to_str()) == Some(CLOCK_STORE_LOCK_FILE) {
            continue;
        }
        paths.push(path);
        if paths.len() > MAX_CLOCK_OBSERVATIONS {
            return Err(format!(
                "signer clock store exceeds {MAX_CLOCK_OBSERVATIONS} observations; reviewed rotation is required"
            ));
        }
    }
    let mut observations: Vec<(u64, PathBuf)> = Vec::with_capacity(paths.len() + 1);
    for path in paths {
        let unix_seconds = verify_clock_observation(&path, runtime_key, identity_key_id)?;
        observations.push((unix_seconds, path));
    }
    let floor = observations.iter().map(|(seconds, _)| *seconds).max().unwrap_or(0);
    let now = clock()?;
    if floor > now.saturating_add(MAX_CLOCK_ROLLBACK_SECONDS) {
        return Err("signer clock rollback exceeds the permitted 30-second skew".to_owned());
    }
    let observation_path = observation_directory.join(format!("{now}.clock"));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&observation_path)
    {
        Ok(mut file) => {
            let observation = signed_clock_observation(now, runtime_key, identity_key_id)?;
            file.write_all(observation.as_bytes())
                .map_err(|error| format!("could not persist signer clock observation: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("could not fsync signer clock observation: {error}"))?;
            observations.push((now, observation_path));
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
    // MAIN-5: compact. Only the newest observation bounds rollback, and it
    // is never removed: removal runs oldest first, after the new observation
    // is durable, and stops at the retained count.
    if observations.len() > RETAINED_CLOCK_OBSERVATIONS {
        observations.sort_by_key(|(seconds, _)| *seconds);
        let excess = observations.len() - RETAINED_CLOCK_OBSERVATIONS;
        for (_, path) in observations.drain(..excess) {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("could not compact signer clock store: {error}"));
                }
            }
        }
    }
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const IDENTITY: &str = "clock-store-test-identity";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "utxoref-clock-store-{label}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn write_observation(directory: &Path, seconds: u64, runtime_key: &SigningKey) {
        let store = directory.join(CLOCK_STORE_DIRECTORY);
        fs::create_dir_all(&store).unwrap();
        let bytes = signed_clock_observation(seconds, runtime_key, IDENTITY).unwrap();
        fs::write(store.join(format!("{seconds}.clock")), bytes).unwrap();
    }

    fn stored_seconds(directory: &Path) -> Vec<u64> {
        let mut seconds: Vec<u64> = fs::read_dir(directory.join(CLOCK_STORE_DIRECTORY))
            .unwrap()
            .filter_map(|entry| {
                let name = entry.unwrap().file_name().into_string().unwrap();
                name.strip_suffix(".clock").map(|stem| stem.parse().unwrap())
            })
            .collect();
        seconds.sort();
        seconds
    }

    #[test]
    fn records_now_and_enforces_the_rollback_floor() {
        let directory = TempDir::new("floor");
        let runtime_key = key(7);
        let now = 1_800_000_000u64;
        assert_eq!(guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(now)).unwrap(), now);
        assert_eq!(stored_seconds(&directory.0), vec![now]);
        // Within the permitted skew the clock may step back.
        let skewed = now - MAX_CLOCK_ROLLBACK_SECONDS;
        assert!(guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(skewed)).is_ok());
        let error = guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(skewed - 1))
            .expect_err("rollback beyond the skew was accepted");
        assert!(error.contains("rollback"), "{error}");
    }

    #[test]
    fn compaction_keeps_the_newest_observations_and_the_floor() {
        let directory = TempDir::new("compact");
        let runtime_key = key(9);
        let now = 1_800_000_000u64;
        for offset in 0..200u64 {
            write_observation(&directory.0, now - 10_000 + offset, &runtime_key);
        }
        // The floor: ahead of the clock, inside the skew.
        write_observation(&directory.0, now + 20, &runtime_key);
        guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(now)).unwrap();
        let kept = stored_seconds(&directory.0);
        assert_eq!(kept.len(), RETAINED_CLOCK_OBSERVATIONS);
        assert_eq!(*kept.last().unwrap(), now + 20, "compaction removed the floor");
        assert!(kept.contains(&now), "compaction removed the new observation");
        // The floor still binds after compaction.
        let error = guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(now - 11))
            .expect_err("rollback below the preserved floor was accepted");
        assert!(error.contains("rollback"), "{error}");
        // Repeated runs stay bounded: replays can no longer fill the store.
        for step in 1..=100u64 {
            guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(now + 20 + step)).unwrap();
        }
        let kept = stored_seconds(&directory.0);
        assert_eq!(kept.len(), RETAINED_CLOCK_OBSERVATIONS);
        assert_eq!(*kept.last().unwrap(), now + 120);
    }

    #[test]
    fn a_full_pre_compaction_store_loads_and_is_compacted() {
        let directory = TempDir::new("legacy");
        let runtime_key = key(11);
        let now = 1_800_000_000u64;
        // The old code refused past 4,096 files after writing one more.
        for offset in 0..4097u64 {
            write_observation(&directory.0, now - 5_000 + offset, &runtime_key);
        }
        guard_signer_clock(&directory.0, &runtime_key, IDENTITY, || Ok(now)).unwrap();
        assert_eq!(stored_seconds(&directory.0).len(), RETAINED_CLOCK_OBSERVATIONS);
    }

    #[test]
    fn refuses_foreign_or_oversized_stores_without_writing() {
        let directory = TempDir::new("foreign");
        let now = 1_800_000_000u64;
        write_observation(&directory.0, now - 5, &key(13));
        let error = guard_signer_clock(&directory.0, &key(14), IDENTITY, || Ok(now))
            .expect_err("an observation signed by another key was accepted");
        assert!(error.contains("signature is invalid"), "{error}");
        assert_eq!(stored_seconds(&directory.0), vec![now - 5]);

        let oversized = TempDir::new("oversized");
        let store = oversized.0.join(CLOCK_STORE_DIRECTORY);
        fs::create_dir_all(&store).unwrap();
        for index in 0..=MAX_CLOCK_OBSERVATIONS {
            fs::write(store.join(format!("{index}.clock")), b"{}").unwrap();
        }
        let error = guard_signer_clock(&oversized.0, &key(15), IDENTITY, || Ok(now))
            .expect_err("an oversized store was accepted");
        assert!(error.contains("exceeds"), "{error}");
    }
}
