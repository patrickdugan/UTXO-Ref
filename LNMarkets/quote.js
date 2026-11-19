#!/usr/bin/env node
'use strict';

const { fetchReferenceQuote } = require('./src/market-data');

async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && !['--signet', '--mainnet'].includes(argv[0]))) {
    throw new Error('Usage: node LNMarkets/quote.js [--signet|--mainnet]');
  }
  const apiNetwork = argv[0] === '--mainnet' ? 'mainnet' : 'signet';
  console.log(JSON.stringify(await fetchReferenceQuote({ apiNetwork }), null, 2));
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
