use secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{BufWriter, Write};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_ARTIFACT: &str =
    "../../bitvm3/utxo_referee/artifacts/lightning_ark_liquidity_graft_latest.json";
const DEFAULT_OUTPUT: &str =
    "../../bitvm3/utxo_referee/artifacts/ark_liquidity_governor_bench_latest.json";
const POLICY_PREFIX: &str = "utxoref-ark-ln-governor-v1";

#[derive(Debug, Clone)]
struct Config {
    artifact: PathBuf,
    output: PathBuf,
    obligations: usize,
    work_factor: usize,
    workers: usize,
    bad_every: usize,
}

#[derive(Debug, Clone)]
struct ArtifactSeed {
    bundle_id: String,
    asp_id: String,
    template_id: String,
    quote_id: String,
    vtxo_commitment_id: String,
    vtxo_amount_sats: u64,
    promised_inbound_sats: u64,
    max_fee_ppm: u64,
    max_cltv_delta: u64,
    exit_txid: String,
    forfeit_txid: String,
}

#[derive(Debug, Clone)]
struct Obligation {
    lane_index: usize,
    asset_tag: String,
    asp_id: String,
    template_id: String,
    quote_id: String,
    vtxo_commitment_id: String,
    vtxo_amount_sats: u64,
    promised_inbound_sats: u64,
    delivered_inbound_sats: u64,
    max_fee_ppm: u64,
    observed_fee_ppm: u64,
    max_cltv_delta: u64,
    observed_cltv_delta: u64,
    payment_hash_hex: String,
    preimage_hex: String,
    exit_txid: String,
    forfeit_txid: String,
    policy_digest_hex: String,
    proof_work_digest_hex: String,
}

#[derive(Debug, Clone, Default)]
struct VerifyStats {
    checked: usize,
    ok: usize,
    slashable: usize,
    violations: usize,
    checksum: [u8; 32],
}

#[derive(Debug, Clone)]
struct BenchResult {
    stats: VerifyStats,
    elapsed: Duration,
}

#[derive(Debug, Clone)]
struct EcdsaCase {
    message_digest: [u8; 32],
    secret_key: SecretKey,
    public_key: PublicKey,
    signature: Signature,
}

#[derive(Debug, Clone, Default)]
struct CurveStats {
    checked: usize,
    ok: usize,
    checksum: [u8; 32],
}

#[derive(Debug, Clone)]
struct CurveBenchResult {
    stats: CurveStats,
    elapsed: Duration,
}

#[derive(Debug, Clone, Default)]
struct StressStats {
    checked: usize,
    bytes: usize,
    checksum: [u8; 32],
}

#[derive(Debug, Clone)]
struct StressBenchResult {
    stats: StressStats,
    elapsed: Duration,
}

