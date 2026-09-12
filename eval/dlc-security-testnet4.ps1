param(
  [string]$RepositoryPath = 'C:\projects\UTXORef\UTXO-Ref',
  [ValidateSet('lite', 'full', 'scale')]
  [string]$Profile = 'scale',
  [uint32]$Seed = 3549216002,
  [string]$SnapshotDirectory = $(Join-Path $PSScriptRoot 'btc-test-snapshots')
)

$ErrorActionPreference = 'Stop'
$evaluator = Join-Path $RepositoryPath 'eval\dlc_security_eval.js'
if (-not (Test-Path -LiteralPath $evaluator -PathType Leaf)) {
  throw "DLC evaluator not found: $evaluator"
}

Push-Location $RepositoryPath
try {
  $commit = (& git -c "safe.directory=$($RepositoryPath -replace '\\','/')" rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Unable to resolve UTXORef commit before evaluation' }
  $statusBefore = @(& git -c "safe.directory=$($RepositoryPath -replace '\\','/')" status --porcelain=v1 --untracked-files=normal)
  if ($LASTEXITCODE -ne 0 -or $statusBefore.Count -ne 0) { throw 'UTXORef worktree must be clean before evidence capture' }
  $json = & node $evaluator "--profile=$Profile" "--seed=$Seed" --require-perfect --json
  if ($LASTEXITCODE -ne 0) { throw "DLC evaluator exited $LASTEXITCODE" }
  $result = $json | ConvertFrom-Json
  $commitAfter = (& git -c "safe.directory=$($RepositoryPath -replace '\\','/')" rev-parse HEAD).Trim()
  $statusAfter = @(& git -c "safe.directory=$($RepositoryPath -replace '\\','/')" status --porcelain=v1 --untracked-files=normal)
  if ($LASTEXITCODE -ne 0 -or $commitAfter -cne $commit -or $statusAfter.Count -ne 0) {
    throw 'UTXORef commit or worktree changed during evidence capture'
  }
} finally {
  Pop-Location
}

$snapshot = [ordered]@{
  schema = 'utxoref_testnet4_dlc_security_eval_v1'
  capturedAt = [DateTime]::UtcNow.ToString('o')
  network = 'bitcoin-testnet4'
  syntheticKeysOnly = $true
  rpcUsed = $false
  signingUsed = $false
  broadcastAttempted = $false
  repository = $RepositoryPath
  commit = $commit
  sourceWorktreeClean = $true
  sourceCommitStable = $true
  result = $result
}

New-Item -ItemType Directory -Force -Path $SnapshotDirectory | Out-Null
$outputPath = Join-Path $SnapshotDirectory 'dlc-security-eval-latest.json'
$serialized = $snapshot | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($outputPath, $serialized + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

Write-Output "score=$($result.score)"
Write-Output "passed=$($result.passed)"
Write-Output "failed=$($result.failed)"
Write-Output "snapshot=$outputPath"
