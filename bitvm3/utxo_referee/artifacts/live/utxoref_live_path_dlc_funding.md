# UTXORef Live Path Evidence

Created: 2026-06-10T16:30:35.541Z
Network: litecoin-testnet
Verification: ok

## Path

- Funding outpoint: 3e8d784efab4a8b65d127267b441bfdf4a28aff7b46fa90c05f21113cfd001d7:1
- TradeLayer send txid: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
- State oracle hash: ada4eb124882b4c31d7ead4032fcd72e3e02c2556ae37d8c479b553f40762520
- Registry hash: cb63dff1dfd63529e6691db4b515ea71c28d9e7cff456ca791aa35c7bbf2307d
- Route transcript hash: 270f694621e8b5370808f587e613e10f3258c2ed7e42714585c7ada5f7c99064
- Final route transcript hash: 3406f28e200f63f411cb223cadcc93949991b95887a71a5239c1b30d210865ae
- Withdrawal root: 551a22d33941125e0ccb507306bf1881ab767f38dfe8634ed63dd93214bd02ed
- Final tx output hash: 6016cbff6db8d18e172e776be4ed38da737989a170dedc57f62be9d0e3fca3a4
- Final output review: 5ab17cf6d0001320776d5ed3b3370fe8450ae6b92d3221df46b1ea35cf94493a
- Final spend binding: 041475e9348cf11cceb470a669163f15af0a7cac0d1dffeb14248bec16be07da
- Stack hash: 0b7f5d6d38a45ec26ac13c7a2b88e41e75fff932eb11b57431ae5826be480bcf
- Dashboard view hash: 0efc51330e9f5222547cdbe6930c1b2e10ae16eafedb676ae2c82bb54adb1eb3

## Challenge Evidence

- Send fraud bundle: 84476043452f67b388789e61eb63acaad20a22fce1580839172c64c587b6ab03
- Checkpoint fraud proof: 5f06cfa4e2cd973af987f21ad5a797e9664eaaa9f370a6a47ae3d2c56908253c
- Final output challenge: 6a3495abea92669cb96e02c4d09f271306f968381f14b4032a993fe65ac690a7
- Challengeable count: 14

## Final Output Review

- ok

## Operator Checklist

- funding_input: ready_for_rpc (gettxout 3e8d784efab4a8b65d127267b441bfdf4a28aff7b46fa90c05f21113cfd001d7 1)
- state_oracle: bound (ada4eb124882b4c31d7ead4032fcd72e3e02c2556ae37d8c479b553f40762520)
- route_transcript: bound (270f694621e8b5370808f587e613e10f3258c2ed7e42714585c7ada5f7c99064)
- final_outputs: bound (5ab17cf6d0001320776d5ed3b3370fe8450ae6b92d3221df46b1ea35cf94493a)
- dashboard: ready (0efc51330e9f5222547cdbe6930c1b2e10ae16eafedb676ae2c82bb54adb1eb3)

## Live Swap Points

- Consensus input: replace sample consensus input with TradeLayer parser output
- Decoded final tx: replace deterministic decodedFinalTx with Core decoderawtransaction output
- Signer policy: show finalTxOutputHash, finalOutputReviewHash, and routeTranscriptHash before broadcast
- Dashboard: display txids and hashes from evidence.core only after verification
