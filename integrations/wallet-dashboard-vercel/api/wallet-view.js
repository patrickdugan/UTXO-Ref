const { buildWalletView } = require('./mockData');

module.exports = function walletView(_req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.status(200).json(buildWalletView());
};
