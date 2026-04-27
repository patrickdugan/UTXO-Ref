param(
  [string]$DataDir = "D:\BitcoinTestnet",
  [string]$BitcoinBin = "C:\projects\BitcoinConsensusObservatory\jurassic-bitcoin\tools\bitcoin-core-30.2\bitcoin-30.2\bin"
)

$ErrorActionPreference = "Stop"

$bitcoind = Join-Path $BitcoinBin "bitcoind.exe"
$bitcoinCli = Join-Path $BitcoinBin "bitcoin-cli.exe"
$dataDirArg = "-datadir=$DataDir"
$chainArg = "-chain=testnet4"

if (!(Test-Path $bitcoind)) {
  throw "bitcoind.exe not found at $bitcoind"
}

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

$running = Get-Process bitcoind -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -eq $bitcoind
}

if (!$running) {
  Start-Process -FilePath $bitcoind -ArgumentList @($dataDirArg) -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 5
}

& $bitcoinCli $dataDirArg $chainArg getblockchaininfo
