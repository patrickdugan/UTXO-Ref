//! Platform-independent parts of the UTXORef DLC signer.
//!
//! `main.rs` is the Windows process (DPAPI keys, process mitigations). The
//! code here has no platform dependencies so it can be unit-tested anywhere:
//! `cargo test --lib`.

use std::collections::BTreeMap;

use serde_json::Value;

pub mod signing_target;

pub type Result<T> = std::result::Result<T, String>;

/// Canonical JSON identical to the host's `dlc_canonical_json.canonicalJson`:
/// sorted object keys, no whitespace, JavaScript-safe integers only.
pub fn canonical_json(value: &Value) -> Result<String> {
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
