param(
  [string]$BitcoinDatadir = 'D:\BitcoinTestnet',
  [string]$SshTarget = 'ubuntu@172.81.181.19',
  [string]$SshKey = "$env:USERPROFILE\.ssh\tl_vps_bitvise_bridge_ed25519",
  [string]$TrustPolicy = '',
  [string]$SettlementArtifact = '',
  [int]$ProxyPort = 48434
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path $BitcoinDatadir 'key-backups\utxoref-v2-watchtower-bridge'
$credentialFile = Join-Path $backupDir 'proxy.env'
$proxyScript = Join-Path $root 'utxoref_v2_rpc_proxy.js'
if (-not $TrustPolicy) { $TrustPolicy = Join-Path $root 'artifacts\live\utxoref_v2_watchtower_trust_policy.json' }
if (-not $SettlementArtifact) { $SettlementArtifact = Join-Path $root 'artifacts\live\btc_testnet4_utxoref_v2_latest.json' }
$sshOptions = @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')

# Native commands do not stop a PowerShell script on failure: every ssh, scp and node step goes through here.
function Invoke-Checked {
  param([string]$What, [scriptblock]$Command)
  $global:LASTEXITCODE = 0
  $output = & $Command
  if ($global:LASTEXITCODE -ne 0) { throw "$What failed with exit code $global:LASTEXITCODE" }
  return $output
}

if (-not (Test-Path -LiteralPath $SshKey)) { throw "SSH key not found: $SshKey" }
if (-not (Test-Path -LiteralPath $proxyScript)) { throw "Proxy script not found: $proxyScript" }
if (-not (Test-Path -LiteralPath $TrustPolicy)) { throw "Trust policy not found: $TrustPolicy" }
if (-not (Test-Path -LiteralPath $SettlementArtifact)) { throw "Settlement artifact not found: $SettlementArtifact" }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

if (-not (Test-Path -LiteralPath $credentialFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pass = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  @(
    'UTXOREF_WATCHTOWER_PROXY_USER=watchtower',
    "UTXOREF_WATCHTOWER_PROXY_PASS=$pass"
  ) | Set-Content -LiteralPath $credentialFile -Encoding ASCII
  try { icacls $credentialFile /inheritance:r /grant:r "$env:USERNAME`:F" | Out-Null } catch {}
}

$credential = @{}
Get-Content -LiteralPath $credentialFile | ForEach-Object {
  $name, $value = $_ -split '=', 2
  $credential[$name] = $value
}
if (-not $credential['UTXOREF_WATCHTOWER_PROXY_USER'] -or -not $credential['UTXOREF_WATCHTOWER_PROXY_PASS']) {
  throw "Proxy credentials are missing from $credentialFile"
}

$oldUser = $env:UTXOREF_WATCHTOWER_PROXY_USER
$oldPass = $env:UTXOREF_WATCHTOWER_PROXY_PASS
$env:UTXOREF_WATCHTOWER_PROXY_USER = $credential['UTXOREF_WATCHTOWER_PROXY_USER']
$env:UTXOREF_WATCHTOWER_PROXY_PASS = $credential['UTXOREF_WATCHTOWER_PROXY_PASS']
$node = (Get-Command node -ErrorAction Stop).Source
# WT-2: the proxy relays sendrawtransaction only for the committed settlement of
# a graph that verifies against the pinned trust policy (derived on this host).
$proxy = Start-Process -FilePath $node -ArgumentList @($proxyScript, '--datadir', $BitcoinDatadir, '--port', $ProxyPort, '--settlement-artifact', $SettlementArtifact, '--trust-policy', $TrustPolicy) -WindowStyle Hidden -PassThru
$env:UTXOREF_WATCHTOWER_PROXY_USER = $oldUser
$env:UTXOREF_WATCHTOWER_PROXY_PASS = $oldPass

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ((Test-NetConnection -ComputerName 127.0.0.1 -Port $ProxyPort -WarningAction SilentlyContinue).TcpTestSucceeded) { break }
  if ($attempt -eq 19) { throw 'Local UTXORef RPC proxy did not start' }
}

# The credentials travel in a private local file that is deleted in every case, and are installed on the host
# from a directory that mktemp created for this run (0700, unpredictable name), not a fixed path under /tmp.
$envFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
$remoteDir = $null
try {
  @(
    'BTC_RPC_URL=http://127.0.0.1:48332',
    "BTC_RPC_USER=$($credential['UTXOREF_WATCHTOWER_PROXY_USER'])",
    "BTC_RPC_PASS=$($credential['UTXOREF_WATCHTOWER_PROXY_PASS'])"
  ) | Set-Content -LiteralPath $envFile -Encoding ASCII

  $remoteDir = (Invoke-Checked 'remote staging directory' {
    & ssh @sshOptions $SshTarget 'umask 077; mktemp -d /tmp/utxoref-v2-watchtower.XXXXXXXX'
  } | Select-Object -Last 1).Trim()
  if ($remoteDir -notmatch '^/tmp/utxoref-v2-watchtower\.[A-Za-z0-9]+$') { throw "unexpected staging directory: $remoteDir" }

  Invoke-Checked 'copy env file' { & scp @sshOptions $envFile "${SshTarget}:$remoteDir/watchtower.env" } | Out-Null
  Invoke-Checked 'copy trust policy' { & scp @sshOptions $TrustPolicy "${SshTarget}:$remoteDir/trust-policy.json" } | Out-Null
  Invoke-Checked 'install host configuration' {
    & ssh @sshOptions $SshTarget "sudo install -o root -g root -m 0600 '$remoteDir/watchtower.env' /etc/utxoref-v2-watchtower.env && sudo install -o root -g root -m 0644 '$remoteDir/trust-policy.json' /etc/utxoref-v2-watchtower-trust-policy.json"
  } | Out-Null
} finally {
  Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
  if ($remoteDir) { & ssh @sshOptions $SshTarget "rm -rf '$remoteDir'" | Out-Null }
}

$ssh = (Get-Command ssh -ErrorAction Stop).Source
$tunnel = Start-Process -FilePath $ssh -ArgumentList @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-R', "127.0.0.1:48332:127.0.0.1:$ProxyPort", $SshTarget) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
if ($tunnel.HasExited) { throw "SSH tunnel exited with code $($tunnel.ExitCode)" }
Invoke-Checked 'enable watchtower service' {
  & ssh @sshOptions $SshTarget 'sudo systemctl enable --now utxoref-v2-watchtower.service && systemctl is-active utxoref-v2-watchtower.service'
} | Out-Null

$bridgeState = [pscustomobject]@{
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  proxyPid = $proxy.Id
  tunnelPid = $tunnel.Id
  proxyPort = $ProxyPort
  sshTarget = $SshTarget
}
$bridgeState | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'bridge-state.json') -Encoding ASCII
Write-Host "UTXORef V2 watchtower bridge active: local proxy PID $($proxy.Id), tunnel PID $($tunnel.Id)"
