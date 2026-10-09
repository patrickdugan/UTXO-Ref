const { buildBitcoinTestnetProof } = require('./testnetProof');

module.exports = function bitcoinTestnetProof(_req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.status(200).json(buildBitcoinTestnetProof());
};
