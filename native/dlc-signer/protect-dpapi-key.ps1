param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security

if (-not [System.IO.Path]::IsPathRooted($DestinationPath)) {
  throw 'DPAPI destination path must be absolute'
}
$destination = [System.IO.Path]::GetFullPath($DestinationPath)
$parent = Split-Path -Parent $destination
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
  throw 'DPAPI destination parent directory must exist'
}
$secretHex = ([Console]::In.ReadToEnd()).Trim()
if ($secretHex -notmatch '^[0-9a-f]{64}$') {
  throw 'DPAPI key input must be exactly 32 bytes of lowercase hexadecimal on standard input'
}
$secret = New-Object byte[] 32
$protected = $null
try {
  for ($index = 0; $index -lt 32; $index++) {
    $secret[$index] = [Convert]::ToByte($secretHex.Substring($index * 2, 2), 16)
  }
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $secret,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ($protected.Length -lt 64 -or $protected.Length -gt 4096) {
    throw 'DPAPI returned an unexpected protected key length'
  }
  $stream = [System.IO.FileStream]::new(
    $destination,
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
  $secretHex = $null
}
[Console]::Out.Write($destination)
