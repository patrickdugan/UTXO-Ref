'use strict';

const assert = require('node:assert/strict');
const { buildDlcFundingOutput } = require('../../bitvm3/utxo_referee/dlc_funding_output');
const { sats, btc, outputs } = require('./regtest-core');

const FUNDING_SEQUENCE = 0xffffffff;

function ownAddress(rpc, wallet, address) {
  const info = rpc('getaddressinfo', [address], wallet);
  assert(info.ismine && !info.iswatchonly, wallet + ' must own ' + address);
  return info.scriptPubKey;
}

function verifyTemplate(tx, template) {
  assert.equal(tx.version, template.version, 'funding version changed');
  assert.equal(tx.locktime, 0, 'funding locktime changed');
  assert.deepEqual(tx.vin.map(({ txid, vout, sequence, scriptSig }) => [txid, vout, sequence, scriptSig.hex]),
    template.inputs.map(({ txid, vout }) => [txid, vout, FUNDING_SEQUENCE, '']), 'funding inputs changed');
  assert.deepEqual(outputs(tx), template.outputs, 'funding outputs changed');
}

function verifyFundingPsbt(rpc, psbt, template, plan, parties, verifier) {
  const decoded = rpc('decodepsbt', [psbt]);
  verifyTemplate(decoded.tx, template);
  assert.equal(decoded.tx.txid, template.txid, 'funding txid changed');
  assert.equal(sats(decoded.fee), parties.reduce((sum, party) => sum + party.feeSats, 0), 'funding fee mismatch');

  // The verifier sees the complete proposal and checks both contributions
  // against Core's live view. Only its own wallet authorizes its addresses.
  assert.equal(ownAddress(rpc, verifier.wallet, verifier.payoutAddress), plan.terms[verifier.wallet + 'PayoutScript']);
  assert.equal(ownAddress(rpc, verifier.wallet, verifier.changeAddress), verifier.changeScript);
  if (verifier.wallet === 'trader') {
    assert.equal(ownAddress(rpc, verifier.wallet, verifier.anchorAddress), plan.terms.anchorScript);
  }
  const outputsByParty = [plan.terms.traderPayoutScript, plan.terms.makerPayoutScript];
  assert.deepEqual(parties.map((party) => rpc('validateaddress', [party.payoutAddress]).scriptPubKey), outputsByParty);
  for (const [index, party] of parties.entries()) {
    const { txid, vout, scriptPubKey, valueSats } = party.input;
    const coin = rpc('gettxout', [txid, vout, true]);
    assert(coin?.confirmations >= 1 && coin.scriptPubKey.type === 'witness_v0_keyhash', 'input must be confirmed native P2WPKH');
    assert.equal(coin.scriptPubKey.hex, scriptPubKey);
    assert.equal(sats(coin.value), valueSats);
    const witnessUtxo = decoded.inputs[index].witness_utxo;
    assert.equal(witnessUtxo?.scriptPubKey.hex, scriptPubKey, 'PSBT prevout script changed');
    assert.equal(sats(witnessUtxo.amount), valueSats, 'PSBT prevout amount changed');
    if (party === verifier) assert.equal(ownAddress(rpc, party.wallet, party.input.address), scriptPubKey);
    const collateral = Number(plan.terms[party.wallet + 'CollateralSats']);
    const exitBudget = index === 0 ? Number(plan.terms.settlementFeeSats) + Number(plan.terms.anchorSats) : 0;
    assert.equal(party.contributionSats, collateral + exitBudget);
    assert.deepEqual(template.outputs[index + 1], {
      valueSats: valueSats - collateral - exitBudget - party.feeSats,
      scriptPubKeyHex: rpc('validateaddress', [party.changeAddress]).scriptPubKey
    });
    assert(template.outputs[index + 1].valueSats > 1000, 'change below rehearsal minimum');
  }
  return decoded;
}

function prepareFunding(rpc, plan, parties) {
  assert.equal(plan.terms.network, 'bitcoin-regtest');
  const funding = buildDlcFundingOutput({
    partyPubkeyXs: [plan.terms.traderPubkeyX, plan.terms.makerPubkeyX].sort(),
    refundCsvBlocks: plan.terms.refundCsvBlocks
  });
  const script = funding.scriptPubKeyHex;
  const descriptor = rpc('getdescriptorinfo', ['rawtr(' + script.slice(4) + ')']).descriptor;
  const [fundingAddress] = rpc('deriveaddresses', [descriptor]);
  assert.equal(rpc('validateaddress', [fundingAddress]).scriptPubKey, script);
  const inputs = parties.map(({ input: { txid, vout } }) => ({ txid, vout, sequence: FUNDING_SEQUENCE }));
  assert.equal(new Set(inputs.map(({ txid, vout }) => txid + ':' + vout)).size, 2, 'duplicate funding input');
  const fundingOutputs = [{ valueSats: Number(plan.fundingValueSats), scriptPubKeyHex: script },
    ...parties.map((party) => ({ valueSats: party.input.valueSats - party.contributionSats - party.feeSats,
      scriptPubKeyHex: party.changeScript }))];
  assert.equal(parties.reduce((sum, party) => sum + party.contributionSats, 0), fundingOutputs[0].valueSats);
  const addresses = [fundingAddress, ...parties.map((party) => party.changeAddress)];
  const psbtOutputs = addresses.map((address, index) => ({ [address]: btc(fundingOutputs[index].valueSats) }));
  const psbt = rpc('utxoupdatepsbt', [rpc('createpsbt', [inputs, psbtOutputs, 0, false])]);
  const { tx } = rpc('decodepsbt', [psbt]);
  const template = { txid: tx.txid, version: tx.version, inputs, outputs: fundingOutputs };
  for (const party of parties) verifyFundingPsbt(rpc, psbt, template, plan, parties, party);
  return { psbt, template };
}

function signFunding(rpc, { psbt, template }, plan, parties) {
  const partials = parties.map((party, index) => {
    verifyFundingPsbt(rpc, psbt, template, plan, parties, party);
    const partial = rpc('walletprocesspsbt', [psbt, true, 'ALL', false, false], party.wallet);
    assert.equal(partial.complete, false, party.wallet + ' should sign only its input');
    const decoded = verifyFundingPsbt(rpc, partial.psbt, template, plan, parties, party);
    assert.deepEqual(decoded.inputs.map((input) => Object.keys(input.partial_signatures || {}).length),
      parties.map((_, i) => Number(i === index)), 'unexpected funding signature coverage');
    return partial.psbt;
  });
  const combinedPsbt = rpc('combinepsbt', [partials]);
  for (const party of parties) verifyFundingPsbt(rpc, combinedPsbt, template, plan, parties, party);
  const finalized = rpc('finalizepsbt', [combinedPsbt]);
  assert.equal(finalized.complete, true);
  const tx = rpc('decoderawtransaction', [finalized.hex]);
  verifyTemplate(tx, template);
  assert.equal(tx.txid, template.txid, 'final funding txid differs from the pre-signed outpoint');
  assert(tx.vin.every(({ txinwitness }) => txinwitness?.length === 2));
  return { combinedPsbt, rawTxHex: finalized.hex, tx };
}

module.exports = { prepareFunding, signFunding, ownAddress };
