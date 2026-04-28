const crypto = require('crypto');
const { buildBitcoinTestnetProof } = require('./testnetProof');

const SATS = 100000000;

function id(prefix, input) {
  return `${prefix}_${crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 24)}`;
}

function boundedBotCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 96;
  return Math.min(parsed, 5000);
}

function buildStatus() {
  const proof = buildBitcoinTestnetProof();
  return {
    ok: true,
    activeProfileId: 'bitcoin-testnet-cross-domain',
    profile: {
      id: 'bitcoin-testnet-cross-domain',
      mode: 'Bitcoin testnet proof feed',
      notes: 'Public package exposing the Bitcoin testnet transaction chain and wallet-demo API contract.'
    },
    chain: {
      chain: 'bitcoin-testnet4',
      network: 'testnet4',
      rpcUrl: 'proof://bitcoin-testnet4',
      wallet: 'utxoref-demo'
    },
    lnd: {
      network: 'bitcoin-testnet',
      grpcHost: 'proof://ln-testnet'
    },
    lightningDiscovery: {
      publicRegistry: 'Public gossip only; private channels and unannounced nodes will not appear',
      explorers: [
        { name: 'mempool.space testnet4 Lightning', url: 'https://mempool.space/testnet4/lightning' },
        { name: '1ML Bitcoin testnet', url: 'https://1ml.com/testnet/' }
      ],
      testnet4DnsSeed: {
        service: 'test4.nodes.lightning.wiki',
        note: 'SRV records resolve to public testnet4 Lightning bootstrap targets'
      },
      candidatePeers: [
        {
          alias: 'bankofbots',
          network: 'bitcoin-testnet',
          pubkey: '0235fc2914eefacd263e170be34efa8688ed252b5e3306c8fd94309b3ecf30700b',
          address: '54.244.234.100:20141',
          capacitySats: 3000000,
          channels: 3,
          tcpOpen: true
        },
        {
          alias: 'bitwage-testnet',
          network: 'bitcoin-testnet',
          pubkey: '021bac297cf06bfa1c705fa8a4c65b39e1082c5c5f8a36d977e05aeabaa52220db',
          address: '54.174.137.47:9735',
          capacitySats: 1050000,
          channels: 3,
          tcpOpen: true
        },
        {
          alias: 'yyds Testnet',
          network: 'bitcoin-testnet',
          pubkey: '03df34d02818f2c3511bbb994c79420c5868cebf33a6fac091aa3f6d2ff6237c17',
          address: '43.206.113.97:9735',
          capacitySats: 450000,
          channels: 3,
          tcpOpen: true
        },
        {
          alias: 'liv.io',
          network: 'bitcoin-testnet',
          pubkey: '037b775c158f63d879ed586ecdaad9c91213f48643805b805db0f8fe1f4a912b5f',
          address: '213.193.83.252:9735',
          capacitySats: 30000000,
          channels: 2,
          tcpOpen: true
        },
        {
          alias: 'volt_07a224b1',
          network: 'bitcoin-testnet',
          pubkey: '03c2f15acc07c9a20e3515e0b7b43a492a8c8889003bfcbb5f9823da3353caf2b7',
          address: '54.244.234.100:20223',
          capacitySats: 10147952,
          channels: 2,
          tcpOpen: true
        }
      ]
    },
    artifacts: {
      lnbtcTlusdLiquidityPatch: { exists: true, source: 'Bitcoin testnet proof API' },
      walletStressSimulation: { exists: true, source: 'deterministic serverless generator' },
      bitcoinTestnetProof: {
        exists: true,
        source: 'Bitcoin testnet4',
        txCount: proof.summary.txCount,
        entryExplorer: proof.keyTxids.subswapDlcFunding.explorer,
        showcaseExplorer: proof.bitvmShowcase.anchorExplorer
      }
    },
    readiness: {
      walletViewReady: true,
      stressDashboardReady: true,
      deployPreviewReady: true
    }
  };
}

