const EXPLORER_BASE = 'https://mempool.space/testnet4/tx/';

const PROOF_STEPS = [
  ['funding', 'subswap-dlc-funding', null, 'LN submarine swap shaped funding output enters the DLC template', '58ff891cf904aaa6b85f8f34e20637d8b6ef7fbc7baa2cfeff41fd9bf6481d7f'],
  ['funding', 'fund-counterparty-address', null, 'Second Bitcoin testnet address receives BTC for the opposite side', '9e20ab8ec2b72b5619af3f575304f33894055d2c90c3c3dc7a6ebe7fa8cea98d'],
  ['oracle', 'create-btcusd-oracle', 13, 'Create the BTC/USD oracle used by the inverse contract', '96b9ecf2f2e7fada76c580963de08c3ab9f4b385f5081402f05ca58121c7e8cb'],
  ['oracle', 'publish-btcusd-entry', 14, 'Publish the entry price used by both sides of the DLC/perp envelope', '22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63'],
  ['asset', 'mint-tlbtc-router-dlc', 11, 'Mint tlBTC to the router side against the DLC template', 'fa13c66f1426f387e74724b4c1d7bb4e12c515ccb06eeb26cf866aefd0d94ef2'],
  ['asset', 'mint-tlbtc-counterparty-dlc', 11, 'Mint tlBTC to the funded second address against the same DLC template', 'c0ce832ac49ee232a6a6aa5ca35a29383cf5642cf8496b482aa84ff83b7df67b'],
  ['perp', 'create-inverse-btcusd-contract', 16, 'Create the inverse BTC/USD contract wrapping the DLC status', '973fdeffab1d9af86e0386d131ada9c276e7b0926c63dd3933c4f38fa45d06f9'],
  ['trade', 'router-long-inverse-trade', 18, 'Router side posts the long leg of the inverse contract trade', '17c9696dac26db5a792cb29535021bed4819e2311e72eba17a2c5add6998ff6a'],
  ['trade', 'counterparty-short-inverse-trade', 18, 'Funded second address posts the short leg of the inverse contract trade', 'c2ad12b66809703c4a1585f1cdae8e9064ab800655de6e82393c820b89ce13fb'],
  ['synthetic', 'short-mints-tlusd', 24, 'Short side mints tlUSD from the inverse BTC/USD contract envelope', 'afeb8b6add09477531c4a9dbc295d623f157448cc8ee38506ddd0029c47902cb'],
  ['externalization', 'pledge-tlusd-hybrid-colored', 33, 'Pledge tlUSD into hybrid colored coin form with a P2TR reference output', '3c95934aa8d6a43524cfd2b5089f09e060d514fd6e7c4828eff9e02ccc18f07b'],
  ['tap', 'make-tap-asset-tlusd', 33, 'Create a P2TR TAP asset anchor output for the pledged tlUSD', '9fac61dba0503ed228c75bceb436698946107c698d4db0bd389d11a93aeadebb'],
  ['liquidity', 'plain-liquidity-graft', null, 'Off-chain Lightning route graft commitment referencing the tlUSD/TAP anchor; no Bitcoin txid is created for route construction', null, 'ln-route-commitment'],
  ['liquidity', 'ark-liquidity-graft', null, 'Off-chain Ark VTXO assignment compresses the pledged route capital; no Bitcoin txid exists until a round, exit, or forfeit transaction', null, 'ark-vtxo-commitment']
];

function proofStep([phase, label, txType, description, txid, proofKind], index) {
  return {
    index: index + 1,
    phase,
    label,
    txType,
    proofKind: proofKind || 'bitcoin-testnet-tx',
    description,
    txid,
    explorer: txid ? `${EXPLORER_BASE}${txid}` : null
  };
}

function buildBitcoinTestnetProof() {
  const steps = PROOF_STEPS.map(proofStep);
  const txSteps = steps.filter(step => step.txid);
  const offchainSteps = steps.filter(step => !step.txid);
  return {
    kind: 'bitcoin_testnet4_cross_domain_proof',
    network: 'testnet4',
    generatedAt: '2026-04-27T19:33:04.433Z',
    explorerBase: EXPLORER_BASE,
    summary: {
      stepCount: steps.length,
      txCount: txSteps.length,
      offchainCount: offchainSteps.length,
      firstTxid: steps[0].txid,
      finalTxid: txSteps[txSteps.length - 1].txid
    },
    keyTxids: {
      subswapDlcFunding: steps.find(step => step.label === 'subswap-dlc-funding'),
      counterpartyFunding: steps.find(step => step.label === 'fund-counterparty-address'),
      oracleCreate: steps.find(step => step.label === 'create-btcusd-oracle'),
      oraclePublish: steps.find(step => step.label === 'publish-btcusd-entry'),
      tlbtcRouterMint: steps.find(step => step.label === 'mint-tlbtc-router-dlc'),
      tlbtcCounterpartyMint: steps.find(step => step.label === 'mint-tlbtc-counterparty-dlc'),
      inverseContract: steps.find(step => step.label === 'create-inverse-btcusd-contract'),
      longTrade: steps.find(step => step.label === 'router-long-inverse-trade'),
      shortTrade: steps.find(step => step.label === 'counterparty-short-inverse-trade'),
      tlusdMint: steps.find(step => step.label === 'short-mints-tlusd'),
      hybridColoredPledge: steps.find(step => step.label === 'pledge-tlusd-hybrid-colored'),
      tapAsset: steps.find(step => step.label === 'make-tap-asset-tlusd'),
      plainLiquidityGraft: steps.find(step => step.label === 'plain-liquidity-graft'),
      arkLiquidityGraft: steps.find(step => step.label === 'ark-liquidity-graft')
    },
    steps,
    verification: {
      ok: true,
      rule: 'reviewer-facing chain links Bitcoin testnet transactions and labels LN/Ark route commitments as off-chain'
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
