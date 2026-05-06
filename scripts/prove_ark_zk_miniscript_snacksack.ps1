param(
    [string] $ArkShinigamiRoot = 'C:\projects\ark-shinigami',
    [string] $ArtifactDir = '',
    [uint32] $RayonThreads = 2,
    [uint32] $MinRemoteAvailableGb = 24,
    [switch] $SkipRemoteBuild,
    [switch] $SkipProving
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ArtifactDir) {
    $ArtifactDir = Join-Path $RepoRoot 'bitvm3\utxo_referee\artifacts\ark_zk_miniscript'
}

$Generator = Join-Path $RepoRoot 'bitvm3\utxo_referee\ark_zk_miniscript_proof.js'
$Wrapper = Join-Path $ArkShinigamiRoot 'scripts\prove-ark-miniscript-snacksack.ps1'
$ProofDir = 'D:\cargo-target\ark-shinigami\proofs'
$LogDir = 'D:\cargo-target\ark-shinigami\logs'

if (-not (Test-Path $Generator)) {
    throw "Missing generator: $Generator"
}
if (-not (Test-Path $Wrapper)) {
    throw "Missing ark-shinigami snacksack wrapper: $Wrapper"
}

New-Item -ItemType Directory -Force -Path $ArtifactDir,$ProofDir,$LogDir | Out-Null

& node $Generator --out-dir $ArtifactDir
if ($LASTEXITCODE -ne 0) {
    throw "claim corpus generation failed with exit code $LASTEXITCODE"
}

$SummaryPath = Join-Path $ArtifactDir 'ark_zk_miniscript_summary_latest.json'
if (-not (Test-Path $SummaryPath)) {
    throw "Missing generated summary: $SummaryPath"
}

$Summary = Get-Content -Raw $SummaryPath | ConvertFrom-Json
if (-not $Summary.claims -or $Summary.claims.Count -eq 0) {
    throw "Generated summary has no claims: $SummaryPath"
}

if (-not $SkipProving) {
    $FirstProof = $true
    foreach ($Claim in $Summary.claims) {
        $Role = [string] $Claim.role
        $ProofFileName = "ark_zk_miniscript_${Role}.proof.json"

        if ($FirstProof -and -not $SkipRemoteBuild) {
            & $Wrapper `
                -InputPath ([string] $Claim.inputPath) `
                -ProofFileName $ProofFileName `
                -RayonThreads $RayonThreads `
                -MinRemoteAvailableGb $MinRemoteAvailableGb `
                -RemoteBuild
        } else {
            & $Wrapper `
                -InputPath ([string] $Claim.inputPath) `
                -ProofFileName $ProofFileName `
                -RayonThreads $RayonThreads `
                -MinRemoteAvailableGb $MinRemoteAvailableGb `
                -SkipBuild
        }
        if ($LASTEXITCODE -ne 0) {
            throw "snacksack proof failed for role ${Role} with exit code $LASTEXITCODE"
        }

        $FirstProof = $false
    }
}

if (-not $SkipProving) {
    & node $Generator `
        --write-receipts `
        --summary $SummaryPath `
        --proof-dir $ProofDir `
        --log-dir $LogDir `
        --out-dir $ArtifactDir `
        --rayon-threads ([string] $RayonThreads) `
        --min-remote-available-gb ([string] $MinRemoteAvailableGb)
    if ($LASTEXITCODE -ne 0) {
        throw "proof receipt generation failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Ark ZK miniscript summary: $SummaryPath"
if (-not $SkipProving) {
    Write-Host "Ark ZK miniscript receipts: $(Join-Path $ArtifactDir 'ark_zk_miniscript_receipts_latest.json')"
}