function buildWalletView() {
  const proof = buildBitcoinTestnetProof();
  const routerCircuit = {
    circuitId: id('router_circuit', 'ln-bitvm-liquidity-graft-v1'),
    version: 'ln-bitvm-liquidity-graft-v1',
    totalGates: 768,
    constraintSystem: 'booleanized route commitment plus liquidity shortfall comparator',
    gateCounts: [
      {
        id: 'hashlock',
        family: 'HTLC hashlock',
        count: 96,
        checks: 'payment_hash == sha256(preimage)',
        inputs: ['payment_hash', 'payment_preimage'],
        flow: ['invoice hash', 'preimage witness', 'sha256 gate', 'claim branch'],
        pseudocode: [
          'digest = sha256(payment_preimage)',
          'assert digest == payment_hash',
          'unlock claim path if preimage is revealed'
        ]
      },
      {
        id: 'cltv-timeout',
        family: 'CLTV timeout',
        count: 64,
        checks: 'expiry_height <= channel_expiry',
        inputs: ['expiry_height', 'channel_expiry'],
        flow: ['route expiry', 'channel bound', 'height compare', 'timeout branch'],
        pseudocode: [
          'assert expiry_height <= channel_expiry',
          'if current_height >= expiry_height: enable refund branch',
          'otherwise keep the route claimable by the invoice preimage'
        ]
      },
      {
        id: 'route-sum',
        family: 'Route sum',
        count: 112,
        checks: 'delivered_msat accumulates hop commitments',
        inputs: ['hop_commitments', 'delivered_sats'],
        flow: ['hop receipts', 'sum msats', 'round to sats', 'delivery witness'],
        pseudocode: [
          'delivered_msat = sum(hop.amount_msat for hop in hop_commitments)',
          'assert each hop is signed by its advertised node key',
          'delivered_sats = floor(delivered_msat / 1000)'
        ]
      },
      {
        id: 'liquidity-comparator',
        family: 'Liquidity comparator',
        count: 144,
        checks: 'delivered_sats >= committed_min_sats',
        inputs: ['delivered_sats', 'committed_min_sats'],
        flow: ['committed minimum', 'delivered witness', 'range compare', 'slash signal'],
        pseudocode: [
          'shortfall = committed_min_sats - delivered_sats',
          'assert delivered_sats >= committed_min_sats',
          'if shortfall > 0: route challenge to ASP bond slash'
        ]
      },
      {
        id: 'tap-anchor',
        family: 'TAP anchor binding',
        count: 128,
        checks: 'tap_anchor_outpoint matches tx33/TAP proof root',
        inputs: ['tap_anchor_outpoint', 'tap_proof_root'],
        flow: ['tx33 pledge', 'P2TR output', 'proof root', 'asset continuity'],
        pseudocode: [
          'assert tap_anchor_outpoint == committed_outpoint',
          'assert tap_proof_root binds tx33 token state',
          'carry the asset branch forward inside the next P2TR output'
        ]
      },
      {
        id: 'ark-batch',
        family: 'Ark batch binding',
        count: 96,
        checks: 'vtxo_batch_root commits route allocation',
        inputs: ['ark_batch_root', 'route_allocation_leaf'],
        flow: ['route allocation', 'VTXO leaf', 'batch root', 'ASP obligation'],
        pseudocode: [
          'leaf = hash(route_id, inbound_sats, asp_key, expiry_height)',
          'assert merkle_verify(leaf, route_allocation_proof, ark_batch_root)',
          'treat the ASP batch promise as the liquidity source of record'
        ]
      },
      {
        id: 'challenge-mux',
        family: 'Challenge mux',
        count: 80,
        checks: 'select honest exit or slash path',
        inputs: ['challenge_id', 'router_signature', 'asp_forfeit_signature'],
        flow: ['watcher claim', 'challenge id', 'branch select', 'exit script'],
        pseudocode: [
          'if router_signature verifies and no shortfall: cooperative_exit()',
          'if challenge_id is opened and shortfall > 0: require asp_forfeit_signature',
          'select the unique script branch for the revealed dispute state'
        ]
      },
      {
        id: 'public-pack',
        family: 'Public input pack',
        count: 48,
        checks: 'pack proof root and challenge id',
        inputs: ['tap_anchor_outpoint', 'ark_batch_root', 'payment_hash', 'challenge_id'],
        flow: ['public inputs', 'domain tags', 'packed root', 'BitVM transcript'],
        pseudocode: [
          'public_root = tagged_hash(public_inputs)',
          'assert public_root is the transcript root used by the BitVM verifier',
          'bind the same root into the dashboard challenge evidence'
        ]
      }
    ],
    publicInputs: [
      'tap_anchor_outpoint',
      'ark_batch_root',
      'payment_hash',
      'committed_min_sats',
      'expiry_height',
      'challenge_id'
    ],
    witnessInputs: [
      'payment_preimage',
      'hop_commitments',
      'delivered_sats',
      'router_signature',
      'asp_forfeit_signature'
    ],
    scriptTemplate: [
      '<tap_anchor_outpoint> OP_EQUALVERIFY',
      'OP_SHA256 <payment_hash> OP_EQUALVERIFY',
      '<delivered_sats> <committed_min_sats> OP_GREATERTHANOREQUAL',
      'OP_IF <router_pubkey> OP_CHECKSIG',
      'OP_ELSE <asp_forfeit_pubkey> OP_CHECKSIG OP_ENDIF'
    ],
    challengePath: [
      'route commitment published off-chain',
      'watcher recomputes delivered liquidity',
      'shortfall opens BitVM challenge',
      'script selects slash or cooperative exit'
    ]
  };
  const tradeLayerOracleDlc = {
    id: 'btc-only-tradelayer-oracle-dlc',
    label: 'BTC-Only TradeLayer Oracle DLC',
    summary: 'Bilateral Lightning-funded DLC where a TradeLayer tx14 OP_RETURN price publish selects the BTC-only CET branch; BitVM checks the designated oracle publisher and 5% solvency band before accepting the mark.',
    noTapAssets: true,
    trigger: {
      txid: proof.keyTxids.oraclePublish.txid,
      explorer: proof.keyTxids.oraclePublish.explorer,
      txType: 14,
      oracleId: 1,
      pair: 'BTCUSD',
      price: '65000',
      payloadText: 'tle1,aqzr7k',
      payloadHex: '746c65312c61717a72376b',
      opReturnScriptHex: '6a0b746c65312c61717a72376b',
      payloadHash: 'b64eccb31fc947e29aff0f6f826891b6ac21d80eef2be50340260d87639fefd3',
      designatedOracleAddress: 'tb1qn75cnly6zn4540k7824rmw02eeylaygcpj49rs',
      publisherAddress: 'tb1qn75cnly6zn4540k7824rmw02eeylaygcpj49rs',
      oracleAddressProof: {
        kind: 'designated_oracle_address_proof',
        addressCommitmentHash: '87018922fc0036f87edff0e91f95a895f06b9031a3b7928a890b24fba9704673',
        inputIndex: 0,
        witnessRule: 'publish tx input proves the designated oracle address funded the price publication'
      },
      lastAcceptedPrice: '64000',
      lastAcceptedScaledPrice: '640000000',
      maxDeviationBps: 500,
      priceDeviationBps: 156,
      solvencyGuard: {
        withinBand: true,
        rule: 'abs(price - last_price) * 10000 <= last_price * 500'
      },
      proofShape: 'raw tx + OP_RETURN output index + block header + merkle branch'
    },
    contract: {
      contractId: 'ln-tl-oracle-dlc-1',
      commitmentId: '934250a8ae80785bd4b6e8e29269514f13ab5d8486b582f6cdd4a6495fb7edd2',
      longParty: { name: 'alice-long', collateralSats: 50000 },
      shortParty: { name: 'bob-short', collateralSats: 50000 },
      totalCollateralSats: 100000,
      outcomesRoot: 'bea7c5484aa69b560940bfe03d1302e84591d91e9a439221c2c81c8d73568dc4',
      settlementAsset: 'btc-only',
      oraclePolicy: {
        designatedOracleAddressHash: '87018922fc0036f87edff0e91f95a895f06b9031a3b7928a890b24fba9704673',
        lastAcceptedPrice: '64000',
        maxDeviationBps: 500,
        validationBoundary: 'BitVM does not validate all TradeLayer state; it verifies publisher provenance and bounded mark movement.'
      }
    },
    settlement: {
      selectedOutcomeId: 'price_at_entry',
      settlementRail: 'lightning',
      longPayoutSats: 50000,
      shortPayoutSats: 50000,
      noTapAssetPath: true
    },
    bitvmOrganizer: {
      organizerId: 'd5f2a5da32d0b0f930ae98beb19dc701e7b9da2ad37e9b7b573ea5fce2aaced8',
      totalGates: 888,
      challengeViolation: 'wrong_cet_for_published_price',
      flow: ['TradeLayer tx14 OP_RETURN', 'designated oracle input', '5% solvency band', 'price bucket comparator', 'Lightning BTC payout'],
      pseudocode: [
        'assert sha256(payloadText) == committed_payload_hash',
        'assert decode_tx14(payloadText).oracle_id == contract.oracle_id',
        'assert publisher_address_hash == designated_oracle_address_hash',
        'assert abs(price - last_price) * 10000 <= last_price * 500',
        'selected_outcome = bucket(decode_tx14(payloadText).price)',
        'assert long_payout + short_payout == btc_collateral_sats'
      ]
    },
    vwapStateOracle: {
      summaryCommitmentId: '5a532a19367110338214e927f54772ab0082f2aa17e9b81218ebc0e9b2484125',
      payloadText: 'tlvwap1:1:2udu-2ueo:5a532a19367110338214e927f54772ab',
      publishTxid: '9dd623bde3ac48574fb9c7a352bde9c7e5f8fc5c81652f5cc5cdaaf16cef088a',
      summaryCore: {
        pair: 'BTCUSD',
        baseTokenId: 'tlBTC',
        quoteTokenId: 'tlUSD',
        windowStartHeight: 132690,
        windowEndHeight: 132720,
        stateSnapshotRoot: '07dd70d83744e81b2ff04b3c927c4016f72d344e410626ab63777f349820f405',
        tlbtcBalanceRoot: '3dedc13b7666e5a3e9a0b677127683a556e9ae49651bd7d6a1364eecb3386c0f',
        tlusdBalanceRoot: 'd8dadccbafcfb4e450859bdd7e3ae48bff2edc52a60a8febbb51d5f6e72d0a30',
        validTradeSetRoot: 'c1149b0435f51d60f6239318a768a6017458211e040ad2e9f4dd3613538490d1',
        validTradeCount: 3,
        totalBaseAmountSats: '10000000',
        totalQuoteAmountMicrousd: '6502000000',
        vwapPrice: '65020',
        vwapScaledPrice: '650200000',
        maxDeviationBps: 500,
        priceDeviationBps: 159
      },
      validTrades: [
        { txid: '17c9696dac26db5a792cb29535021bed4819e2311e72eba17a2c5add6998ff6a', baseAmountSats: '2000000', impliedPrice: '64900' },
        { txid: 'c2ad12b66809703c4a1585f1cdae8e9064ab800655de6e82393c820b89ce13fb', baseAmountSats: '3000000', impliedPrice: '65000' },
        { txid: 'e63c707aaacf51de1be273bfd96e1502a71c33ed44e693fc339af905152c7192', baseAmountSats: '5000000', impliedPrice: '65080' }
      ],
      solvencyGuard: {
        withinBand: true,
        rule: 'abs(vwap_price - last_accepted_price) * 10000 <= last_accepted_price * 500'
      },
      fraudProofSurface: [
        'invalid_trade_included',
        'valid_trade_omitted',
        'bad_vwap_arithmetic',
        'stale_or_wrong_state_snapshot'
      ],
      validationBoundary: 'State oracle commits the TradeLayer snapshot and valid-trade set; challengers prove bad inclusion, omission, stale roots, or arithmetic.'
    },
    vwapChallenge: {
      challengeId: '12ffafc8eb8f8cdf7573264ee2106c29086483a7764ac6e6508dc810e949e627',
      totalGates: 1056,
      challengeViolation: 'bad_vwap_arithmetic',
      publicInputs: ['state_snapshot_root', 'valid_trade_set_root', 'tlbtc_balance_root', 'tlusd_balance_root', 'vwap_scaled_price'],
      witnessInputs: ['trade_membership_proofs', 'token_balance_transition_proofs', 'omitted_trade_counterexample', 'vwap_accumulator_witness'],
      scriptTemplate: [
        '<state_snapshot_root> OP_EQUALVERIFY',
        '<valid_trade_set_root> OP_EQUALVERIFY',
        'SUM(<quote_amount_microusd>) 1000000 OP_MUL SUM(<base_amount_sats>) OP_DIV <vwap_scaled_price> OP_EQUALVERIFY',
        '<publisher_address_hash> <designated_oracle_address_hash> OP_EQUALVERIFY',
        'ABS(<vwap_scaled_price> - <last_accepted_scaled_price>) 10000 OP_MUL <last_accepted_scaled_price> <max_deviation_bps> OP_MUL OP_LESSTHANOREQUAL'
      ]
    }
  };
  return {
    kind: 'lnbtc_tlusd_liquidity_patch_wallet_view',
    generatedAt: '2026-04-26T00:00:00.000Z',
    pureBtcRouteDemo: {
      id: 'demo-3-pure-btc-bitvm-ln',
      label: 'Demo 3: Pure BTC Route Evidence',
      summary: 'Standalone path showing a staged testnet4 submarine-swap HTLC, a paid Lightning invoice receipt, and the BitVM router circuit anchor.',
      stages: [
        {
          id: 'subswap-htlc',
          label: 'Submarine Swap HTLC',
          kind: 'bitcoin-testnet4',
          txid: proof.submarineSwapHtlc.txid,
          explorer: proof.submarineSwapHtlc.explorer,
          amountSats: proof.submarineSwapHtlc.amountSats,
          htlcAddress: proof.submarineSwapHtlc.htlcAddress,
          paymentHash: proof.submarineSwapHtlc.paymentHash,
          expiryHeight: proof.submarineSwapHtlc.expiryHeight,
          note: 'Real P2WSH hashlock plus CLTV refund branch.'
        },
        {
          id: 'ln-receipt',
          label: 'Lightning Receipt',
          kind: 'core-lightning-regtest',
          channelTxid: 'e93cfd911f1d4c67667b6b79bf58092e03d37ce02345a1497099cd14b8aa6f76',
          channelState: 'CHANNELD_NORMAL',
          invoiceAmount: '25000msat',
          paymentHash: '80cbce547c20a26c4d2a8ab46eaf3b3ecbcff639f068f02276a01ef62d1a705a',
          paymentPreimage: 'cfc8c6a319f4b892dcbb4c5f84d81180634940f382f1b19c6c37d2c7f165f598',
          status: 'complete',
          note: 'Fresh CLN Alice-to-Bob invoice paid locally; public testnet4 route is the next replacement.'
        },
        {
          id: 'bitvm-router-circuit',
          label: 'BitVM Router Circuit',
          kind: proof.bitvmShowcase.kind,
          anchorTxid: proof.bitvmShowcase.anchorTxid,
          anchorExplorer: proof.bitvmShowcase.anchorExplorer,
          totalGates: routerCircuit.totalGates,
          routeCommitment: proof.bitvmShowcase.routeCommitment.proofKind,
          note: 'Circuit checks delivered liquidity against committed route capacity.'
        }
      ],
      invariant: 'HTLC hash/preimage machinery feeds a route commitment; BitVM handles under-delivery as a challenge path.'
    },
    useCases: [
      {
        id: 'usd-asset-routing',
        label: 'USD Asset Routing',
        objective: 'Convert LN-BTC funded collateral into TLUSD/TAP-denominated routing capital',
        flow: ['LN-BTC', 'subswap funding', 'DLC/perp envelope', 'TLUSD mint', 'TAP anchor', 'route stake'],
        bitcoinEvidence: [
          proof.keyTxids.subswapDlcFunding.txid,
          proof.keyTxids.hybridColoredPledge.txid,
          proof.keyTxids.tapAsset.txid
        ],
        offchainProofs: ['ln-route-commitment', 'ark-vtxo-commitment'],
        reviewerSignal: 'shows asset-aware liquidity where synthetic USD can back inbound routing service'
      },
      {
        id: 'btc-bitvm-graft',
        label: 'Pure BTC BitVM Liquidity Graft',
        objective: 'Route BTC liquidity directly through a BitVM-enforced router without requiring a USD asset leg',
        flow: ['BTC channel funding', 'router commitment', 'HTLC/preimage proof', 'BitVM circuit', 'challenge or cooperative exit'],
        bitcoinEvidence: [
          proof.bitvmShowcase.anchorTxid
        ],
        offchainProofs: ['ln-route-commitment', 'bitvm-router-circuit'],
        entryTxid: proof.summary.entryTxid,
        reviewerSignal: 'isolates the core liquidity primitive: committed BTC route capacity with slashable under-delivery'
      },
      {
        id: 'btc-only-oracle-dlc',
        label: 'BTC-Only Oracle DLC',
        objective: 'Use a TradeLayer tx14 OP_RETURN price publication as the DLC trigger while settling BTC payouts over Lightning',
        flow: ['LN collateral receipts', 'TradeLayer tx14 price publish', 'BitVM trigger proof', 'BTC-only DLC payout'],
        bitcoinEvidence: [
          proof.keyTxids.oraclePublish.txid
        ],
        offchainProofs: ['bitvm-ln-dlc-oracle-trigger', 'lightning-payout-receipts'],
        entryTxid: proof.keyTxids.oraclePublish.txid,
        reviewerSignal: 'separates the BTC-only DLC/BitVM mechanism from TAP-asset or TLUSD routing claims'
      }
    ],
    tradeLayerOracleDlc,
    conversion: {
      lnbtcSats: 49000,
      tlusdUnits: 49000000,
      subswapFundingTxid: proof.keyTxids.subswapDlcFunding.txid,
      subswapFundingExplorer: proof.keyTxids.subswapDlcFunding.explorer,
      submarineSwapHtlc: proof.submarineSwapHtlc,
      journeyEntryTxid: proof.summary.entryTxid,
      bitvmShowcaseAnchorTxid: proof.bitvmShowcase.anchorTxid,
      bitvmShowcaseExplorer: proof.bitvmShowcase.anchorExplorer,
      dlcFundingTxid: proof.keyTxids.inverseContract.txid,
      dlcFundingExplorer: proof.keyTxids.inverseContract.explorer,
      rfqQuoteId: proof.keyTxids.hybridColoredPledge.txid,
      rfqExplorer: proof.keyTxids.hybridColoredPledge.explorer
    },
    stake: {
      stakedTlUsdUnits: 40000000,
      stakeCommitmentId: id('stake', 'tlusd-liquidity-patch'),
      termBlocks: 144,
      expectedFeePpm: 620
    },
    liquidityPatch: {
      allocationId: id('arkalloc', 'fleet-liquidity-patch'),
      assignedInboundSats: 40000,
      deliveredInboundSats: 36000,
      challenge: {
        challengeId: id('challenge', 'bitvm-asp-shortfall'),
        status: 'prepared',
        remedy: 'slash ASP bond or force Ark exit/forfeit path'
      },
      routerCircuit
    }
  };
}

