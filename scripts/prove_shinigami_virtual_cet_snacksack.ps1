param(
    [string] $ArkShinigamiRoot = 'C:\projects\ark-shinigami',
    [string] $ArtifactDir = '',
    [uint32] $RayonThreads = 4,
    [uint32] $MinRemoteAvailableGb = 20,
    [uint32] $OutcomeCount = 17,
    [switch] $SkipRemoteBuild,
    [switch] $SkipProving
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ArtifactDir) {
    $ArtifactDir = Join-Path $RepoRoot 'bitvm3\utxo_referee\shinigami\artifacts\virtual_cet_proofs'
}

$Generator = Join-Path $RepoRoot 'bitvm3\utxo_referee\shinigami\shinigami_virtual_cet_proof_corpus.js'
$Wrapper = Join-Path $ArkShinigamiRoot 'scripts\prove-virtual-cet-snacksack.ps1'
$ProofDir = 'D:\cargo-target\ark-shinigami\proofs'
$LogDir = 'D:\cargo-target\ark-shinigami\logs'

if (-not (Test-Path $Generator)) {
    throw "Missing generator: $Generator"
}
if (-not (Test-Path $Wrapper)) {
    throw "Missing ark-shinigami virtual-CET snacksack wrapper: $Wrapper"
}

New-Item -ItemType Directory -Force -Path $ArtifactDir,$ProofDir,$LogDir | Out-Null

& node $Generator --out-dir $ArtifactDir --outcome-counts ([string] $OutcomeCount)
if ($LASTEXITCODE -ne 0) {
    throw "virtual-CET claim corpus generation failed with exit code $LASTEXITCODE"
}

$SummaryPath = Join-Path $ArtifactDir 'shinigami_virtual_cet_proof_summary_latest.json'
if (-not (Test-Path $SummaryPath)) {
    throw "Missing generated summary: $SummaryPath"
}

$Summary = Get-Content -Raw $SummaryPath | ConvertFrom-Json
if (-not $Summary.claims -or $Summary.claims.Count -eq 0) {
    throw "Generated summary has no claims: $SummaryPath"
}

$Claim = $Summary.claims | Select-Object -First 1
$ProofBaseName = "shinigami_virtual_cet_$($Claim.outcomeCount)_outcomes"
$ProofFileName = "$ProofBaseName.proof.json"

if (-not $SkipProving) {
    $BuildSwitch = @{}
    if ($SkipRemoteBuild) {
        $BuildSwitch['SkipBuild'] = $true
    } else {
        $BuildSwitch['RemoteBuild'] = $true
    }

    & $Wrapper `
        -InputPath ([string] $Claim.inputPath) `
        -ProofFileName $ProofFileName `
        -RayonThreads $RayonThreads `
        -MinRemoteAvailableGb $MinRemoteAvailableGb `
        @BuildSwitch
    if ($LASTEXITCODE -ne 0) {
        throw "snacksack virtual-CET proof failed with exit code $LASTEXITCODE"
    }

    & node $Generator `
        --write-receipts `
        --summary $SummaryPath `
        --proof-dir $ProofDir `
        --log-dir $LogDir `
        --out-dir $ArtifactDir `
        --proof-base-name $ProofBaseName
    if ($LASTEXITCODE -ne 0) {
        throw "virtual-CET proof receipt generation failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Shinigami virtual-CET summary: $SummaryPath"
if (-not $SkipProving) {
    Write-Host "Shinigami virtual-CET receipts: $(Join-Path $ArtifactDir 'shinigami_virtual_cet_proof_receipts_latest.json')"
}