fn main() -> Result<(), String> {
    let config = Config::from_args(env::args().skip(1).collect())?;
    let artifact = read_artifact(&config.artifact)?;
    let seed = seed_from_artifact(&artifact)?;
    let obligations = build_obligations(
        &seed,
        config.obligations,
        config.work_factor,
        config.bad_every,
    );

    let serial = bench_serial(&obligations, config.work_factor);
    let parallel = bench_parallel(&obligations, config.work_factor, config.workers);
    let ecdsa_cases = build_ecdsa_cases(&seed, config.obligations)?;
    let ecdsa_verify_serial = bench_ecdsa_verify_serial(&ecdsa_cases)?;
    let ecdsa_verify_parallel = bench_ecdsa_verify_parallel(&ecdsa_cases, config.workers)?;
    let ecdsa_sign_serial = bench_ecdsa_sign_serial(&ecdsa_cases)?;
    let ecdsa_sign_parallel = bench_ecdsa_sign_parallel(&ecdsa_cases, config.workers)?;
    let cet_serial = bench_cet_template_serial(&obligations);
    let cet_parallel = bench_cet_template_parallel(&obligations, config.workers);
    let oracle_serial = bench_oracle_fanout_serial(&obligations);
    let oracle_parallel = bench_oracle_fanout_parallel(&obligations, config.workers);
    let json_serialization = bench_json_serialization(&obligations)?;
    let json_parse = bench_json_parse(&obligations)?;
    let persistence = bench_persistence_writes(&obligations, &config.output)?;
    let binary_serialization = bench_binary_transcript_serialization(&obligations);
    let binary_parse = bench_binary_transcript_parse(&obligations)?;
    let binary_persistence = bench_binary_persistence_writes(&obligations, &config.output)?;
    let speedup = if parallel.elapsed.as_nanos() == 0 {
        0.0
    } else {
        serial.elapsed.as_secs_f64() / parallel.elapsed.as_secs_f64()
    };
    let ecdsa_verify_speedup = curve_speedup(&ecdsa_verify_serial, &ecdsa_verify_parallel);
    let ecdsa_sign_speedup = curve_speedup(&ecdsa_sign_serial, &ecdsa_sign_parallel);

    let report = json!({
        "kind": "ark_ln_utxoref_governor_throughput_benchmark",
        "generatedAtUnixMs": unix_ms(),
        "architecture": {
            "liquidityPath": "Ark VTXO inventory grafts route liquidity for LN without asset-specific semantics",
            "governorPath": "UTXORef/BitVM validates ASP pathing promises, fee ceilings, CLTV ceilings, exit paths, and forfeit paths",
            "hotPathRule": "parallel local verification only; BitVM/DLC settlement is cold-path escalation"
        },
        "input": {
            "artifact": config.artifact.display().to_string(),
            "bundleId": seed.bundle_id,
            "aspId": seed.asp_id,
            "templateId": seed.template_id,
            "quoteId": seed.quote_id,
            "vtxoCommitmentId": seed.vtxo_commitment_id,
            "obligations": config.obligations,
            "workFactor": config.work_factor,
            "workers": config.workers,
            "badEvery": config.bad_every
        },
        "serial": result_json(&serial),
        "parallel": result_json(&parallel),
        "comparison": {
            "speedup": round(speedup, 3),
            "serialObligationsPerSecond": rate(serial.stats.checked, serial.elapsed),
            "parallelObligationsPerSecond": rate(parallel.stats.checked, parallel.elapsed),
            "statsMatch": stats_match(&serial.stats, &parallel.stats)
        },
        "secp256k1": {
            "library": "rust-secp256k1/libsecp256k1",
            "ecdsaVerify": {
                "serial": curve_result_json(&ecdsa_verify_serial),
                "parallel": curve_result_json(&ecdsa_verify_parallel),
                "speedup": round(ecdsa_verify_speedup, 3),
                "statsMatch": curve_stats_match(&ecdsa_verify_serial.stats, &ecdsa_verify_parallel.stats)
            },
            "ecdsaSign": {
                "serial": curve_result_json(&ecdsa_sign_serial),
                "parallel": curve_result_json(&ecdsa_sign_parallel),
                "speedup": round(ecdsa_sign_speedup, 3),
                "statsMatch": curve_stats_match(&ecdsa_sign_serial.stats, &ecdsa_sign_parallel.stats)
            }
        },
        "bottleneckStress": {
            "cetTemplateConstruction": {
                "serial": stress_result_json(&cet_serial),
                "parallel": stress_result_json(&cet_parallel),
                "speedup": round(stress_speedup(&cet_serial, &cet_parallel), 3),
                "statsMatch": stress_stats_match(&cet_serial.stats, &cet_parallel.stats)
            },
            "oracleOutcomeFanout": {
                "serial": stress_result_json(&oracle_serial),
                "parallel": stress_result_json(&oracle_parallel),
                "speedup": round(stress_speedup(&oracle_serial, &oracle_parallel), 3),
                "statsMatch": stress_stats_match(&oracle_serial.stats, &oracle_parallel.stats)
            },
            "jsonSerialization": stress_result_json(&json_serialization),
            "jsonParse": stress_result_json(&json_parse),
            "localPersistenceWrites": stress_result_json(&persistence)
        },
        "optimizedPaths": {
            "binaryTranscriptSerialization": stress_result_json(&binary_serialization),
            "binaryTranscriptParse": stress_result_json(&binary_parse),
            "binaryPersistenceWrites": stress_result_json(&binary_persistence),
            "jsonToBinaryParseSpeedup": round(json_parse.elapsed.as_secs_f64() / binary_parse.elapsed.as_secs_f64(), 3),
            "jsonToBinaryPersistenceSpeedup": round(persistence.elapsed.as_secs_f64() / binary_persistence.elapsed.as_secs_f64(), 3)
        },
        "interpretation": {
            "assetAgnostic": true,
            "bitvmInHotPath": false,
            "arkMakesMarginalRoutingAffordable": true,
            "governorOnlyEscalatesSlashableBatches": true
        }
    });

    if let Some(parent) = config.output.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "failed to create output directory {}: {e}",
                parent.display()
            )
        })?;
    }
    fs::write(
        &config.output,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("failed to write {}: {e}", config.output.display()))?;

    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}

impl Config {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let cwd = env::current_dir().map_err(|e| format!("failed to get cwd: {e}"))?;
        let mut config = Config {
            artifact: cwd.join(DEFAULT_ARTIFACT),
            output: cwd.join(DEFAULT_OUTPUT),
            obligations: 5_000,
            work_factor: 128,
            workers: default_workers(),
            bad_every: 0,
        };

        let mut i = 0;
        while i < args.len() {
            let key = &args[i];
            let value = args
                .get(i + 1)
                .ok_or_else(|| format!("missing value for {key}"))?;
            match key.as_str() {
                "--artifact" => config.artifact = PathBuf::from(value),
                "--output" => config.output = PathBuf::from(value),
                "--obligations" => config.obligations = parse_usize(key, value)?,
                "--work-factor" => config.work_factor = parse_usize(key, value)?,
                "--workers" => config.workers = parse_usize(key, value)?.max(1),
                "--bad-every" => config.bad_every = parse_usize(key, value)?,
                "--help" | "-h" => {
                    return Err(help_text());
                }
                other => return Err(format!("unknown argument {other}\n{}", help_text())),
            }
            i += 2;
        }

        if config.obligations == 0 {
            return Err("--obligations must be greater than zero".to_string());
        }

        Ok(config)
    }
}

fn read_artifact(path: &PathBuf) -> Result<Value, String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse {}: {e}", path.display()))
}