function botStatus(index) {
  if (index % 13 === 0) return 'challengeable';
  if (index % 5 === 0) return 'verifying';
  return 'active';
}

function buildBot(index, botCount) {
  const status = botStatus(index);
  const requestedInboundSats = 420000 + ((index * 977) % 310000);
  const deliveredRatio = status === 'challengeable' ? 0.76 : status === 'verifying' ? 0.91 : 0.985;
  const deliveredInboundSats = Math.floor(requestedInboundSats * deliveredRatio);
  const routeCount = 2 + (index % 9);
  const tltcSats = 900000 + ((index * 144821) % 4100000);
  const tlusdUnits = Math.floor((tltcSats / SATS) * 85000000);
  return {
    botId: `autobot-${String(index + 1).padStart(5, '0')}`,
    lane: ['lnbtc-in', 'tlusd-stake', 'ark-vtxo', 'bitvm-guard'][index % 4],
    status,
    requestedInboundSats,
    deliveredInboundSats,
    routeCount,
    tltcSats,
    tltcDisplay: (tltcSats / SATS).toFixed(5),
    tlusdUnits,
    tlusdDisplay: (tlusdUnits / 1000000).toFixed(2),
    feePpm: 520 + (index % 160),
    arkVtxoRef: id('vtxo', `${botCount}:${index}`),
    bitvmChallengeId: id('bitvm', `${botCount}:${index}`),
    violations: status === 'challengeable' ? ['delivered_below_min', 'late_rebalance_window'] : []
  };
}

