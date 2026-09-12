param(
  [string]$SnapshotDirectory = 'D:\bitagent-testnet4\btc-test-snapshots',
  [string]$ToolRoot = 'D:\Tools\Rust',
  [string]$BuildRoot = 'D:\bitagent-testnet4\build\dlc-signer-target',
  [string]$ReproBuildRoot = 'D:\bitagent-testnet4\build\dlc-signer-repro',
  [string]$BinaryDirectory = 'D:\bitagent-testnet4\bin'
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $repository 'native\dlc-signer\Cargo.toml'
$lockFile = Join-Path $repository 'native\dlc-signer\Cargo.lock'
$sourceFile = Join-Path $repository 'native\dlc-signer\src\main.rs'
$accessVerifierFile = Join-Path $repository 'native\dlc-signer\verify-dpapi-key-access.ps1'
$provisionerFile = Join-Path $repository 'native\dlc-signer\provision-dpapi-keyset.ps1'
$pipeBrokerFile = Join-Path $repository 'native\dlc-signer\run-named-pipe-broker.ps1'
$pipeInvokerFile = Join-Path $repository 'native\dlc-signer\invoke-named-pipe-signer.ps1'
$cargoHome = Join-Path $ToolRoot 'cargo'
$rustupHome = Join-Path $ToolRoot 'rustup'
$cargo = Join-Path $cargoHome 'bin\cargo.exe'
$rustc = Join-Path $cargoHome 'bin\rustc.exe'
if (-not (Test-Path -LiteralPath $cargo) -or -not (Test-Path -LiteralPath $rustc)) {
  throw "Rust toolchain is missing under $ToolRoot"
}
if (-not (Test-Path -LiteralPath $lockFile)) { throw 'native signer Cargo.lock is required' }
$sourceText = Get-Content -LiteralPath $sourceFile -Raw
$accessVerifierText = Get-Content -LiteralPath $accessVerifierFile -Raw
$provisionerText = Get-Content -LiteralPath $provisionerFile -Raw
$pipeBrokerText = Get-Content -LiteralPath $pipeBrokerFile -Raw
$pipeInvokerText = Get-Content -LiteralPath $pipeInvokerFile -Raw
if ([regex]::Matches($sourceText, '\bunsafe\s*\{').Count -ne 7 -or
    [regex]::Matches($sourceText, 'unsafe\s+extern\s+"system"').Count -ne 2 -or
    $sourceText -notmatch 'CryptUnprotectData' -or $sourceText -notmatch 'LocalFree' -or
    $sourceText -notmatch 'SetProcessMitigationPolicy' -or
    $sourceText -notmatch 'SetDefaultDllDirectories' -or
    $sourceText -notmatch '--describe-dpapi-keyset') {
  throw 'native signer FFI surface differs from the reviewed seven-block boundary'
}
if ($accessVerifierText -match 'ProtectedData|CryptUnprotectData|\bUnprotect\b|Console.*Write') {
  throw 'DPAPI access verifier must not decrypt or emit key material'
}
if ($provisionerText -match 'Console\]::In|ReadToEnd|protect-dpapi-key\.ps1' -or
    $provisionerText -notmatch 'RandomNumberGenerator\]::Create\(\)' -or
    $provisionerText -notmatch '\.GetBytes\(\$secret\)' -or
    $provisionerText -notmatch 'ProtectedData\]::Protect') {
  throw 'DPAPI keyset provisioner differs from the reviewed no-secret-input boundary'
}
if ($pipeBrokerText -match 'ProtectedData|CryptUnprotectData|\.key\.dpapi.*Read' -or
    $pipeBrokerText -notmatch 'NamedPipeServerStream' -or
    $pipeBrokerText -notmatch 'SetAccessRuleProtection\(\$true, \$false\)' -or
    $pipeBrokerText -notmatch 'client SID is not authorized' -or
    $pipeBrokerText -notmatch 'broker response envelope is oversized' -or
    $pipeInvokerText -notmatch 'NamedPipeClientStream' -or
    $pipeInvokerText -match 'CopyTo\(\$requestBuffer\)' -or
    $pipeInvokerText -match 'ProtectedData|CryptUnprotectData') {
  throw 'named pipe signer transport differs from the reviewed secretless boundary'
}

New-Item -ItemType Directory -Path $SnapshotDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
New-Item -ItemType Directory -Path $BinaryDirectory -Force | Out-Null
$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome
$env:CARGO_TARGET_DIR = $BuildRoot
$env:SOURCE_DATE_EPOCH = '1'
$env:PATH = (Join-Path $cargoHome 'bin') + ';' + $env:PATH

& $cargo build --manifest-path $manifest --release --locked --offline
if ($LASTEXITCODE -ne 0) { throw "native signer cargo build failed with exit $LASTEXITCODE" }
$builtBinary = Join-Path $BuildRoot 'release\utxoref-dlc-signer.exe'
if (-not (Test-Path -LiteralPath $builtBinary)) { throw 'native signer build produced no executable' }
$reproRoot = [System.IO.Path]::GetFullPath($ReproBuildRoot)
$expectedBuildParent = [System.IO.Path]::GetFullPath('D:\bitagent-testnet4\build') + [System.IO.Path]::DirectorySeparatorChar
if (-not $reproRoot.StartsWith($expectedBuildParent, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'reproducibility build root must remain under D:\bitagent-testnet4\build'
}
if (Test-Path -LiteralPath $reproRoot) { Remove-Item -LiteralPath $reproRoot -Recurse -Force }
New-Item -ItemType Directory -Path $reproRoot -Force | Out-Null
$env:CARGO_TARGET_DIR = $reproRoot
& $cargo build --manifest-path $manifest --release --locked --offline
if ($LASTEXITCODE -ne 0) { throw "native signer reproducibility build failed with exit $LASTEXITCODE" }
$reproBinary = Join-Path $reproRoot 'release\utxoref-dlc-signer.exe'
if (-not (Test-Path -LiteralPath $reproBinary)) { throw 'reproducibility build produced no executable' }
$builtBinarySha256 = (Get-FileHash -LiteralPath $builtBinary -Algorithm SHA256).Hash.ToLowerInvariant()
$reproBinarySha256 = (Get-FileHash -LiteralPath $reproBinary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($builtBinarySha256 -ne $reproBinarySha256) { throw 'native signer build is not byte reproducible' }
$deployedBinary = Join-Path $BinaryDirectory 'utxoref-dlc-signer.exe'
Copy-Item -LiteralPath $builtBinary -Destination $deployedBinary -Force

$provisionWorkDirectory = Join-Path $SnapshotDirectory ('.native-provision-' + [guid]::NewGuid().ToString('N'))
$provisionKeyDirectory = Join-Path $provisionWorkDirectory 'keys'
New-Item -ItemType Directory -Path $provisionWorkDirectory | Out-Null
try {
  $provisionText = (& $provisionerFile -DirectoryPath $provisionKeyDirectory `
      -SignerBinaryPath $deployedBinary -AccessVerifierPath $accessVerifierFile 2>&1 | Out-String).Trim()
  $provisionExit = $LASTEXITCODE
  if ($provisionExit -ne 0) { throw "DPAPI keyset provisioning failed with exit $provisionExit`n$provisionText" }
  $provision = $provisionText | ConvertFrom-Json
  $provisionedFiles = @(Get-ChildItem -LiteralPath $provisionKeyDirectory -File)
  if ($provision.schema -cne 'utxoref_dlc_dpapi_keyset_provisioning_v1' -or
      [bool]$provision.plaintextSecretInput -ne $false -or
      [string]$provision.signerPubkeyX -notmatch '^[0-9a-f]{64}$' -or
      [string]$provision.runtimeIdentityKeyId -notmatch '^[0-9a-f]{64}$' -or
      $provisionedFiles.Count -ne 2 -or
      @($provisionedFiles | Where-Object { $_.Name -notmatch '^(runtime-identity|[0-9a-f]{64})\.key\.dpapi$' }).Count -ne 0 -or
      @(Get-ChildItem -LiteralPath $provisionKeyDirectory -File -Filter '*.key').Count -ne 0) {
    throw 'DPAPI keyset provisioner did not produce exactly two protected private-key blobs'
  }
} finally {
  Remove-Item -LiteralPath $provisionWorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

$workDirectory = Join-Path $SnapshotDirectory ('.native-signer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDirectory | Out-Null
try {
  $resultText = (& node (Join-Path $PSScriptRoot 'dlc_native_signer_integration.js') $deployedBinary $workDirectory 2>&1 | Out-String).Trim()
  $integrationExit = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $workDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
if ($integrationExit -ne 0) { throw "native signer integration failed with exit $integrationExit`n$resultText" }
$result = $resultText | ConvertFrom-Json
$result.assertions | Add-Member -NotePropertyName inAccountCsprngKeyGeneration -NotePropertyValue $true
$result.assertions | Add-Member -NotePropertyName provisioningSecretIpcEliminated -NotePropertyValue $true
if (-not $result.assertions.rustProcessSigned -or -not $result.assertions.javascriptHostVerified -or
    -not $result.assertions.bip340CompletionVerified -or -not $result.assertions.adaptorExtractionVerified -or
    -not $result.assertions.restartReplayRejected -or -not $result.assertions.signerLocalReplayRejected -or
    -not $result.assertions.unpinnedValidatorRejected -or -not $result.assertions.unpinnedSignerRejected) {
  throw 'native signer integration omitted a required assertion'
}
if (-not $result.assertions.exactOneSignerRaceWinner -or $result.signerRaceWorkers -ne 16) {
  throw 'native signer integration omitted a required assertion'
}
if (-not $result.assertions.expiredAuthorizationRejected -or
    -not $result.assertions.futureAuthorizationRejected -or
    -not $result.assertions.signedClockRollbackRejected) {
  throw 'native signer integration omitted authorization freshness assertions'
}
if (-not $result.assertions.dpapiProtectedKeyBlobsOnly -or
    -not $result.assertions.dpapiBlobsOpaque -or
    -not $result.assertions.plaintextKeyFilesRejected) {
  throw 'native signer integration omitted DPAPI key-storage assertions'
}
if (-not $result.assertions.expectedWindowsAccountSidBound -or
    -not $result.assertions.unexpectedSignerAccountRejected -or
    -not $result.assertions.protectedKeyDirectoryAclRequired -or
    -not $result.assertions.inheritedKeyDirectoryAclRejected) {
  throw 'native signer integration omitted account or ACL isolation assertions'
}
if (-not $result.assertions.nativeDpapiDecryption -or
    -not $result.assertions.decryptionSecretIpcEliminated -or
    -not $result.assertions.dpapiAccessVerifierSilent -or
    $result.assertions.unsafeDpapiFfiBlocks -ne 7 -or
    -not $result.assertions.dpapiOutputMemoryLocked -or
    -not $result.assertions.decryptedKeyBufferMemoryLocked -or
    -not $result.assertions.memoryLockFailureFailsClosed) {
  throw 'native signer integration omitted native DPAPI boundary assertions'
}
if (-not $result.assertions.processMitigationsApplied -or
    -not $result.assertions.system32OnlyDllSearch -or
    -not $result.assertions.dynamicCodeProhibited -or
    -not $result.assertions.extensionPointsDisabled -or
    -not $result.assertions.microsoftSignedImagesOnly -or
    -not $result.assertions.remoteAndLowIntegrityImagesRejected) {
  throw 'native signer integration omitted process mitigation assertions'
}
if (-not $result.assertions.selfVerifiedExecutableDigest) {
  throw 'native signer integration omitted executable identity assertion'
}
if (-not $result.assertions.inAccountCsprngKeyGeneration -or
    -not $result.assertions.provisioningSecretIpcEliminated) {
  throw 'native signer integration omitted self-provisioned keyset assertions'
}
if (-not $result.assertions.boundedNamedPipeBrokerTransport -or
    -not $result.assertions.pipeTransportDescriptorAttested -or
    -not $result.assertions.unauthorizedPipeClientRejected -or
    -not $result.assertions.runtimeSignedPipeResponse -or
    -not $result.assertions.pipeBrokerHandlesNoPrivateKeyMaterial) {
  throw 'native signer integration omitted named pipe transport assertions'
}
$commit = (git -c safe.directory=C:/projects/UTXORef/UTXO-Ref -C $repository rev-parse HEAD).Trim()
$snapshot = [ordered]@{
  schema = 'utxoref_dlc_native_rust_signer_snapshot_v1'
  capturedAt = [DateTime]::UtcNow.ToString('o')
  network = 'bitcoin-testnet4'
  repository = $repository
  commit = $commit
  rustc = (& $rustc --version | Out-String).Trim()
  cargo = (& $cargo --version | Out-String).Trim()
  cargoLockSha256 = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash.ToLowerInvariant()
  reproducibleBuild = $true
  reproducibleBinarySha256 = $builtBinarySha256
  result = $result
}
$snapshotPath = Join-Path $SnapshotDirectory 'dlc-native-rust-signer-latest.json'
[System.IO.File]::WriteAllText(
  $snapshotPath,
  ($snapshot | ConvertTo-Json -Depth 20),
  [System.Text.UTF8Encoding]::new($false)
)
$checkedEvidence = [ordered]@{
  schema = 'utxoref_dlc_native_rust_signer_evidence_v11'
  network = 'bitcoin-testnet4'
  sourceCommit = $commit
  toolchain = [ordered]@{ rustc = $snapshot.rustc; cargo = $snapshot.cargo }
  cargoLockSha256 = $snapshot.cargoLockSha256
  binarySha256 = $result.binarySha256
  reproducibleBuild = $true
  syntheticKeysOnly = $true
  productionReady = $false
  externalAuditRequired = $true
  signerRaceWorkers = $result.signerRaceWorkers
  assertions = [ordered]@{
    independentCleanBuildsMatched = $true
    rustProcessSigned = [bool]$result.assertions.rustProcessSigned
    javascriptHostVerified = [bool]$result.assertions.javascriptHostVerified
    bip340CompletionVerified = [bool]$result.assertions.bip340CompletionVerified
    adaptorExtractionVerified = [bool]$result.assertions.adaptorExtractionVerified
    validatorAuthorizationVerifiedBySigner = [bool]$result.assertions.validatorAuthorizationVerifiedBySigner
    unpinnedValidatorRejected = [bool]$result.assertions.unpinnedValidatorRejected
    unpinnedSignerRejected = [bool]$result.assertions.unpinnedSignerRejected
    exactOneSignerRaceWinner = [bool]$result.assertions.exactOneSignerRaceWinner
    expiredAuthorizationRejected = [bool]$result.assertions.expiredAuthorizationRejected
    futureAuthorizationRejected = [bool]$result.assertions.futureAuthorizationRejected
    signedClockRollbackRejected = [bool]$result.assertions.signedClockRollbackRejected
    dpapiProtectedKeyBlobsOnly = [bool]$result.assertions.dpapiProtectedKeyBlobsOnly
    dpapiBlobsOpaque = [bool]$result.assertions.dpapiBlobsOpaque
    plaintextKeyFilesRejected = [bool]$result.assertions.plaintextKeyFilesRejected
    expectedWindowsAccountSidBound = [bool]$result.assertions.expectedWindowsAccountSidBound
    unexpectedSignerAccountRejected = [bool]$result.assertions.unexpectedSignerAccountRejected
    protectedKeyDirectoryAclRequired = [bool]$result.assertions.protectedKeyDirectoryAclRequired
    inheritedKeyDirectoryAclRejected = [bool]$result.assertions.inheritedKeyDirectoryAclRejected
    nativeDpapiDecryption = [bool]$result.assertions.nativeDpapiDecryption
    decryptionSecretIpcEliminated = [bool]$result.assertions.decryptionSecretIpcEliminated
    dpapiAccessVerifierSilent = [bool]$result.assertions.dpapiAccessVerifierSilent
    unsafeDpapiFfiBlocks = [int]$result.assertions.unsafeDpapiFfiBlocks
    dpapiOutputMemoryLocked = [bool]$result.assertions.dpapiOutputMemoryLocked
    decryptedKeyBufferMemoryLocked = [bool]$result.assertions.decryptedKeyBufferMemoryLocked
    memoryLockFailureFailsClosed = [bool]$result.assertions.memoryLockFailureFailsClosed
    processMitigationsApplied = [bool]$result.assertions.processMitigationsApplied
    system32OnlyDllSearch = [bool]$result.assertions.system32OnlyDllSearch
    dynamicCodeProhibited = [bool]$result.assertions.dynamicCodeProhibited
    extensionPointsDisabled = [bool]$result.assertions.extensionPointsDisabled
    microsoftSignedImagesOnly = [bool]$result.assertions.microsoftSignedImagesOnly
    remoteAndLowIntegrityImagesRejected = [bool]$result.assertions.remoteAndLowIntegrityImagesRejected
    selfVerifiedExecutableDigest = [bool]$result.assertions.selfVerifiedExecutableDigest
    inAccountCsprngKeyGeneration = [bool]$result.assertions.inAccountCsprngKeyGeneration
    provisioningSecretIpcEliminated = [bool]$result.assertions.provisioningSecretIpcEliminated
    boundedNamedPipeBrokerTransport = [bool]$result.assertions.boundedNamedPipeBrokerTransport
    pipeTransportDescriptorAttested = [bool]$result.assertions.pipeTransportDescriptorAttested
    unauthorizedPipeClientRejected = [bool]$result.assertions.unauthorizedPipeClientRejected
    runtimeSignedPipeResponse = [bool]$result.assertions.runtimeSignedPipeResponse
    pipeBrokerHandlesNoPrivateKeyMaterial = [bool]$result.assertions.pipeBrokerHandlesNoPrivateKeyMaterial
    runtimeIdentityVerifiedByHost = [bool]$result.assertions.runtimeIdentityVerifiedByHost
    restartReplayRejected = [bool]$result.assertions.restartReplayRejected
    signerLocalReplayRejected = [bool]$result.assertions.signerLocalReplayRejected
    hostSuppliedNoSecret = [bool]$result.assertions.hostSuppliedNoSecret
  }
}
$checkedEvidencePath = Join-Path $repository 'bitvm3\utxo_referee\artifacts\dlc_native_rust_signer_latest.json'
[System.IO.File]::WriteAllText(
  $checkedEvidencePath,
  (($checkedEvidence | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Output "binary=$deployedBinary"
Write-Output "binarySha256=$($result.binarySha256)"
Write-Output "evidence=$checkedEvidencePath"
Write-Output "snapshot=$snapshotPath"