fn seed_from_artifact(value: &Value) -> Result<ArtifactSeed, String> {
    Ok(ArtifactSeed {
        bundle_id: get_str(value, &["bundleId"])?,
        asp_id: get_str(value, &["template", "templateCore", "aspId"])?,
        template_id: get_str(value, &["template", "templateCore", "templateId"])?,
        quote_id: get_str(value, &["quote", "quoteId"])?,
        vtxo_commitment_id: get_str(value, &["vtxo", "vtxoCommitmentId"])?,
        vtxo_amount_sats: get_u64_string(value, &["vtxo", "vtxoCore", "vtxoAmountSats"])?,
        promised_inbound_sats: get_u64_string(
            value,
            &["quote", "quoteCore", "promisedInboundSats"],
        )?,
        max_fee_ppm: get_u64(value, &["quote", "quoteCore", "maxFeePpm"])?,
        max_cltv_delta: get_u64(value, &["quote", "quoteCore", "maxCltvDelta"])?,
        exit_txid: get_str(value, &["vtxo", "vtxoCore", "exitTxid"])?,
        forfeit_txid: get_str(value, &["vtxo", "vtxoCore", "forfeitTxid"])?,
    })
}

fn build_obligations(
    seed: &ArtifactSeed,
    count: usize,
    work_factor: usize,
    bad_every: usize,
) -> Vec<Obligation> {
    (0..count)
        .map(|lane| {
            let preimage_hex = sha256_hex(
                format!("preimage|{}|{}|{}", seed.bundle_id, seed.quote_id, lane).as_bytes(),
            );
            let preimage = decode_hex_32(&preimage_hex).expect("internal preimage is valid hex");
            let payment_hash_hex = sha256_hex(&preimage);
            let mut delivered_inbound_sats = seed.promised_inbound_sats;
            let mut observed_fee_ppm = seed.max_fee_ppm.saturating_sub(100);
            let mut observed_cltv_delta = seed.max_cltv_delta.saturating_sub(6);
            let mut forfeit_txid = seed.forfeit_txid.clone();

            if bad_every != 0 && lane % bad_every == 0 {
                match lane % 4 {
                    0 => delivered_inbound_sats = seed.promised_inbound_sats.saturating_sub(1),
                    1 => observed_fee_ppm = seed.max_fee_ppm + 1,
                    2 => observed_cltv_delta = seed.max_cltv_delta + 1,
                    _ => forfeit_txid.clear(),
                }
            }

            let mut obligation = Obligation {
                lane_index: lane,
                asset_tag: "asset_agnostic_ln_liquidity".to_string(),
                asp_id: seed.asp_id.clone(),
                template_id: seed.template_id.clone(),
                quote_id: seed.quote_id.clone(),
                vtxo_commitment_id: seed.vtxo_commitment_id.clone(),
                vtxo_amount_sats: seed.vtxo_amount_sats,
                promised_inbound_sats: seed.promised_inbound_sats,
                delivered_inbound_sats,
                max_fee_ppm: seed.max_fee_ppm,
                observed_fee_ppm,
                max_cltv_delta: seed.max_cltv_delta,
                observed_cltv_delta,
                payment_hash_hex,
                preimage_hex,
                exit_txid: seed.exit_txid.clone(),
                forfeit_txid,
                policy_digest_hex: String::new(),
                proof_work_digest_hex: String::new(),
            };

            obligation.policy_digest_hex = policy_digest(&obligation);
            obligation.proof_work_digest_hex = proof_work_digest(&obligation, work_factor);
            obligation
        })
        .collect()
}

fn bench_serial(obligations: &[Obligation], work_factor: usize) -> BenchResult {
    let start = Instant::now();
    let mut stats = VerifyStats::default();
    for obligation in obligations {
        stats.add(verify_obligation(obligation, work_factor));
    }
    BenchResult {
        stats,
        elapsed: start.elapsed(),
    }
}

fn bench_parallel(obligations: &[Obligation], work_factor: usize, workers: usize) -> BenchResult {
    let worker_count = workers.min(obligations.len()).max(1);
    let chunk_size = (obligations.len() + worker_count - 1) / worker_count;
    let start = Instant::now();

    let stats = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for chunk in obligations.chunks(chunk_size) {
            handles.push(scope.spawn(move || {
                let mut stats = VerifyStats::default();
                for obligation in chunk {
                    stats.add(verify_obligation(obligation, work_factor));
                }
                stats
            }));
        }

        let mut combined = VerifyStats::default();
        for handle in handles {
            combined.merge(handle.join().expect("worker thread panicked"));
        }
        combined
    });

    BenchResult {
        stats,
        elapsed: start.elapsed(),
    }
}

fn build_ecdsa_cases(seed: &ArtifactSeed, count: usize) -> Result<Vec<EcdsaCase>, String> {
    let secp = Secp256k1::new();
    let mut cases = Vec::with_capacity(count);

    for index in 0..count {
        let secret_key = secret_key_for_index(seed, index)?;
        let public_key = PublicKey::from_secret_key(&secp, &secret_key);
        let message_digest = digest_bytes(format!(
            "cet-message|{}|{}|{}|{}",
            seed.bundle_id, seed.quote_id, seed.vtxo_commitment_id, index
        ));
        let message = Message::from_digest_slice(&message_digest)
            .map_err(|e| format!("failed to build message {index}: {e}"))?;
        let signature = secp.sign_ecdsa(&message, &secret_key);

        cases.push(EcdsaCase {
            message_digest,
            secret_key,
            public_key,
            signature,
        });
    }

    Ok(cases)
}

