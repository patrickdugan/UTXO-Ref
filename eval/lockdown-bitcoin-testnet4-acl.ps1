param(
  [string]$DataDirectory = 'D:\BitcoinTestnet',
  [string]$BackupDirectory = 'D:\bitagent-testnet4\acl-backups',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = [System.IO.Path]::GetFullPath($DataDirectory).TrimEnd('\')
if (-not [System.IO.Path]::IsPathFullyQualified($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
  throw 'Bitcoin data directory must be an existing absolute directory'
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSids = @(
  $currentSid,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)

$descendants = @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($entry in $descendants) {
  $resolved = [System.IO.Path]::GetFullPath($entry.FullName)
  if (-not $resolved.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ACL target escaped the Bitcoin data directory: $resolved"
  }
  if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Bitcoin data directory contains a filesystem link: $resolved"
  }
}

$summary = [ordered]@{
  schema = 'utxoref_bitcoin_testnet4_acl_lockdown_v1'
  dataDirectory = $root
  currentSid = $currentSid.Value
  targetCount = $descendants.Count + 1
  applied = [bool]$Apply
  backup = $null
}
if (-not $Apply) {
  $summary | ConvertTo-Json
  exit 0
}

[System.IO.Directory]::CreateDirectory($BackupDirectory) | Out-Null
$backupPath = Join-Path $BackupDirectory ("bitcoin-testnet4-acl-{0}.txt" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
$backupOutput = & "$env:SystemRoot\System32\icacls.exe" $root '/save' $backupPath '/t' '/c' '/q' 2>&1
if ($LASTEXITCODE -ne 0) { throw "could not save ACL backup: $($backupOutput -join ' ')" }
$summary.backup = $backupPath

function Set-RestrictedAcl {
  param([string]$Path, [bool]$Directory)
  $security = if ($Directory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($currentSid)
  $inheritance = if ($Directory) {
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  foreach ($sid in $allowedSids) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security
}

# Secure the root first so files created by the running node inherit the new boundary.
Set-RestrictedAcl $root $true
foreach ($entry in $descendants | Sort-Object { $_.FullName.Length }) {
  Set-RestrictedAcl $entry.FullName $entry.PSIsContainer
}

$summary | ConvertTo-Json
