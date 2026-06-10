# UTXORef Live Path Evidence

Created: 2026-06-10T15:56:30.785Z
Network: litecoin-testnet
Verification: ok

## Path

- Funding outpoint: ac2518f11bff1c6f229b9431dbc91d0f0d280dcde2b90de7e46c627a8b5dbbae:0
- TradeLayer send txid: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
- State oracle hash: c1a461ff7ff1d3a74fed3bc3f39decf6dcf621cff4894bd140607ab8c73390ce
- Registry hash: e2057a8fb6fcfd3da569c56dec6978e416c4ec3f9595df7875b0f90052509986
- Route transcript hash: 4afe1288e188211c5a0659a9c0017706736b0dba5052b33765fd27b789330670
- Final route transcript hash: c92a8ed3c8b9bb16270aaec85ce9c51935cb7cbad0ccf2fe039e1176fe96371d
- Withdrawal root: af637696b95f847cd58d7498a058227b52c447f5ec72020d8ef0b61d3c668a1a
- Final tx output hash: 916733d3eca4f5eb3837cf59462efefa425db716ade6691bbe5641dd41bd67c6
- Final output review: 6b397dd3e91d74966dc64ccefbe6008bc101e1bd2ec3ed9039dbb542c5b09e4a
- Final spend binding: d632edd431de11f1e5d0457e0408e1f28194f8b98d268aaf3dffb370929649a5
- Stack hash: 63121b5db0875db8b27d45cb83aaddc63973681645b97e42cf0fddc67714bcc6
- Dashboard view hash: aa0b67a217acd5563aebb34921a4f69c24f79daba5df4f59254a59448ef52f10

## Challenge Evidence

- Send fraud bundle: ef4d00e7698b7acf398dc3ca09b430d8d126f56653eff7a920222d6287761529
- Checkpoint fraud proof: 5f06cfa4e2cd973af987f21ad5a797e9664eaaa9f370a6a47ae3d2c56908253c
- Final output challenge: 815bd8b2f91c64d6ccb5048cf43cc65a71590c6a78120fcadb972b9cbd84485b
- Challengeable count: 14

## Final Output Review

- ok

## Operator Checklist

- funding_input: ready_for_rpc (gettxout ac2518f11bff1c6f229b9431dbc91d0f0d280dcde2b90de7e46c627a8b5dbbae 0)
- state_oracle: bound (c1a461ff7ff1d3a74fed3bc3f39decf6dcf621cff4894bd140607ab8c73390ce)
- route_transcript: bound (4afe1288e188211c5a0659a9c0017706736b0dba5052b33765fd27b789330670)
- final_outputs: bound (6b397dd3e91d74966dc64ccefbe6008bc101e1bd2ec3ed9039dbb542c5b09e4a)
- dashboard: ready (aa0b67a217acd5563aebb34921a4f69c24f79daba5df4f59254a59448ef52f10)

## Live Swap Points

- Consensus input: replace sample consensus input with TradeLayer parser output
- Decoded final tx: replace deterministic decodedFinalTx with Core decoderawtransaction output
- Signer policy: show finalTxOutputHash, finalOutputReviewHash, and routeTranscriptHash before broadcast
- Dashboard: display txids and hashes from evidence.core only after verification