fn bench_ecdsa_verify_serial(cases: &[EcdsaCase]) -> Result<CurveBenchResult, String> {
    let secp = Secp256k1::verification_only();
    let start = Instant::now();
    let mut stats = CurveStats::default();

    for case in cases {
        stats.add(verify_ecdsa_case(&secp, case)?);
    }

    Ok(CurveBenchResult {
        stats,
        elapsed: start.elapsed(),
    })
}

fn bench_ecdsa_verify_parallel(
    cases: &[EcdsaCase],
    workers: usize,
) -> Result<CurveBenchResult, String> {
    let worker_count = workers.min(cases.len()).max(1);
    let chunk_size = (cases.len() + worker_count - 1) / worker_count;
    let start = Instant::now();

    let stats = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for chunk in cases.chunks(chunk_size) {
            handles.push(scope.spawn(move || -> Result<CurveStats, String> {
                let secp = Secp256k1::verification_only();
                let mut stats = CurveStats::default();
                for case in chunk {
                    stats.add(verify_ecdsa_case(&secp, case)?);
                }
                Ok(stats)
            }));
        }

        let mut combined = CurveStats::default();
        for handle in handles {
            combined.merge(handle.join().expect("worker thread panicked")?);
        }
        Ok::<CurveStats, String>(combined)
    })?;

    Ok(CurveBenchResult {
        stats,
        elapsed: start.elapsed(),
    })
}

fn bench_ecdsa_sign_serial(cases: &[EcdsaCase]) -> Result<CurveBenchResult, String> {
    let secp = Secp256k1::signing_only();
    let start = Instant::now();
    let mut stats = CurveStats::default();

    for case in cases {
        stats.add(sign_ecdsa_case(&secp, case)?);
    }

    Ok(CurveBenchResult {
        stats,
        elapsed: start.elapsed(),
    })
}

fn bench_ecdsa_sign_parallel(
    cases: &[EcdsaCase],
    workers: usize,
) -> Result<CurveBenchResult, String> {
    let worker_count = workers.min(cases.len()).max(1);
    let chunk_size = (cases.len() + worker_count - 1) / worker_count;
    let start = Instant::now();

    let stats = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for chunk in cases.chunks(chunk_size) {
            handles.push(scope.spawn(move || -> Result<CurveStats, String> {
                let secp = Secp256k1::signing_only();
                let mut stats = CurveStats::default();
                for case in chunk {
                    stats.add(sign_ecdsa_case(&secp, case)?);
                }
                Ok(stats)
            }));
        }

        let mut combined = CurveStats::default();
        for handle in handles {
            combined.merge(handle.join().expect("worker thread panicked")?);
        }
        Ok::<CurveStats, String>(combined)
    })?;

    Ok(CurveBenchResult {
        stats,
        elapsed: start.elapsed(),
    })
}

fn bench_cet_template_serial(obligations: &[Obligation]) -> StressBenchResult {
    let start = Instant::now();
    let mut stats = StressStats::default();
    for obligation in obligations {
        stats.add(build_cet_template(obligation));
    }
    StressBenchResult {
        stats,
        elapsed: start.elapsed(),
    }
}

fn bench_cet_template_parallel(obligations: &[Obligation], workers: usize) -> StressBenchResult {
    parallel_stress(obligations, workers, build_cet_template)
}

fn bench_oracle_fanout_serial(obligations: &[Obligation]) -> StressBenchResult {
    let start = Instant::now();
    let mut stats = StressStats::default();
    for obligation in obligations {
        stats.add(build_oracle_fanout(obligation));
    }
    StressBenchResult {
        stats,
        elapsed: start.elapsed(),
    }
}

fn bench_oracle_fanout_parallel(obligations: &[Obligation], workers: usize) -> StressBenchResult {
    parallel_stress(obligations, workers, build_oracle_fanout)
}

fn parallel_stress(
    obligations: &[Obligation],
    workers: usize,
    op: fn(&Obligation) -> (usize, [u8; 32]),
) -> StressBenchResult {
    let worker_count = workers.min(obligations.len()).max(1);
    let chunk_size = (obligations.len() + worker_count - 1) / worker_count;
    let start = Instant::now();

    let stats = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for chunk in obligations.chunks(chunk_size) {
            handles.push(scope.spawn(move || {
                let mut stats = StressStats::default();
                for obligation in chunk {
                    stats.add(op(obligation));
                }
                stats
            }));
        }

        let mut combined = StressStats::default();
        for handle in handles {
            combined.merge(handle.join().expect("worker thread panicked"));
        }
        combined
    });

    StressBenchResult {
        stats,
        elapsed: start.elapsed(),
    }
}

fn bench_json_serialization(obligations: &[Obligation]) -> Result<StressBenchResult, String> {
    let summaries = obligation_json_summaries(obligations);
    let start = Instant::now();
    let encoded = serde_json::to_vec(&summaries)
        .map_err(|e| format!("failed to serialize obligation summaries: {e}"))?;
    let checksum = digest_bytes(&encoded);
    let elapsed = start.elapsed();

    Ok(StressBenchResult {
        stats: StressStats {
            checked: obligations.len(),
            bytes: encoded.len(),
            checksum,
        },
        elapsed,
    })
}

