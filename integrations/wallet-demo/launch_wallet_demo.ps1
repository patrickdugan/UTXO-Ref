param(
  [string]$Profile = "litecoin-testnet-local",
  [int]$Port = 8787,
  [switch]$NoStartSidecar,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $RepoRoot

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Block
  )
  Write-Host ""
  Write-Host "==> $Label"
  & $Block
}

function Stop-ExistingSidecar {
  $matches = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*lightning-liquidity-lease-sidecar*server.js*" }
  foreach ($process in $matches) {
    Write-Host "Stopping existing sidecar PID $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force
  }
}

$env:WALLET_DEMO_PROFILE = $Profile
$env:PORT = [string]$Port
if (-not $env:UTXOREF_SIDECAR_URL) {
  $env:UTXOREF_SIDECAR_URL = "http://127.0.0.1:$Port"
}

Invoke-Step "Generate LN-BTC -> TLUSD liquidity patch artifact" {
  node bitvm3/utxo_referee/lnbtc_tlusd_liquidity_patch_demo.js
}

if (-not $SkipTests) {
  Invoke-Step "Run focused wallet demo tests" {
    node bitvm3/utxo_referee/lnbtc_tlusd_liquidity_patch.test.js
    node integrations/wallet-demo/walletBackendProfiles.test.js
    node bitvm3/utxo_referee/lightning_wallet_integration.test.js
    node -c integrations/lightning-liquidity-lease-sidecar/server.js
  }
}

if (-not $NoStartSidecar) {
  Invoke-Step "Start sidecar" {
    Stop-ExistingSidecar
    $process = Start-Process -FilePath node `
      -ArgumentList "integrations\lightning-liquidity-lease-sidecar\server.js" `
      -WorkingDirectory $RepoRoot `
      -PassThru
    Start-Sleep -Milliseconds 600
    Write-Host "Sidecar PID $($process.Id)"
  }
}

$BaseUrl = "http://127.0.0.1:$Port"

Invoke-Step "Smoke sidecar endpoints" {
  $status = Invoke-RestMethod -Uri "$BaseUrl/v1/wallet-demo/status"
  $verify = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/lnbtc-tlusd-liquidity-patch/verify"
  $view = Invoke-RestMethod -Uri "$BaseUrl/v1/lnbtc-tlusd-liquidity-patch/wallet-view"

  $summary = [ordered]@{
    profile = $status.activeProfileId
    chain = $status.chain.chain
    walletReady = $status.readiness.walletViewReady
    lnbtcSats = $verify.lnbtcSats
    tlusdUnits = $verify.tlusdUnits
    stakedTlUsdUnits = $verify.stakedTlUsdUnits
    assignedInboundSats = $verify.assignedInboundSats
    slashableAssignments = $verify.slashableAssignments
    walletViewStatus = $view.status
  }
  $summary | ConvertTo-Json
}

Write-Host ""
Write-Host "Demo URLs"
Write-Host "  $BaseUrl/v1/wallet-demo/status"
Write-Host "  $BaseUrl/v1/wallet-demo/config"
Write-Host "  $BaseUrl/v1/lnbtc-tlusd-liquidity-patch/wallet-view"
Write-Host ""
Write-Host "Wallet files"
Write-Host "  integrations/zeus/TlusdLiquidityPatchScreen.tsx"
Write-Host "  integrations/zeus/WalletDemoSettingsScreen.tsx"
Write-Host "  integrations/zeus/tlusdLiquidityPatchClient.ts"

