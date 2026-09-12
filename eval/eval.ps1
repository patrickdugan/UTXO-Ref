param(
  [ValidateSet('lite', 'full', 'scale')]
  [string]$Profile = $(if ($env:EVAL_PROFILE) { $env:EVAL_PROFILE } else { 'full' }),
  [uint32]$Seed = $(if ($env:EVAL_SEED) { [uint32]$env:EVAL_SEED } else { 12648430 })
)

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  node eval/utxo_referee_eval.js "--profile=$Profile" "--seed=$Seed"
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
