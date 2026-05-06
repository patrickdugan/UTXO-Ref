# Lightning + BitVM/DLC Prototype Bundle

Bundle ID: `4193c647ed4c68f111b0ca6e789c345b1c383165e4e61525f3fc8aa41086a1ce`

## Prototypes

- Lightning-funded position open: `bf70aeedf66e72fc915ca551c03f996d650f39b99d187f98315cead31261b925`
- Lightning payout compression root: `33404934587fcfd90459d01b8e0d9be1f8e00df2049ed98e38df317c0b63b2f0`
- Watchtower bounty: `7cbf9c5d5269623e323bfb3b141e4439bc287f1f7b062953e2f6368d91c28065`
- LDK/BDK-style contract-open API session: `0b3f160c4fdae56bcefe9d6f82247d9efb7bcc986d2b79c46d98efb14ba6adde`
- Lightning-funded rollover root: `f207ab08edb261d1e6c84e9ed253317419d818675b24a8a798acf762c4646166`

## Checks

- Position atomicity hash lock: ok
- Position fee accounting: ok
- Payout compression verification: ok
- Watchtower receipt preimage: ok
- Rollover conservation: ok

## Production Boundary

These artifacts are deterministic protocol transcripts. A production implementation still needs real LDK/LND/CLN invoice handling, BDK/Bitcoin Core PSBT signing, mempool policy checks, and live refund-path enforcement.
