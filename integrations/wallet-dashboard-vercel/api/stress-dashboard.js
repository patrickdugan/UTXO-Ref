const { buildStressDashboard } = require('./mockData');

module.exports = function stressDashboard(req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.status(200).json(buildStressDashboard({ botCount: req.query.bots }));
};
