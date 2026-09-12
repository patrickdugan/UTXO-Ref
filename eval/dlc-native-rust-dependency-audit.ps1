param(
  [string]$SnapshotDirectory = 'D:\bitagent-testnet4\btc-test-snapshots',
  [string]$ToolRoot = 'D:\Tools\Rust'
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lockFile = Join-Path $repository 'native\dlc-signer\Cargo.lock'
$checkedEvidencePath = Join-Path $repository 'bitvm3\utxo_referee\artifacts\dlc_native_rust_dependency_audit_latest.json'
$cargoHome = Join-Path $ToolRoot 'cargo'
$cargoAudit = Join-Path $cargoHome 'bin\cargo-audit.exe'
$expectedCargoAuditSha256 = '0157f5ce1ce9fd4fb0a1f7c79af1229771d1f80b6c2613ddb0d9200a8ba73946'
$cargoAuditArchiveSha256 = '0a7316540862c13d954f648917ceacca593747baed6eec180fafa590be2710ab'

if (-not (Test-Path -LiteralPath $cargoAudit -PathType Leaf)) { throw "cargo-audit is missing under $ToolRoot" }
if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) { throw 'native signer Cargo.lock is required' }
$cargoAuditSha256 = (Get-FileHash -LiteralPath $cargoAudit -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cargoAuditSha256 -ne $expectedCargoAuditSha256) {
  throw "cargo-audit executable SHA-256 mismatch: $cargoAuditSha256"
}
$cargoAuditVersion = (& $cargoAudit --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $cargoAuditVersion -ne 'cargo-audit 0.22.2') {
  throw "unexpected cargo-audit version: $cargoAuditVersion"
}

$env:CARGO_HOME = $cargoHome
$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $cargoAudit
$processInfo.UseShellExecute = $false
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
foreach ($argument in @(
  'audit', '--file', $lockFile, '--deny', 'warnings',
  '--target-os', 'windows', '--target-arch', 'x86_64', '--json'
)) {
  [void]$processInfo.ArgumentList.Add($argument)
}
$process = [System.Diagnostics.Process]::Start($processInfo)
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
$auditJson = $stdoutTask.GetAwaiter().GetResult().Trim()
$auditDiagnostics = $stderrTask.GetAwaiter().GetResult().Trim()
if ($process.ExitCode -ne 0) {
  throw "cargo-audit strict dependency gate failed with exit $($process.ExitCode)`n$auditJson`n$auditDiagnostics"
}
try {
  $report = $auditJson | ConvertFrom-Json -DateKind String
} catch {
  throw "cargo-audit did not return valid JSON`n$auditJson`n$auditDiagnostics"
}

$warningEntries = @($report.warnings.PSObject.Properties)
$warningCount = 0
foreach ($entry in $warningEntries) { $warningCount += @($entry.Value).Count }
if ($report.vulnerabilities.found -ne $false -or [int]$report.vulnerabilities.count -ne 0) {
  throw 'cargo-audit reported a vulnerable locked dependency'
}
if ($warningCount -ne 0) { throw "cargo-audit reported $warningCount denied warning(s)" }
if ([int]$report.lockfile.'dependency-count' -le 0) { throw 'cargo-audit reported no locked dependencies' }
if ([int]$report.database.'advisory-count' -le 0 -or
    [string]$report.database.'last-commit' -notmatch '^[0-9a-f]{40}$') {
  throw 'cargo-audit advisory database metadata is incomplete'
}

$commit = (git -c safe.directory=C:/projects/UTXORef/UTXO-Ref -C $repository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'unable to resolve UTXORef commit' }
$evidence = [ordered]@{
  schema = 'utxoref_dlc_native_rust_dependency_audit_evidence_v1'
  auditedAt = [DateTime]::UtcNow.ToString('o')
  network = 'bitcoin-testnet4'
  sourceCommit = $commit
  cargoLockSha256 = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash.ToLowerInvariant()
  dependencyCount = [int]$report.lockfile.'dependency-count'
  tool = [ordered]@{
    version = $cargoAuditVersion
    binarySha256 = $cargoAuditSha256
    officialReleaseArchiveSha256 = $cargoAuditArchiveSha256
  }
  advisoryDatabase = [ordered]@{
    commit = [string]$report.database.'last-commit'
    advisoryCount = [int]$report.database.'advisory-count'
    lastUpdated = [string]$report.database.'last-updated'
  }
  policy = [ordered]@{
    deny = 'warnings'
    targetOs = @('windows')
    targetArch = @('x86_64')
    allowedVulnerabilities = 0
    allowedWarnings = 0
  }
  vulnerabilities = [ordered]@{ found = $false; count = 0 }
  warnings = [ordered]@{ count = 0; categories = @() }
  pointInTime = $true
  productionReady = $false
  externalAuditRequired = $true
}
$evidenceJson = ($evidence | ConvertTo-Json -Depth 20) + [Environment]::NewLine
New-Item -ItemType Directory -Path (Split-Path $checkedEvidencePath) -Force | Out-Null
[System.IO.File]::WriteAllText($checkedEvidencePath, $evidenceJson, [System.Text.UTF8Encoding]::new($false))

$snapshotRoot = [System.IO.Path]::GetFullPath($SnapshotDirectory)
if ([System.IO.Path]::GetPathRoot($snapshotRoot) -ne 'D:\') {
  throw 'dependency audit snapshots must remain on the D drive'
}
New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
$snapshotPath = Join-Path $snapshotRoot 'dlc-native-rust-dependency-audit-latest.json'
[System.IO.File]::WriteAllText($snapshotPath, $evidenceJson, [System.Text.UTF8Encoding]::new($false))
Write-Output "cargoAudit=$cargoAuditVersion"
Write-Output "advisoryDatabaseCommit=$($evidence.advisoryDatabase.commit)"
Write-Output "dependencies=$($evidence.dependencyCount)"
Write-Output 'vulnerabilities=0'
Write-Output 'warnings=0'
Write-Output "evidence=$checkedEvidencePath"
Write-Output "snapshot=$snapshotPath"
