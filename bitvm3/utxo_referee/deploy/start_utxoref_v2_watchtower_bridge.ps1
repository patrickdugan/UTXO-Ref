param(
  [string]$BitcoinDatadir = 'D:\BitcoinTestnet',
  [string]$SshTarget = 'ubuntu@172.81.181.19',
  [string]$SshKey = "$env:USERPROFILE\.ssh\tl_vps_bitvise_bridge_ed25519",
  [int]$ProxyPort = 48434
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path $BitcoinDatadir 'key-backups\utxoref-v2-watchtower-bridge'
$credentialFile = Join-Path $backupDir 'proxy.env'
$remoteEnvFile = Join-Path $env:TEMP 'utxoref-v2-watchtower.env'
$proxyScript = Join-Path $root 'utxoref_v2_rpc_proxy.js'

if (-not (Test-Path -LiteralPath $SshKey)) { throw "SSH key not found: $SshKey" }
if (-not (Test-Path -LiteralPath $proxyScript)) { throw "Proxy script not found: $proxyScript" }
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

$oldUser = $env:UTXOREF_WATCHTOWER_PROXY_USER
$oldPass = $env:UTXOREF_WATCHTOWER_PROXY_PASS
$env:UTXOREF_WATCHTOWER_PROXY_USER = $credential['UTXOREF_WATCHTOWER_PROXY_USER']
$env:UTXOREF_WATCHTOWER_PROXY_PASS = $credential['UTXOREF_WATCHTOWER_PROXY_PASS']
$node = (Get-Command node -ErrorAction Stop).Source
$proxy = Start-Process -FilePath $node -ArgumentList @($proxyScript, '--datadir', $BitcoinDatadir, '--port', $ProxyPort) -WindowStyle Hidden -PassThru
$env:UTXOREF_WATCHTOWER_PROXY_USER = $oldUser
$env:UTXOREF_WATCHTOWER_PROXY_PASS = $oldPass

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ((Test-NetConnection -ComputerName 127.0.0.1 -Port $ProxyPort -WarningAction SilentlyContinue).TcpTestSucceeded) { break }
  if ($attempt -eq 19) { throw 'Local UTXORef RPC proxy did not start' }
}

@(
  'BTC_RPC_URL=http://127.0.0.1:48332',
  "BTC_RPC_USER=$($credential['UTXOREF_WATCHTOWER_PROXY_USER'])",
  "BTC_RPC_PASS=$($credential['UTXOREF_WATCHTOWER_PROXY_PASS'])"
) | Set-Content -LiteralPath $remoteEnvFile -Encoding ASCII

& scp -i $SshKey -o IdentitiesOnly=yes -o BatchMode=yes $remoteEnvFile "${SshTarget}:/tmp/utxoref-v2-watchtower.env"
& ssh -i $SshKey -o IdentitiesOnly=yes -o BatchMode=yes $SshTarget 'sudo install -o root -g root -m 0600 /tmp/utxoref-v2-watchtower.env /etc/utxoref-v2-watchtower.env'
Remove-Item -LiteralPath $remoteEnvFile -Force

$ssh = (Get-Command ssh -ErrorAction Stop).Source
$tunnel = Start-Process -FilePath $ssh -ArgumentList @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-R', "127.0.0.1:48332:127.0.0.1:$ProxyPort", $SshTarget) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
& ssh -i $SshKey -o IdentitiesOnly=yes -o BatchMode=yes $SshTarget 'sudo systemctl enable --now utxoref-v2-watchtower.service; systemctl is-active utxoref-v2-watchtower.service'

$bridgeState = [pscustomobject]@{
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  proxyPid = $proxy.Id
  tunnelPid = $tunnel.Id
  proxyPort = $ProxyPort
  sshTarget = $SshTarget
}
$bridgeState | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'bridge-state.json') -Encoding ASCII
Write-Host "UTXORef V2 watchtower bridge active: local proxy PID $($proxy.Id), tunnel PID $($tunnel.Id)"