fn bench_json_parse(obligations: &[Obligation]) -> Result<StressBenchResult, String> {
    let summaries = obligation_json_summaries(obligations);
    let encoded = serde_json::to_vec(&summaries)
        .map_err(|e| format!("failed to serialize parse input: {e}"))?;
    let start = Instant::now();
    let parsed: Vec<Value> = serde_json::from_slice(&encoded)
        .map_err(|e| format!("failed to parse obligation summaries: {e}"))?;
    let checksum = digest_bytes(format!("{}|{}", parsed.len(), encoded.len()));
    let elapsed = start.elapsed();

    Ok(StressBenchResult {
        stats: StressStats {
            checked: parsed.len(),
            bytes: encoded.len(),
            checksum,
        },
        elapsed,
    })
}

fn bench_persistence_writes(
    obligations: &[Obligation],
    output_path: &PathBuf,
) -> Result<StressBenchResult, String> {
    let scratch = output_path.with_file_name("ark_liquidity_governor_bench_io_scratch.jsonl");
    let file = fs::File::create(&scratch).map_err(|e| {
        format!(
            "failed to create persistence scratch {}: {e}",
            scratch.display()
        )
    })?;
    let mut writer = BufWriter::new(file);
    let start = Instant::now();
    let mut stats = StressStats::default();

    for obligation in obligations {
        let line = json!({
            "laneIndex": obligation.lane_index,
            "quoteId": obligation.quote_id,
            "vtxoCommitmentId": obligation.vtxo_commitment_id,
            "policyDigestHex": obligation.policy_digest_hex,
            "proofWorkDigestHex": obligation.proof_work_digest_hex,
        });
        let encoded = serde_json::to_vec(&line)
            .map_err(|e| format!("failed to encode persistence line: {e}"))?;
        writer
            .write_all(&encoded)
            .and_then(|_| writer.write_all(b"\n"))
            .map_err(|e| {
                format!(
                    "failed to write persistence scratch {}: {e}",
                    scratch.display()
                )
            })?;
        stats.checked += 1;
        stats.bytes += encoded.len() + 1;
        xor_into(&mut stats.checksum, &digest_bytes(&encoded));
    }

    writer.flush().map_err(|e| {
        format!(
            "failed to flush persistence scratch {}: {e}",
            scratch.display()
        )
    })?;
    let elapsed = start.elapsed();
    let _ = fs::remove_file(&scratch);

    Ok(StressBenchResult { stats, elapsed })
}

fn bench_binary_transcript_serialization(obligations: &[Obligation]) -> StressBenchResult {
    let start = Instant::now();
    let encoded = encode_binary_transcripts(obligations);
    let checksum = digest_bytes(&encoded);
    let elapsed = start.elapsed();

    StressBenchResult {
        stats: StressStats {
            checked: obligations.len(),
            bytes: encoded.len(),
            checksum,
        },
        elapsed,
    }
}

fn bench_binary_transcript_parse(obligations: &[Obligation]) -> Result<StressBenchResult, String> {
    let encoded = encode_binary_transcripts(obligations);
    let start = Instant::now();
    let parsed = decode_binary_transcripts(&encoded)?;
    let checksum = digest_bytes(format!("{}|{}", parsed.checked, parsed.bytes));
    let elapsed = start.elapsed();

    Ok(StressBenchResult {
        stats: StressStats {
            checked: parsed.checked,
            bytes: parsed.bytes,
            checksum,
        },
        elapsed,
    })
}

fn bench_binary_persistence_writes(
    obligations: &[Obligation],
    output_path: &PathBuf,
) -> Result<StressBenchResult, String> {
    let scratch = output_path.with_file_name("ark_liquidity_governor_bench_io_scratch.bin");
    let encoded = encode_binary_transcripts(obligations);
    let start = Instant::now();
    fs::write(&scratch, &encoded).map_err(|e| {
        format!(
            "failed to write binary persistence scratch {}: {e}",
            scratch.display()
        )
    })?;
    let elapsed = start.elapsed();
    let _ = fs::remove_file(&scratch);

    Ok(StressBenchResult {
        stats: StressStats {
            checked: obligations.len(),
            bytes: encoded.len(),
            checksum: digest_bytes(&encoded),
        },
        elapsed,
    })
}

fn build_cet_template(obligation: &Obligation) -> (usize, [u8; 32]) {
    let mut template = Vec::with_capacity(256);
    template.extend_from_slice(&2u32.to_le_bytes());
    template.extend_from_slice(&(obligation.lane_index as u32).to_le_bytes());
    template.extend_from_slice(&obligation.promised_inbound_sats.to_le_bytes());
    template.extend_from_slice(&obligation.delivered_inbound_sats.to_le_bytes());
    template.extend_from_slice(&decode_hex_32(&obligation.vtxo_commitment_id).unwrap_or_default());
    template.extend_from_slice(&decode_hex_32(&obligation.payment_hash_hex).unwrap_or_default());
    template.extend_from_slice(&digest_bytes(&obligation.policy_digest_hex));
    template.extend_from_slice(&digest_bytes(format!(
        "cet-output|{}|{}|{}",
        obligation.quote_id, obligation.observed_fee_ppm, obligation.observed_cltv_delta
    )));
    let checksum = digest_bytes(&template);
    (template.len(), checksum)
}

