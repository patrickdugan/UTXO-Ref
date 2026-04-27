param(
  [string]$DataDir = $env:BTCTEST_DATADIR,
  [string]$BitcoinBin = $env:BITCOIN_BIN
)

$ErrorActionPreference = "Stop"

$bitcoind = if ($BitcoinBin) { Join-Path $BitcoinBin "bitcoind.exe" } else { "bitcoind.exe" }
$bitcoinCli = if ($BitcoinBin) { Join-Path $BitcoinBin "bitcoin-cli.exe" } else { "bitcoin-cli.exe" }
$dataDirArgs = @()
if ($DataDir) {
  $dataDirArgs += "-datadir=$DataDir"
}
$chainArg = "-chain=testnet4"

if ($BitcoinBin -and !(Test-Path $bitcoind)) {
  throw "bitcoind.exe not found at $bitcoind"
}

if ($DataDir) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

  $confPath = Join-Path $DataDir "bitcoin.conf"
  if (!(Test-Path $confPath)) {
  @"
server=1
chain=testnet4
prune=2000
dbcache=1024
fallbackfee=0.0002
[testnet4]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=48332
port=48333
"@ | Set-Content -Encoding ascii -Path $confPath
  }
}

$running = Get-Process bitcoind -ErrorAction SilentlyContinue | Where-Object {
  !$BitcoinBin -or $_.Path -eq $bitcoind
}

if (!$running) {
  Start-Process -FilePath $bitcoind -ArgumentList $dataDirArgs -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 5
}

& $bitcoinCli @dataDirArgs $chainArg getblockchaininfo
