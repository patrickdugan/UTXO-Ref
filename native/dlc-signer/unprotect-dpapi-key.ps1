param(
  [Parameter(Mandatory = $true)]
  [string]$BlobPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security

if (-not [System.IO.Path]::IsPathRooted($BlobPath)) {
  throw 'DPAPI key blob path must be absolute'
}
$path = [System.IO.Path]::GetFullPath($BlobPath)
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