fn encode_binary_transcripts(obligations: &[Obligation]) -> Vec<u8> {
    const RECORD_LEN: usize = 4 + 8 + 8 + 8 + 8 + 8 + 32 + 32 + 32 + 32;
    let mut out = Vec::with_capacity(8 + obligations.len() * RECORD_LEN);
    out.extend_from_slice(b"ALGOV1\0\0");

    for obligation in obligations {
        out.extend_from_slice(&(obligation.lane_index as u32).to_le_bytes());
        out.extend_from_slice(&obligation.promised_inbound_sats.to_le_bytes());
        out.extend_from_slice(&obligation.delivered_inbound_sats.to_le_bytes());
        out.extend_from_slice(&obligation.max_fee_ppm.to_le_bytes());
        out.extend_from_slice(&obligation.observed_fee_ppm.to_le_bytes());
        out.extend_from_slice(&obligation.observed_cltv_delta.to_le_bytes());
        out.extend_from_slice(&decode_hex_32(&obligation.vtxo_commitment_id).unwrap_or_default());
        out.extend_from_slice(&decode_hex_32(&obligation.payment_hash_hex).unwrap_or_default());
        out.extend_from_slice(&decode_hex_32(&obligation.policy_digest_hex).unwrap_or_default());
        out.extend_from_slice(
            &decode_hex_32(&obligation.proof_work_digest_hex).unwrap_or_default(),
        );
    }

    out
}

fn decode_binary_transcripts(bytes: &[u8]) -> Result<StressStats, String> {
    const HEADER_LEN: usize = 8;
    const RECORD_LEN: usize = 4 + 8 + 8 + 8 + 8 + 8 + 32 + 32 + 32 + 32;
    if bytes.len() < HEADER_LEN || &bytes[..HEADER_LEN] != b"ALGOV1\0\0" {
        return Err("invalid binary transcript header".to_string());
    }
    let payload_len = bytes.len() - HEADER_LEN;
    if payload_len % RECORD_LEN != 0 {
        return Err("invalid binary transcript length".to_string());
    }

    let mut stats = StressStats {
        checked: payload_len / RECORD_LEN,
        bytes: bytes.len(),
        checksum: [0u8; 32],
    };
    for chunk in bytes[HEADER_LEN..].chunks_exact(RECORD_LEN) {
        xor_into(&mut stats.checksum, &digest_bytes(chunk));
    }
    Ok(stats)
}

fn build_oracle_fanout(obligation: &Obligation) -> (usize, [u8; 32]) {
    let mut combined = [0u8; 32];
    let mut bytes = 0usize;
    for outcome in 0..16u16 {
        let digest = digest_bytes(format!(
            "oracle-outcome|{}|{}|{}|{}|{}",
            obligation.quote_id,
            obligation.vtxo_commitment_id,
            obligation.lane_index,
            outcome,
            obligation.promised_inbound_sats + u64::from(outcome)
        ));
        xor_into(&mut combined, &digest);
        bytes += 32;
    }
    (bytes, combined)
}

fn verify_ecdsa_case<C: secp256k1::Verification>(
    secp: &Secp256k1<C>,
    case: &EcdsaCase,
) -> Result<(bool, [u8; 32]), String> {
    let message = Message::from_digest_slice(&case.message_digest)
        .map_err(|e| format!("failed to rebuild verify message: {e}"))?;
    let ok = secp
        .verify_ecdsa(&message, &case.signature, &case.public_key)
        .is_ok();
    let checksum = digest_bytes(case.signature.serialize_compact());
    Ok((ok, checksum))
}

fn sign_ecdsa_case<C: secp256k1::Signing>(
    secp: &Secp256k1<C>,
    case: &EcdsaCase,
) -> Result<(bool, [u8; 32]), String> {
    let message = Message::from_digest_slice(&case.message_digest)
        .map_err(|e| format!("failed to rebuild sign message: {e}"))?;
    let signature = secp.sign_ecdsa(&message, &case.secret_key);
    let checksum = digest_bytes(signature.serialize_compact());
    Ok((signature == case.signature, checksum))
}

fn verify_obligation(obligation: &Obligation, work_factor: usize) -> (bool, usize, [u8; 32]) {
    let mut violations = 0;

    if obligation.asset_tag != "asset_agnostic_ln_liquidity" {
        violations += 1;
    }
    if obligation.vtxo_amount_sats < obligation.promised_inbound_sats {
        violations += 1;
    }
    if obligation.delivered_inbound_sats < obligation.promised_inbound_sats {
        violations += 1;
    }
    if obligation.observed_fee_ppm > obligation.max_fee_ppm {
        violations += 1;
    }
    if obligation.observed_cltv_delta > obligation.max_cltv_delta {
        violations += 1;
    }
    if !is_hex_32(&obligation.exit_txid) {
        violations += 1;
    }
    if !is_hex_32(&obligation.forfeit_txid) {
        violations += 1;
    }

    let preimage = decode_hex_32(&obligation.preimage_hex);
    match preimage {
        Ok(preimage) => {
            if sha256_hex(&preimage) != obligation.payment_hash_hex {
                violations += 1;
            }
        }
        Err(_) => violations += 1,
    }

    let policy = policy_digest(obligation);
    if policy != obligation.policy_digest_hex {
        violations += 1;
    }

    let work = proof_work_digest(obligation, work_factor);
    if work != obligation.proof_work_digest_hex {
        violations += 1;
    }

    let checksum = digest_bytes(format!(
        "{}|{}|{}|{}",
        obligation.lane_index, obligation.quote_id, policy, work
    ));

    (violations == 0, violations, checksum)
}

