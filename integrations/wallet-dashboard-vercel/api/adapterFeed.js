const crypto = require('crypto');

function id(prefix, input) {
  return `${prefix}_${crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 20)}`;
}

function event(adapter, sourceType, index, fields = {}) {
  const eventId = id(adapter, `${sourceType}:${index}:${fields.correlationId || ''}`);
  return {
    id: eventId,
    adapter,
    sourceType,
    normalizedType: fields.normalizedType || sourceType,
    status: fields.status || 'observed',
    amountSats: fields.amountSats || null,
    amountUnits: fields.amountUnits || null,
    correlationId: fields.correlationId || eventId,
    evidence: fields.evidence || id('evidence', eventId),
    dashboardImpact: fields.dashboardImpact || 'updates reviewer feed'
  };
}

function buildLdkEvents() {
  return [
    event('ldk', 'ChannelReady', 0, {
      normalizedType: 'channel_ready',
      status: 'ready',
      amountSats: 2500000,
      correlationId: 'ln-channel-utxoref-0',
      dashboardImpact: 'marks outbound liquidity source available'
    }),
    event('ldk', 'PaymentClaimable', 1, {
      normalizedType: 'payment_claimable',
      status: 'claimable',
      amountSats: 49000,
      correlationId: 'lnbtc-subswap-0',
      dashboardImpact: 'opens subswap funding edge'
    }),
    event('ldk', 'PaymentClaimed', 2, {
      normalizedType: 'payment_claimed',
      status: 'settled',
      amountSats: 49000,
      correlationId: 'lnbtc-subswap-0',
      dashboardImpact: 'confirms preimage path'
    }),
    event('ldk', 'PaymentPathFailed', 3, {
      normalizedType: 'path_failed',
      status: 'recoverable',
      amountSats: 12000,
      correlationId: 'ln-retry-1',
      dashboardImpact: 'activates failure injection HTLC timeout path'
    }),
    event('ldk', 'HTLCHandlingFailed', 4, {
      normalizedType: 'htlc_failed',
      status: 'recoverable',
      amountSats: 8000,
      correlationId: 'ln-htlc-guard-0',
      dashboardImpact: 'feeds BitVM shortfall watcher'
    })
  ];
}

function buildArkEvents() {
  return [
    event('bark-ark', 'VtxoBatchQuoted', 0, {
      normalizedType: 'ark_batch_quote',
      status: 'quoted',
      amountSats: 2733452548,
      correlationId: 'ark-batch-5000',
      dashboardImpact: 'prices batched liquidity patching'
    }),
    event('bark-ark', 'VtxoAssigned', 1, {
      normalizedType: 'vtxo_assigned',
      status: 'assigned',
      amountSats: 2865787500,
      correlationId: 'ark-batch-5000',
      dashboardImpact: 'maps route demand to VTXO references'
    }),
    event('bark-ark', 'ExitPrepared', 2, {
      normalizedType: 'ark_exit_prepared',
      status: 'armed',
      amountSats: 420000,
      correlationId: 'ark-exit-shortfall-0',
      dashboardImpact: 'supports forced-exit failure path'
    })
  ];
}

function buildTaprootAssetEvents() {
  return [
    event('taproot-assets', 'AssetTransferQuoted', 0, {
      normalizedType: 'asset_transfer_quote',
      status: 'quoted',
      amountUnits: 49000000,
      correlationId: 'ta-usd-rfq-0',
      dashboardImpact: 'backs Taproot Asset USD mode'
    }),
    event('taproot-assets', 'AssetProofVerified', 1, {
      normalizedType: 'asset_proof_verified',
      status: 'verified',
      amountUnits: 40000000,
      correlationId: 'ta-usd-stake-0',
      dashboardImpact: 'proves wallet stake can externalize to asset proof'
    })
  ];
}

function buildTradeLayerEvents() {
  return [
    event('tradelayer', 'Tx33SyntheticUsdQuoted', 0, {
      normalizedType: 'tx33_tlusd_quote',
      status: 'quoted',
      amountUnits: 49000000,
      correlationId: 'tl-tx33-quote-0',
      dashboardImpact: 'backs TradeLayer synthetic USD mode'
    }),
    event('tradelayer', 'PerpCollateralChecked', 1, {
      normalizedType: 'perp_collateral_checked',
      status: 'verified',
      amountSats: 57647059,
      correlationId: 'tl-btcusd-perp-0',
      dashboardImpact: 'links BTC/USD perp collateral to TLUSD mint envelope'
    })
  ];
}

function adapterSummary(name, events, contractMethods) {
  return {
    name,
    status: 'fixture-replay',
    eventCount: events.length,
    lastEventType: events[events.length - 1].sourceType,
    contractMethods
  };
}

function buildAdapterFeed() {
  const ldk = buildLdkEvents();
  const ark = buildArkEvents();
  const taprootAssets = buildTaprootAssetEvents();
  const tradeLayer = buildTradeLayerEvents();
  const events = [...ldk, ...ark, ...taprootAssets, ...tradeLayer];
  return {
    kind: 'utxoref_layer_adapter_feed',
    generatedAt: '2026-04-26T00:00:00.000Z',
    feedId: id('adapterfeed', events.map(item => item.id).join(':')),
    adapters: {
      ldk: adapterSummary('LDK event adapter', ldk, ['normalizePaymentEvent', 'subscribePayments', 'mapHtlcFailure']),
      ark: adapterSummary('Bark / Ark adapter', ark, ['quoteBatch', 'assignVtxo', 'prepareExit']),
      taprootAssets: adapterSummary('Taproot Assets adapter', taprootAssets, ['quoteTransfer', 'verifyProof', 'subscribeTransfers']),
      tradeLayer: adapterSummary('TradeLayer tx33 adapter', tradeLayer, ['quoteTx33Tlusd', 'readPerpState', 'verifyCollateral'])
    },
    events,
    verification: {
      ok: true,
      adaptersCovered: 4,
      normalizedEvents: events.length,
      requiredAdapters: ['ldk', 'ark', 'taprootAssets', 'tradeLayer']
    }
  };
}

module.exports = {
  buildAdapterFeed,
  buildLdkEvents,
  buildArkEvents,
  buildTaprootAssetEvents,
  buildTradeLayerEvents
};
