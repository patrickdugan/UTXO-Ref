param(
  [string]$DataDir = "E:\BitcoinTestnet",
  [string]$BitcoinBin = "C:\projects\BitcoinConsensusObservatory\jurassic-bitcoin\tools\bitcoin-core-30.2\bitcoin-30.2\bin",
  [string]$Wallet = "utxoref-testnet",
  [decimal]$AnchorAmount = 0.00000546,
  [string]$Marker = "UTXORef LN-BTC BitVM liquidity demo"
)

$ErrorActionPreference = "Stop"

$bitcoinCli = Join-Path $BitcoinBin "bitcoin-cli.exe"
$dataDirArg = "-datadir=$DataDir"
$chainArg = "-chain=testnet4"
$walletArg = "-rpcwallet=$Wallet"

if (!(Test-Path $bitcoinCli)) {
  throw "bitcoin-cli.exe not found at $bitcoinCli"
}

function Invoke-BitcoinCli {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]]$Args)
  $output = & $bitcoinCli $dataDirArg $chainArg @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  $output
}

function Invoke-WalletCli {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]]$Args)
  $output = & $bitcoinCli $dataDirArg $chainArg $walletArg @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  $output
}

function ConvertTo-HexAscii {
  param([string]$Text)
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($Text)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function ConvertTo-BitcoinCliJsonArg {
  param([string]$Json)
  $Json.Replace('"', '\"')
}

function Get-OrCreateAddress {
  param([string]$Label)
  try {
    $addresses = Invoke-WalletCli getaddressesbylabel $Label | ConvertFrom-Json
    $first = $addresses.PSObject.Properties | Select-Object -First 1
    if ($first) {
      return $first.Name
    }
  } catch {
    # No address has this label yet.
  }
  Invoke-WalletCli getnewaddress $Label "bech32"
}

$wallets = Invoke-BitcoinCli listwallets | ConvertFrom-Json
if ($wallets -notcontains $Wallet) {
  try {
    Invoke-BitcoinCli loadwallet $Wallet | Out-Null
  } catch {
    & $bitcoinCli $dataDirArg $chainArg "-named" "createwallet" "wallet_name=$Wallet" "descriptors=true" "load_on_startup=true" | Out-Null
  }
}

$chain = Invoke-BitcoinCli getblockchaininfo | ConvertFrom-Json
if ($chain.initialblockdownload) {
  throw "Bitcoin testnet4 node is still in IBD at $($chain.blocks)/$($chain.headers). Wait for initialblockdownload=false."
}

$receiveAddress = Get-OrCreateAddress "utxoref-demo-funding"
$balances = Invoke-WalletCli getbalances | ConvertFrom-Json
$available = [decimal]$balances.mine.trusted + [decimal]$balances.mine.untrusted_pending
$minimumNeeded = $AnchorAmount + 0.00000300

if ($available -lt $minimumNeeded) {
  [ordered]@{
    ok = $false
    reason = "wallet needs testnet4 funds before broadcasting demo tx"
    wallet = $Wallet
    receiveAddress = $receiveAddress
    availableTbtc = $available
    minimumRecommendedTbtc = $minimumNeeded
    explorer = "https://mempool.space/testnet4/address/$receiveAddress"
    faucets = @(
      "https://faucet.testnet4.dev/",
      "https://www.bitcointestnet4.com/",
      "https://coinfaucet.eu/en/btc-testnet4/",
      "https://testnet4.info/"
    )
  } | ConvertTo-Json -Depth 4
  exit 2
}

$anchorAddress = Invoke-WalletCli getnewaddress "utxoref-demo-anchor" "bech32"
$changeAddress = Invoke-WalletCli getrawchangeaddress "bech32"
$markerHex = ConvertTo-HexAscii $Marker
$amountText = $AnchorAmount.ToString("0.00000000", [System.Globalization.CultureInfo]::InvariantCulture)

$outputs = @(
  [ordered]@{ $anchorAddress = [decimal]$amountText },
  [ordered]@{ data = $markerHex }
)
$outputsJson = $outputs | ConvertTo-Json -Compress

$raw = Invoke-WalletCli createrawtransaction "[]" (ConvertTo-BitcoinCliJsonArg $outputsJson)
$fundOptions = @{
  fee_rate = 1
  changeAddress = $changeAddress
  include_unsafe = $true
} | ConvertTo-Json -Compress
$funded = Invoke-WalletCli fundrawtransaction $raw (ConvertTo-BitcoinCliJsonArg $fundOptions) | ConvertFrom-Json
$signed = Invoke-WalletCli signrawtransactionwithwallet $funded.hex | ConvertFrom-Json

if (!$signed.complete) {
  throw "wallet did not fully sign demo transaction"
}

$txid = Invoke-WalletCli sendrawtransaction $signed.hex

[ordered]@{
  ok = $true
  kind = "bitcoin_testnet4_utxoref_demo_anchor"
  txid = $txid
  txExplorer = "https://mempool.space/testnet4/tx/$txid"
  receiveAddress = $receiveAddress
  anchorAddress = $anchorAddress
  addressExplorer = "https://mempool.space/testnet4/address/$anchorAddress"
  marker = $Marker
  feeBtc = $funded.fee
  chainHeight = $chain.blocks
} | ConvertTo-Json -Depth 4