impl VerifyStats {
    fn add(&mut self, result: (bool, usize, [u8; 32])) {
        self.checked += 1;
        if result.0 {
            self.ok += 1;
        } else {
            self.slashable += 1;
        }
        self.violations += result.1;
        xor_into(&mut self.checksum, &result.2);
    }

    fn merge(&mut self, other: VerifyStats) {
        self.checked += other.checked;
        self.ok += other.ok;
        self.slashable += other.slashable;
        self.violations += other.violations;
        xor_into(&mut self.checksum, &other.checksum);
    }
}

impl CurveStats {
    fn add(&mut self, result: (bool, [u8; 32])) {
        self.checked += 1;
        if result.0 {
            self.ok += 1;
        }
        xor_into(&mut self.checksum, &result.1);
    }

    fn merge(&mut self, other: CurveStats) {
        self.checked += other.checked;
        self.ok += other.ok;
        xor_into(&mut self.checksum, &other.checksum);
    }
}

impl StressStats {
    fn add(&mut self, result: (usize, [u8; 32])) {
        self.checked += 1;
        self.bytes += result.0;
        xor_into(&mut self.checksum, &result.1);
    }

    fn merge(&mut self, other: StressStats) {
        self.checked += other.checked;
        self.bytes += other.bytes;
        xor_into(&mut self.checksum, &other.checksum);
    }
}

fn policy_digest(obligation: &Obligation) -> String {
    sha256_hex(
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            POLICY_PREFIX,
            obligation.asset_tag,
            obligation.asp_id,
            obligation.template_id,
            obligation.quote_id,
            obligation.vtxo_commitment_id,
            obligation.promised_inbound_sats,
            obligation.max_fee_ppm,
            obligation.max_cltv_delta,
            obligation.exit_txid,
            obligation.forfeit_txid,
        )
        .as_bytes(),
    )
}

fn proof_work_digest(obligation: &Obligation, work_factor: usize) -> String {
    let mut state = digest_bytes(format!(
        "{}|{}|{}|{}|{}",
        obligation.lane_index,
        obligation.policy_digest_hex,
        obligation.payment_hash_hex,
        obligation.preimage_hex,
        obligation.delivered_inbound_sats,
    ));

    for round in 0..work_factor {
        let mut hasher = Sha256::new();
        hasher.update(state);
        hasher.update((round as u64).to_le_bytes());
        hasher.update(obligation.quote_id.as_bytes());
        state = hasher.finalize().into();
    }

    to_hex(&state)
}

fn result_json(result: &BenchResult) -> Value {
    json!({
        "checked": result.stats.checked,
        "ok": result.stats.ok,
        "slashable": result.stats.slashable,
        "violations": result.stats.violations,
        "elapsedMs": round(result.elapsed.as_secs_f64() * 1000.0, 3),
        "obligationsPerSecond": rate(result.stats.checked, result.elapsed),
        "checksum": to_hex(&result.stats.checksum)
    })
}

fn curve_result_json(result: &CurveBenchResult) -> Value {
    json!({
        "checked": result.stats.checked,
        "ok": result.stats.ok,
        "elapsedMs": round(result.elapsed.as_secs_f64() * 1000.0, 3),
        "operationsPerSecond": rate(result.stats.checked, result.elapsed),
        "checksum": to_hex(&result.stats.checksum)
    })
}

fn stress_result_json(result: &StressBenchResult) -> Value {
    json!({
        "checked": result.stats.checked,
        "bytes": result.stats.bytes,
        "elapsedMs": round(result.elapsed.as_secs_f64() * 1000.0, 3),
        "operationsPerSecond": rate(result.stats.checked, result.elapsed),
        "megabytesPerSecond": mb_rate(result.stats.bytes, result.elapsed),
        "checksum": to_hex(&result.stats.checksum)
    })
}

fn stats_match(a: &VerifyStats, b: &VerifyStats) -> bool {
    a.checked == b.checked
        && a.ok == b.ok
        && a.slashable == b.slashable
        && a.violations == b.violations
        && a.checksum == b.checksum
}

fn curve_stats_match(a: &CurveStats, b: &CurveStats) -> bool {
    a.checked == b.checked && a.ok == b.ok && a.checksum == b.checksum
}

fn stress_stats_match(a: &StressStats, b: &StressStats) -> bool {
    a.checked == b.checked && a.bytes == b.bytes && a.checksum == b.checksum
}

fn curve_speedup(serial: &CurveBenchResult, parallel: &CurveBenchResult) -> f64 {
    if parallel.elapsed.as_nanos() == 0 {
        0.0
    } else {
        serial.elapsed.as_secs_f64() / parallel.elapsed.as_secs_f64()
    }
}

