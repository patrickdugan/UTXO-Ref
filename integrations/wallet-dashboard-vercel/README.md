# UTXORef Testnet Fleet Dashboard

Standalone Vercel package for the wallet-facing liquidity patch demo.

Production URL: https://wallet-dashboard-vercel.vercel.app
Funding brief: https://wallet-dashboard-vercel.vercel.app/funding

It mirrors the local sidecar UI from `integrations/wallet-demo` and exposes mock serverless endpoints for:

- `/v1/wallet-demo/stress-dashboard?bots=5000`
- `/v1/wallet-demo/status`
- `/v1/wallet-demo/adapter-feed`
- `/v1/lnbtc-tlusd-liquidity-patch/wallet-view`

The Vercel version is meant for grant-review walkthroughs when a public URL is more useful than a local Litecoin testnet sidecar. The local sidecar remains the richer source of live node-backed telemetry.

## Local Checks

```powershell
npm test
npm run test:panels
```

`test:panels` defaults to `https://wallet-dashboard-vercel.vercel.app`. Set `DASHBOARD_BASE_URL` to test a preview deployment or local Vercel dev URL.

## Grant Review Docs

- `../../SPIRAL_GRANT_README.md`
- `../../docs/bitcoin-core-scope.md`
- `../../docs/upstream-targets.md`
- `../../docs/demo-video-script.md`
- `../../docs/milestone-budget.md`
- `../../docs/review-request-template.md`

## Deploy

```powershell
$token = (Get-Content -Raw C:\path\to\vercel2.txt).Trim()
npx vercel@latest deploy --prod --yes --scope patrickdugans-projects --token $token
```

Run the deploy command from this directory.
