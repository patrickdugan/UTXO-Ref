const { buildDashboardShinigamiProof } = require('./shinigamiProof');

module.exports = function shinigamiProof(_req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.status(200).json(buildDashboardShinigamiProof());
};
