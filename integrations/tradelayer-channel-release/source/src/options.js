const BigNumber = require('bignumber.js');

function bn(v) {
  return new BigNumber(v || 0);
}

class OptionsEngine {
  // "series-expiry-(C|P)-strike?"
  isOptionTicker(t) {
    return typeof t === 'string' && /^.+?-\d+-(C|P)(-\d+(\.\d+)?)?$/.test(t);
  }

  parseTicker(t) {
    if (!t || typeof t !== 'string') return null;
    const parts = t.split('-');
    if (parts.length < 3) return null;
    const seriesId = parts[0];
    const expiryBlock = parseInt(parts[1], 10);
    const cp = parts[2];
    const type = cp === 'C' ? 'Call' : (cp === 'P' ? 'Put' : null);
    const strike = parts[3] ? parseFloat(parts[3]) : null;
    if (!seriesId || Number.isNaN(expiryBlock) || !type) return null;
    return { seriesId, expiryBlock, type, strike, raw: t };
  }

  computeReduceFlip(existingQty, deltaQty) {
    const ex = Number(existingQty) || 0;
    const d = Number(deltaQty) || 0;
    const after = ex + d;

    const exSide = ex > 0 ? 'LONG' : ex < 0 ? 'SHORT' : null;
    const dSide = d > 0 ? 'LONG' : d < 0 ? 'SHORT' : null;

    let closedQty = 0;
    let flipQty = 0;

    if (ex !== 0 && d !== 0 && Math.sign(ex) !== Math.sign(d)) {
      closedQty = Math.min(Math.abs(ex), Math.abs(d));
      if (Math.abs(d) > Math.abs(ex)) {
        flipQty = Math.abs(d) - Math.abs(ex);
      }
    }

    const afterSide = after > 0 ? 'LONG' : after < 0 ? 'SHORT' : null;
    return { existing: ex, delta: d, after, exSide, dSide, afterSide, closedQty, flipQty };
  }

  rpnlForClose(exSide, closedQty, tradePrice, avgPrice) {
    const q = bn(closedQty);
    const p = bn(tradePrice);
    const a = bn(avgPrice);
    if (q.isZero() || !exSide) return bn(0);
    return exSide === 'LONG' ? p.minus(a).times(q) : a.minus(p).times(q);
  }

  intrinsic(type, K, S) {
    const k = bn(K);
    const s = bn(S);
    if (type === 'Call') return BigNumber.max(0, s.minus(k));
    return BigNumber.max(0, k.minus(s));
  }

  priceEUApprox(type, S, K, volAnnual, daysToExpiry) {
    const s = bn(S);
    const k = bn(K);
    const tYears = Math.max(0, Number(daysToExpiry || 0)) / 365;
    const iv = this.intrinsic(type, k, s);
    if (!volAnnual || !tYears) return iv;

    const sigma = Number(volAnnual);
    const v = s.times(sigma);
    const noise = v.times(Math.sqrt(tYears)).times(0.3989);
    return BigNumber.max(iv, iv.plus(noise));
  }

  nakedMaintenance(type, K, S) {
    if (type === 'Call') return bn(S).div(10);
    return bn(K).div(10);
  }

  mtmExposure(positions, S, volAnnual, blocksToExpiry, blocksPerDay) {
    const bpd = Math.max(1, Number(blocksPerDay || 144));
    const days = Math.max(0, Number(blocksToExpiry || 0) / bpd);
    let prem = bn(0);
    let intr = bn(0);
    for (const p of positions || []) {
      const price = this.priceEUApprox(p.type, S, p.strike, volAnnual, days);
      const qty = bn(p.qty || 0);
      prem = prem.plus(price.times(qty));
      intr = intr.plus(this.intrinsic(p.type, p.strike, S).times(qty));
    }
    return { premium: prem, intrinsic: intr };
  }

  portfolioMaintenance(positions, spot) {
    const byKey = new Map();
    for (const p of positions || []) {
      const type = p?.type;
      const expiry = Number(p?.expiryBlock || 0);
      if (!type) continue;
      const k = `${type}:${expiry}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({
        type,
        expiryBlock: expiry,
        strike: bn(p?.strike || 0),
        qty: bn(p?.qty || 0)
      });
    }

    let total = bn(0);

    for (const legs of byKey.values()) {
      const shorts = legs.filter((x) => x.qty.lt(0)).map((x) => ({ ...x, rem: x.qty.abs() }));
      const longs = legs.filter((x) => x.qty.gt(0)).map((x) => ({ ...x, rem: bn(x.qty) }));

      for (const s of shorts) {
        total = total.plus(this.nakedMaintenance(s.type, s.strike, spot).times(s.rem));
      }

      for (const s of shorts) {
        for (const l of longs) {
          if (s.rem.lte(0) || l.rem.lte(0)) continue;
          if (s.type !== l.type) continue;
          const protective =
            (s.type === 'Call' && l.strike.gt(s.strike)) ||
            (s.type === 'Put' && l.strike.lt(s.strike));
          if (!protective) continue;

          const coveredQty = BigNumber.min(s.rem, l.rem);
          const width = l.strike.minus(s.strike).abs();
          const offset = width.div(10).times(coveredQty);
          const maxOffset = this.nakedMaintenance(s.type, s.strike, spot).times(coveredQty);

          total = total.minus(BigNumber.min(offset, maxOffset));
          s.rem = s.rem.minus(coveredQty);
          l.rem = l.rem.minus(coveredQty);
        }
      }
    }

    return total.isNegative() ? bn(0) : total;
  }
}

const Options = new OptionsEngine();
module.exports = Options;
