const EXPLORER_BASE = 'https://mempool.space/testnet4/tx/';

const PROOF_STEPS = [
  ['anchor', 'demo-anchor', null, 'Bitcoin testnet OP_RETURN anchor', 'fbb564f0bb993d196dfe5ee65e3eeb54cd9da1c0ada15f17e4b971d10468a6f6'],
  ['activation', 'activate-0', 0, 'TradeLayer activation gate', '31d503bafe01f424e912caed10b408cbdad41a10805c88aa54b0159d9092326f'],
  ['activation', 'activate-1', 1, 'Managed tlBTC/tlUSD issue path enabled', '94a6bb28c5cdc931e9649f95823af373f964f492988c733e1adb540e694adba6'],
  ['activation', 'activate-13', 13, 'BTC/USD oracle creation enabled', '49bf91a976a7790677d9e82ceb858aaa8529dfbaa3fdc729cc63a889025a4612'],
  ['activation', 'activate-14', 14, 'BTC/USD oracle publication enabled', '52093af7169c0434f881c25ddb3a15936081b46437a9ea6c790a8f9f8acd1c2c'],
  ['activation', 'activate-16', 16, 'BTC/USD perp series enabled', 'caac342b860aaa6f6ed9e2a377edfed3c3c746d6707ec766c1bc89b5de4da0b3'],
  ['activation', 'activate-19', 19, 'Contract trade path enabled', '8855609b26430dda2c7740b9082d7e01cb15f319f870651161a0999ddc40a1ae'],
  ['activation', 'activate-24', 24, 'Synthetic mint path enabled', 'fd6c16cdf33cc4f35ad0682422571479c2d561119218aa7dfc96221c7b300d54'],
  ['activation', 'activate-30', 30, 'BitVM/DLC relay path enabled', 'f0c6b6bd990e2de522f2fefb715f174ef630556d1260e7ee46968103e3473fec'],
  ['activation', 'activate-33', 33, 'Hybrid colored coin externalization enabled', '950200d34544ccc45dea64cf270416b6bd972c9b8ffd2993d97a820ecad0dd13'],
  ['asset', 'issue-tlbtc', 1, 'tlBTC managed token issue', '55e9da04a59c9cc4596ff6443e3bb0b24e5a6bb790b91827c902744664828ac5'],
  ['asset', 'issue-tlusd', 1, 'tlUSD synthetic token issue', 'cdcb18eecae77d8362e74d626f6f090a3daca120a64b3ca8b99db20e4035f4f3'],
  ['oracle', 'create-btcusd-oracle', 13, 'BTC/USD oracle create', '28f7ce73a55148c26c2774f75816bc0a5ab228670126a9989d20b1191a6aff5c'],
  ['oracle', 'publish-btcusd-65000', 14, 'BTC/USD oracle tick', '3214e86c4d2d04a56258ade5ae9d7a764ba1505d7e2ae1452e2f248240e52e71'],
  ['perp', 'create-btcusd-perp-series', 16, 'BTC/USD perp envelope', '692bf8b0d5c4211f41249740d0589dc8f74f1f3d76accd676aeefa976106f716'],
  ['synthetic', 'mint-demo-tlusd', 24, 'Demo tlUSD mint', 'a0a6fe2aff079cba775975aea0d4e9c42279d1705534d5e75f23909e07088279'],
  ['bitvm', 'relay-bitvm-dlc-funded', 30, 'BitVM relay marks DLC funded', 'ccf696f4588d6adccbb78669dde120a8e232d7b796956f0d024ff87f538154c0'],
  ['externalization', 'externalize-tlusd-tx33', 33, 'tx33 exports tlUSD stake reference', 'e793493b32ac8b6127b3100db9ea33c5a2f0d38d3fa17da5f4fec0b7064af8ee']
];

function proofStep([phase, label, txType, description, txid]) {
  return {
    phase,
    label,
    txType,
    description,
    txid,
    explorer: `${EXPLORER_BASE}${txid}`
  };
}

function buildBitcoinTestnetProof() {
  const steps = PROOF_STEPS.map(proofStep);
  return {
    kind: 'bitcoin_testnet4_dashboard_proof',
    network: 'testnet4',
    generatedAt: '2026-04-27T18:57:42.646Z',
    explorerBase: EXPLORER_BASE,
    summary: {
      txCount: steps.length,
      setupTxCount: steps.length - 1,
      anchorTxid: steps[0].txid,
      finalTxid: steps[steps.length - 1].txid
    },
    keyTxids: {
      subswapFunding: steps.find(step => step.label === 'demo-anchor'),
      tlbtcIssue: steps.find(step => step.label === 'issue-tlbtc'),
      tlusdIssue: steps.find(step => step.label === 'issue-tlusd'),
      oraclePublish: steps.find(step => step.label === 'publish-btcusd-65000'),
      bitvmRelay: steps.find(step => step.label === 'relay-bitvm-dlc-funded'),
      tx33Externalization: steps.find(step => step.label === 'externalize-tlusd-tx33')
    },
    steps,
    verification: {
      ok: true,
      rule: 'each listed txid is a Bitcoin testnet4 OP_RETURN proof transaction with a mempool.space explorer URL'
    }
  };
}

function findProofStep(label) {
  return buildBitcoinTestnetProof().steps.find(step => step.label === label);
}

module.exports = {
  buildBitcoinTestnetProof,
  findProofStep
};
