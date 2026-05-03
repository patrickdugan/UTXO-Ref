# UTXORef Live Path Evidence

Created: 2026-05-03T05:18:22.242Z
Network: litecoin-testnet
Verification: ok

## Path

- Funding outpoint: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:1
- TradeLayer send txid: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
- State oracle hash: c1a461ff7ff1d3a74fed3bc3f39decf6dcf621cff4894bd140607ab8c73390ce
- Registry hash: e2057a8fb6fcfd3da569c56dec6978e416c4ec3f9595df7875b0f90052509986
- Route transcript hash: 80c7e112c60277d8b94bc5ee873a19ae3a3cceccc524767bae770bb29d85af65
- Final route transcript hash: 1c60c061559ed785164541307ac00e4b293ee5c85e466fbbf6a23641d93d0cf3
- Withdrawal root: fc1d5bace84265ee2cf3295a15270e9b9a2241837349634a99ed82bcf682f4e4
- Final tx output hash: 363bc988d896f0238a97b7f01b356ba4d40d61947f9fa8e3a64d94ff578b231d
- Final spend binding: 16ea421fbce3e6855b969b58234b303761e08986db31deda31f59d8f83698a3f
- Stack hash: 39c88b5dd329d45446220dbd404431390664386a26381f5997eea7190a23a405
- Dashboard view hash: 4351fb39d6d191ba86e38e04d8a63044a75414b55bf167962fb95437be603e3d

## Challenge Evidence

- Send fraud bundle: 43dc573cbd3cbf99d5fd3a89ffacac647ac84c723de5c22028bc43d6cfc16fbd
- Checkpoint fraud proof: 5f06cfa4e2cd973af987f21ad5a797e9664eaaa9f370a6a47ae3d2c56908253c
- Final output challenge: d9c9ae09fc434c47da90b180517abd743e692a23791050286056f484fd746ae6
- Challengeable count: 14

## Operator Checklist

- funding_input: ready_for_rpc (gettxout ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff 1)
- state_oracle: bound (c1a461ff7ff1d3a74fed3bc3f39decf6dcf621cff4894bd140607ab8c73390ce)
- route_transcript: bound (80c7e112c60277d8b94bc5ee873a19ae3a3cceccc524767bae770bb29d85af65)
- final_outputs: bound (363bc988d896f0238a97b7f01b356ba4d40d61947f9fa8e3a64d94ff578b231d)
- dashboard: ready (4351fb39d6d191ba86e38e04d8a63044a75414b55bf167962fb95437be603e3d)

## Live Swap Points

- Consensus input: replace sample consensus input with TradeLayer parser output
- Decoded final tx: replace deterministic decodedFinalTx with Core decoderawtransaction output
- Signer policy: show finalTxOutputHash and routeTranscriptHash before broadcast
- Dashboard: display txids and hashes from evidence.core only after verification
