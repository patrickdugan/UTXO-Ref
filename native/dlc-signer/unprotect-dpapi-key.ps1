param(
  [Parameter(Mandatory = $true)]
  [string]$BlobPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedAccountSid
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security

if ($ExpectedAccountSid -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') {
  throw 'expected Windows account SID is malformed'
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($currentSid -cne $ExpectedAccountSid) {
  throw 'DPAPI signer is running under an unexpected Windows account SID'
}

if (-not [System.IO.Path]::IsPathRooted($BlobPath)) {
  throw 'DPAPI key blob path must be absolute'
}
$path = [System.IO.Path]::GetFullPath($BlobPath)
$directory = [System.IO.Path]::GetDirectoryName($path)
$allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
$directoryAcl = [System.IO.Directory]::GetAccessControl($directory)
if (-not $directoryAcl.AreAccessRulesProtected) {
  throw 'DPAPI key directory must disable inherited ACLs'
}
if ($directoryAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $currentSid) {
  throw 'DPAPI key directory owner must match the signer account SID'
}
foreach ($rule in $directoryAcl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
)) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $allowedSids -cnotcontains $rule.IdentityReference.Value) {
    throw 'DPAPI key directory grants access to an unauthorized SID'
  }
}
$fileAcl = [System.IO.File]::GetAccessControl($path)
if ($fileAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $currentSid) {
  throw 'DPAPI key blob owner must match the signer account SID'
}
foreach ($rule in $fileAcl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
)) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $allowedSids -cnotcontains $rule.IdentityReference.Value) {
    throw 'DPAPI key blob grants access to an unauthorized SID'
  }
}
$protected = [System.IO.File]::ReadAllBytes($path)
$secret = $null
try {
  if ($protected.Length -lt 64 -or $protected.Length -gt 4096) {
    throw 'DPAPI key blob has an unexpected length'
  }
  $secret = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ($secret.Length -ne 32) { throw 'DPAPI key blob did not contain a 32-byte key' }
  $encoded = [System.Text.StringBuilder]::new(64)
  foreach ($byte in $secret) { [void]$encoded.Append($byte.ToString('x2')) }
  [Console]::Out.Write($encoded.ToString())
} finally {
  [Array]::Clear($protected, 0, $protected.Length)
  if ($null -ne $secret) { [Array]::Clear($secret, 0, $secret.Length) }
}
