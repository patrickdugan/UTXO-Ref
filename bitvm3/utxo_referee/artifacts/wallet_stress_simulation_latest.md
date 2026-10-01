# Wallet Stress Simulation

## Configuration

- Profile: litecoin-testnet-local
- Source bundle: `2d1797f3f84cc9a2a7f3d410237f209e80852cbe92e1b69ca27d117e47410d8e`
- LTC/USD price: 85000000 micro-USD/LTC
- Generated at: 2026-04-26T22:11:41.235Z

## Scenarios

| Bots | Build ms | tLTC collateral | TLUSD staked | Assigned sats | Delivered sats | Delivery | Challenges | Verified |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 5000 | 112.945 | 107.8904 | 9170.684 | 4827944000 | 4560609653 | 94.46% | 2006 | true |

## Largest Scenario Challenge Sample

- tl-autobot-001: 373023/404800 sats, delivered_liquidity_below_route_quote, fee_ppm_above_patch_ceiling
- tl-autobot-002: 297594/324000 sats, delivered_liquidity_below_route_quote, fee_ppm_above_patch_ceiling
- tl-autobot-003: 284833/311600 sats, delivered_liquidity_below_route_quote, fee_ppm_above_patch_ceiling
- tl-autobot-004: 527849/577200 sats, delivered_liquidity_below_route_quote, fee_ppm_above_patch_ceiling
- tl-autobot-006: 462728/507600 sats, delivered_liquidity_below_route_quote, fee_ppm_above_patch_ceiling

## Interpretation

This is a deterministic synthetic stress simulation anchored to the latest
LN-BTC -> TLUSD liquidity patch artifact. It does not claim live Ark ASP or
tapd throughput. It exercises the wallet/operator data shape at fleet scale:
bot inventory, tLTC collateral, TLUSD stake, Ark patch assignment, delivery
rate, and BitVM challenge queue growth.
