//! Print each ELF's SP1 6.9.0 program key digest, computed as nb3-prove does.
use sha2::{Digest, Sha256};
use slop_algebra::PrimeField32;
use sp1_sdk::{Elf, HashableKey, Prover, ProverClient, ProvingKey};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = ProverClient::builder().cpu().build().await;
    for path in std::env::args().skip(1) {
        let elf = std::fs::read(&path)?;
        let pk = client.setup(Elf::from(elf.clone())).await?;
        let vk = pk.verifying_key();
        let digest: Vec<u8> = vk.hash_koalabear().iter().flat_map(|x| x.as_canonical_u32().to_le_bytes()).collect();
        println!("{} elf_sha256={} program_vk_digest={} vkey_bytes32={}", path, hex::encode(Sha256::digest(&elf)), hex::encode(digest), vk.bytes32());
    }
    Ok(())
}
