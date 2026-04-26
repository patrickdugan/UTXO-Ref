# LN-BTC to tlUSD Liquidity Patch

## Thesis

LN-BTC can fund UTXORef, externalize as BTC-based tlUSD for wallet UX, and be staked into an Ark-managed liquidity patching service with BitVM enforcement.

This is the end-to-end story: a wallet starts with LN-BTC, funds UTXORef through
the submarine-swap-shaped proof, externalizes the position as BTC-based tlUSD,
then stakes that tlUSD into an Ark-managed Lightning liquidity patching pool.
BitVM/UTXORef remains the enforcement layer if the ASP/LSP path fails.

## LN-BTC to tlUSD

- Conversion id: `383657933b6a25a5765e6bd00f438a76bcca97f371cdcba65dd456f36f711354`
- LN-BTC input: 49000 sats
- BTC/USD oracle price: 100000000000 micro-USD/BTC
- tlUSD units: 49000000
- Asset ticker: TLUSD
- Asset id: `59b147eaecbf09762942e96cb8204ee9b765ba147f5dffc7414bf48e23044e16`
- RFQ quote: `1f7a57ebf5bd5cef0a375f9b67e8d4559f0a421dc53193253bf3bf117563011a`
- Settlement: `233f0107fc266e6bd066d2cd3bbe00a51f06741a407ad1b656857c8683c2e6cd`
- Subswap funding txid: `c563776fe8a6d86e7e185529d7e78e43e4066c7221589c8f688b3b63a7939ad6`
- DLC/UTXORef funding txid: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43`

## tlUSD Stake

- Stake commitment: `7bd58616eaf5a2e48eeb2304143e12523c46d0a41c74bf46fea8f0a757ae67ee`
- Pool: ln-liquidity-patch-pool-regtest
- Owner node: wallet-liquidity-provider-regtest
- Staked tlUSD units: 40000000
- Routing notional: 40000 sats
- Lock: 1008 blocks
- Target yield: 4200 ppm
- Slash reserve: 2000000 tlUSD units
- Reward source: ln_routing_fees_and_liquidity_patch_premiums

## Ark Liquidity Patch Manager

- Manager bundle: `16ae7bbda1553209e7ff57db06ef01f6722781ef90516dce6a8586e7ba0d8672`
- Policy id: `d7e5588dbcc352dec9b4b32809155394554866ca87ef2880a2b450b02327c3e5`
- Allocation id: `e711d37ebb7f7ca00d232c9b2528c9aa9efc10bd3c96077e6810682bb08b1257`
- Requested inbound: 40000 sats
- Assigned inbound: 40000 sats
- Delivered inbound: 36000 sats
- Settled assignments: 1
- Slashable assignments: 1

### tlusd-edge-a-patch

- Status: settled
- Promised inbound: 30000 sats
- Delivered inbound: 30000 sats
- Quote: `3e252b416a137ec89a15527b07ada38187c10dbb3058e08833e6bd612b3ef139`
- Challengeable: false
- Violations: none

### tlusd-edge-b-patch

- Status: slashable
- Promised inbound: 10000 sats
- Delivered inbound: 6000 sats
- Quote: `60ef4d63d760260c1de4ea1f9532bc6fcd9ebb4b1d1ef41a68a019f6ed7ff462`
- Challengeable: true
- Violations: insufficient_ark_grafted_liquidity, fee_ppm_above_graft_quote, cltv_delta_above_graft_quote, missing_ark_forfeit_path


## Enforcement

- Manager challenge: `03b53d7be7eb52dee32dc14ef5f522ae2a65d97f382d346d73f2cea5a09cfd4f`
- Slashable: true
- Violations: assignment_liquidity_obligation_failed
- Remedy: slash ASP bond or force Ark exit/forfeit path through UTXORef challenge

## Marginal Routing Cost

- Baseline per graft: 13224 sats
- Ark per graft: 465 sats
- Baseline total: 26448 sats
- Ark total: 25930 sats
- Savings: 518 sats
- Safer marginal cost: true

## Verification

- Result: ok

## Caveats

- This is an evidence-shape prototype; it does not mint production Taproot Assets or execute real Ark rounds.
- tlUSD issuer/perp solvency remains a separate risk surface from LN route execution.
- The liquidity patch improves deployability and marginal routing cost, but it reallocates pledged liquidity rather than creating net liquidity.
