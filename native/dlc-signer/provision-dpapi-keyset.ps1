param(
  [Parameter(Mandatory = $true)]
  [string]$DirectoryPath,

  [Parameter(Mandatory = $true)]
  [string]$SignerBinaryPath,

  [Parameter(Mandatory = $true)]
  [string]$AccessVerifierPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security

foreach ($value in @($DirectoryPath, $SignerBinaryPath, $AccessVerifierPath)) {
  if (-not [System.IO.Path]::IsPathRooted($value)) {
    throw 'DPAPI keyset provisioning paths must be absolute'
  }
}
$directory = [System.IO.Path]::GetFullPath($DirectoryPath)
$binary = [System.IO.Path]::GetFullPath($SignerBinaryPath)
$verifier = [System.IO.Path]::GetFullPath($AccessVerifierPath)
if ($directory -eq [System.IO.Path]::GetPathRoot($directory)) {
  throw 'DPAPI key directory must not be a volume root'
}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or
    -not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
  throw 'signer binary and access verifier must be existing files'
}

$initializer = Join-Path $PSScriptRoot 'initialize-dpapi-key-directory.ps1'
$accountSid = (& $initializer -DirectoryPath $directory | Out-String).Trim()
if ($accountSid -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') {
  throw 'DPAPI initializer returned no signer account SID'
}
$candidatePath = Join-Path $directory 'signer-candidate.key.dpapi'
$runtimePath = Join-Path $directory 'runtime-identity.key.dpapi'
$finalSignerPath = $null
$binaryDigest = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
$verifierDigest = (Get-FileHash -LiteralPath $verifier -Algorithm SHA256).Hash.ToLowerInvariant()

function Write-RandomDpapiBlob {
  param([Parameter(Mandatory = $true)][string]$DestinationPath)

  $secret = [byte[]]::new(32)
  $protected = $null
  try {
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($secret)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $secret,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    if ($protected.Length -lt 64 -or $protected.Length -gt 4096) {
      throw 'DPAPI returned an unexpected protected key length'
    }
    $stream = [System.IO.FileStream]::new(
      $DestinationPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try {
      $stream.Write($protected, 0, $protected.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  } finally {
    [Array]::Clear($secret, 0, $secret.Length)
    if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }
  }
}

try {
  Write-RandomDpapiBlob -DestinationPath $candidatePath
  Write-RandomDpapiBlob -DestinationPath $runtimePath
  $descriptionText = (& $binary '--describe-dpapi-keyset' $directory $verifier $verifierDigest `
      $accountSid $binaryDigest 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "native signer could not describe the generated keyset`n$descriptionText"
  }
  $description = $descriptionText | ConvertFrom-Json
  if ($description.schema -cne 'utxoref_dlc_dpapi_keyset_public_v1' -or
      [string]$description.signerPubkeyX -notmatch '^[0-9a-f]{64}$' -or
      [string]$description.runtimeIdentityKeyId -notmatch '^[0-9a-f]{64}$' -or
      [string]$description.executableSha256 -cne $binaryDigest) {
    throw 'native signer returned an invalid public keyset description'
  }
  $runtimeSpki = [Convert]::FromBase64String([string]$description.runtimeIdentityPublicKeySpki)
  if ($runtimeSpki.Length -ne 44 -or
      (Get-FileHash -InputStream ([System.IO.MemoryStream]::new($runtimeSpki)) -Algorithm SHA256).Hash.ToLowerInvariant() -cne
        [string]$description.runtimeIdentityKeyId) {
    throw 'native signer returned an invalid runtime identity'
  }
  $finalSignerPath = Join-Path $directory ("$($description.signerPubkeyX).key.dpapi")
  [System.IO.File]::Move($candidatePath, $finalSignerPath)
  [ordered]@{
    schema = 'utxoref_dlc_dpapi_keyset_provisioning_v1'
    accountSid = $accountSid
    keyDirectory = $directory
    signerPubkeyX = [string]$description.signerPubkeyX
    runtimeIdentityKeyId = [string]$description.runtimeIdentityKeyId
    runtimeIdentityPublicKeySpki = [string]$description.runtimeIdentityPublicKeySpki
    signerBinarySha256 = $binaryDigest
    accessVerifierSha256 = $verifierDigest
    plaintextSecretInput = $false
  } | ConvertTo-Json -Compress
} catch {
  Remove-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $runtimePath -Force -ErrorAction SilentlyContinue
  if ($null -ne $finalSignerPath) {
    Remove-Item -LiteralPath $finalSignerPath -Force -ErrorAction SilentlyContinue
  }
  throw
}
