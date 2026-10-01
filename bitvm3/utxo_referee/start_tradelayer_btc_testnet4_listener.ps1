param(
    [string]$TradeLayerRepo = "C:\projects\tradelayer.js",
    [string]$BitcoinDatadir = "D:\BitcoinTestnet",
    [int]$ListenerPort = 3000,
    [int]$RpcPort = 48332,
    [string]$LogDir = "C:\projects\tradelayer.js\logs\wallet-listener-btc-test",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

$cookieFile = Join-Path $BitcoinDatadir "testnet4\.cookie"
if (!(Test-Path $TradeLayerRepo)) {
    throw "TradeLayer repo not found: $TradeLayerRepo"
}
if (!(Test-Path $cookieFile)) {
    throw "Bitcoin Core cookie not found: $cookieFile"
}

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'walletListener\.js' }

if ($existing -and !$Restart) {
    $existing | Select-Object ProcessId,CommandLine
    return
}

if ($existing -and $Restart) {
    $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stdout = Join-Path $LogDir "stdout.log"
$stderr = Join-Path $LogDir "stderr.log"
Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue

$command = @"
`$env:CHAIN='BTC_TESTNET4'
`$env:AUTODETECT='0'
`$env:RPC_HOST='127.0.0.1'
`$env:RPC_PORT='$RpcPort'
`$env:RPC_COOKIE_FILE='$cookieFile'
`$env:TL_FORCE_TEST='1'
`$env:TL_LISTENER_PORT='$ListenerPort'
Set-Location '$TradeLayerRepo'
node .\src\walletListener.js
"@

$process = Start-Process powershell `
    -WindowStyle Hidden `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

[pscustomobject]@{
    ProcessId = $process.Id
    Port = $ListenerPort
    RpcPort = $RpcPort
    CookieFile = $cookieFile
    Stdout = $stdout
    Stderr = $stderr
}
