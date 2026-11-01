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

# The listener's settings travel as environment variables and the child runs a fixed command, so no parameter value
# is ever parsed as PowerShell source (a path containing a quote used to end the quoted string in the old command).
$listenerCommand = 'Set-Location -LiteralPath $env:TL_LISTENER_REPO; node .\src\walletListener.js'
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($listenerCommand))
$childEnvironment = @{
    CHAIN = 'BTC_TESTNET4'
    AUTODETECT = '0'
    RPC_HOST = '127.0.0.1'
    RPC_PORT = "$RpcPort"
    RPC_COOKIE_FILE = $cookieFile
    TL_FORCE_TEST = '1'
    TL_LISTENER_PORT = "$ListenerPort"
    TL_LISTENER_REPO = $TradeLayerRepo
}
$savedEnvironment = @{}
foreach ($name in $childEnvironment.Keys) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $childEnvironment[$name], 'Process')
}
try {
    $process = Start-Process powershell `
        -WindowStyle Hidden `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand) `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
} finally {
    foreach ($name in $childEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

[pscustomobject]@{
    ProcessId = $process.Id
    Port = $ListenerPort
    RpcPort = $RpcPort
    CookieFile = $cookieFile
    Stdout = $stdout
    Stderr = $stderr
}
