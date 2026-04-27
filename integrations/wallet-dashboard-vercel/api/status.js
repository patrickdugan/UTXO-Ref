const { buildStatus } = require('./mockData');

module.exports = function status(_req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.status(200).json(buildStatus());
};