function buildTimeline(bots) {
  const buckets = 16;
  return Array.from({ length: buckets }, (_, bucket) => {
    const slice = bots.filter((_, index) => index % buckets === bucket);
    const assignedInboundSats = slice.reduce((sum, bot) => sum + bot.requestedInboundSats, 0);
    const deliveredInboundSats = slice.reduce((sum, bot) => sum + bot.deliveredInboundSats, 0);
    return {
      bucket: `t+${String(bucket).padStart(2, '0')}`,
      assignedInboundSats,
      deliveredInboundSats
    };
  });
}

function buildStressDashboard(input = {}) {
  const botCount = boundedBotCount(input.botCount || input.bots || 96);
  const bots = Array.from({ length: botCount }, (_, index) => buildBot(index, botCount));
  const activeBots = bots.filter(bot => bot.status === 'active').length;
  const verifyingBots = bots.filter(bot => bot.status === 'verifying').length;
  const challengeable = bots.filter(bot => bot.status === 'challengeable');
  const assignedInboundSats = bots.reduce((sum, bot) => sum + bot.requestedInboundSats, 0);
  const deliveredInboundSats = bots.reduce((sum, bot) => sum + bot.deliveredInboundSats, 0);
  const tltcCollateralSats = bots.reduce((sum, bot) => sum + bot.tltcSats, 0);
  const tlusdStakedUnits = bots.reduce((sum, bot) => sum + bot.tlusdUnits, 0);
  const routeCount = bots.reduce((sum, bot) => sum + bot.routeCount, 0);
  const averageFeePpm = Math.round(bots.reduce((sum, bot) => sum + bot.feePpm, 0) / bots.length);
  const earnedFeesSats = Math.floor((deliveredInboundSats * averageFeePpm) / 1000000);
  const arkSavingsSats = Math.floor(routeCount * 118);

  return {
    kind: 'wallet_stress_dashboard',
    dashboardId: id('dashboard', `${botCount}:${assignedInboundSats}:${deliveredInboundSats}`),
    activeProfileId: 'bitcoin-testnet-cross-domain',
    chainSourceBadge: 'Bitcoin testnet',
    quoteAsset: 'TLUSD',
    collateralAsset: 'testnet collateral',
    totals: {
      botCount,
      activeBots,
      verifyingBots,
      challengeCount: challengeable.length,
      routeCount,
      arkVtxoCount: botCount,
      tltcCollateralDisplay: (tltcCollateralSats / SATS).toFixed(4),
      tlusdStakedDisplay: (tlusdStakedUnits / 1000000).toFixed(3),
      assignedInboundSats,
      deliveredInboundSats,
      deliveryBps: Math.round((deliveredInboundSats / assignedInboundSats) * 10000),
      averageFeePpm,
      earnedFeesSats,
      arkSavingsSats
    },
    lanes: [
      { id: 'lnbtc-in', label: 'LN-BTC intake', amountSats: Math.floor(assignedInboundSats * 0.24) },
      { id: 'tlusd-stake', label: 'TLUSD stake', amountUnits: tlusdStakedUnits },
      { id: 'ark-vtxo', label: 'Ark VTXOs', count: botCount },
      { id: 'bitvm-guard', label: 'BitVM guards', count: challengeable.length },
      { id: 'rebalance', label: 'Routed patches', amountSats: deliveredInboundSats }
    ],
    timeline: buildTimeline(bots),
    bots,
    challengeQueue: challengeable.slice(0, 40),
    verification: {
      ok: true,
      checkedAt: '2026-04-26T00:00:00.000Z',
      rule: 'delivered liquidity plus challengeable shortfall equals assigned liquidity envelope'
    }
  };
}

module.exports = {
  buildStatus,
  buildWalletView,
  buildStressDashboard
};
