param(
  [switch]$SkipDemo
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\\..\\..\\..")
Push-Location $repoRoot

try {
  Write-Host "[1/2] Running referee tests..."
  node .\bitvm3\utxo_referee\test.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if (-not $SkipDemo) {
    Write-Host "[2/2] Running referee demo..."
    node .\bitvm3\utxo_referee\demo.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "Referee checks passed."
}
finally {
  Pop-Location
}