fn stress_speedup(serial: &StressBenchResult, parallel: &StressBenchResult) -> f64 {
    if parallel.elapsed.as_nanos() == 0 {
        0.0
    } else {
        serial.elapsed.as_secs_f64() / parallel.elapsed.as_secs_f64()
    }
}

fn obligation_json_summaries(obligations: &[Obligation]) -> Vec<Value> {
    obligations
        .iter()
        .map(|obligation| {
            json!({
                "laneIndex": obligation.lane_index,
                "assetTag": obligation.asset_tag,
                "aspId": obligation.asp_id,
                "templateId": obligation.template_id,
                "quoteId": obligation.quote_id,
                "vtxoCommitmentId": obligation.vtxo_commitment_id,
                "promisedInboundSats": obligation.promised_inbound_sats,
                "deliveredInboundSats": obligation.delivered_inbound_sats,
                "maxFeePpm": obligation.max_fee_ppm,
                "observedFeePpm": obligation.observed_fee_ppm,
                "maxCltvDelta": obligation.max_cltv_delta,
                "observedCltvDelta": obligation.observed_cltv_delta,
                "paymentHashHex": obligation.payment_hash_hex,
                "policyDigestHex": obligation.policy_digest_hex,
                "proofWorkDigestHex": obligation.proof_work_digest_hex,
            })
        })
        .collect()
}

fn secret_key_for_index(seed: &ArtifactSeed, index: usize) -> Result<SecretKey, String> {
    let mut attempt = 0u64;
    loop {
        let digest = digest_bytes(format!(
            "cet-secret|{}|{}|{}|{}",
            seed.bundle_id, seed.quote_id, index, attempt
        ));
        if let Ok(key) = SecretKey::from_slice(&digest) {
            return Ok(key);
        }
        attempt += 1;
        if attempt > 16 {
            return Err(format!(
                "failed to derive valid secret key for index {index}"
            ));
        }
    }
}

fn get_str(value: &Value, path: &[&str]) -> Result<String, String> {
    let v = descend(value, path)?;
    v.as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{} must be a string", path.join(".")))
}

fn get_u64(value: &Value, path: &[&str]) -> Result<u64, String> {
    let v = descend(value, path)?;
    v.as_u64()
        .ok_or_else(|| format!("{} must be a u64", path.join(".")))
}

fn get_u64_string(value: &Value, path: &[&str]) -> Result<u64, String> {
    get_str(value, path)?
        .parse::<u64>()
        .map_err(|e| format!("{} must be a u64 string: {e}", path.join(".")))
}

fn descend<'a>(value: &'a Value, path: &[&str]) -> Result<&'a Value, String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor
            .get(*key)
            .ok_or_else(|| format!("missing JSON path {}", path.join(".")))?;
    }
    Ok(cursor)
}

fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&digest_bytes(bytes))
}

fn digest_bytes(bytes: impl AsRef<[u8]>) -> [u8; 32] {
    Sha256::digest(bytes.as_ref()).into()
}

fn decode_hex_32(hex: &str) -> Result<[u8; 32], String> {
    if !is_hex_32(hex) {
        return Err("expected 32-byte hex".to_string());
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("bad hex byte at {i}: {e}"))?;
    }
    Ok(out)
}

fn is_hex_32(value: &str) -> bool {
    value.len() == 64 && value.as_bytes().iter().all(|b| b.is_ascii_hexdigit())
}

fn to_hex(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn xor_into(target: &mut [u8; 32], value: &[u8; 32]) {
    for (a, b) in target.iter_mut().zip(value.iter()) {
        *a ^= *b;
    }
}

fn parse_usize(key: &str, value: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|e| format!("{key} must be a positive integer: {e}"))
}

fn default_workers() -> usize {
    thread::available_parallelism()
        .unwrap_or(NonZeroUsize::new(1).expect("1 is non-zero"))
        .get()
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn rate(count: usize, elapsed: Duration) -> u64 {
    if elapsed.as_nanos() == 0 {
        return 0;
    }
    (count as f64 / elapsed.as_secs_f64()).round() as u64
}

fn mb_rate(bytes: usize, elapsed: Duration) -> f64 {
    if elapsed.as_nanos() == 0 {
        return 0.0;
    }
    round(bytes as f64 / 1_000_000.0 / elapsed.as_secs_f64(), 3)
}

fn round(value: f64, decimals: i32) -> f64 {
    let factor = 10_f64.powi(decimals);
    (value * factor).round() / factor
}

fn help_text() -> String {
    [
        "ark-liquidity-governor-bench",
        "",
        "Options:",
        "  --artifact <path>       Ark graft artifact JSON",
        "  --output <path>         Benchmark report JSON",
        "  --obligations <n>       Synthetic route obligations to verify",
        "  --work-factor <n>       SHA256 rounds per obligation, modeling proof/signature work",
        "  --workers <n>           Parallel worker threads",
        "  --bad-every <n>         Make every nth obligation slashable; 0 disables",
        "",
        "Also runs real rust-secp256k1 ECDSA sign/verify benchmarks for the same count.",
    ]
    .join("\n")
}
