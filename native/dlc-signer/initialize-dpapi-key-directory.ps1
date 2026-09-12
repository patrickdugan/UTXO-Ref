param(
  [Parameter(Mandatory = $true)]
  [string]$DirectoryPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not [System.IO.Path]::IsPathRooted($DirectoryPath)) {
  throw 'DPAPI key directory path must be absolute'
}
$directory = [System.IO.Path]::GetFullPath($DirectoryPath)
if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
}
if (@([System.IO.Directory]::EnumerateFileSystemEntries($directory)).Count -ne 0) {
  throw 'DPAPI key directory must be empty before ACL initialization'
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$accountSid = $identity.User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$arguments = @(
  $directory,
  '/inheritance:r',
  '/grant:r',
  "*$($accountSid.Value):(OI)(CI)F",
  "*$($systemSid.Value):(OI)(CI)F",
  "*$($administratorsSid.Value):(OI)(CI)F"
)
& $icacls @arguments | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'failed to initialize the DPAPI key-directory ACL' }
$acl = Get-Acl -LiteralPath $directory
if (-not $acl.AreAccessRulesProtected) { throw 'DPAPI key-directory ACL remained inherited' }
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $accountSid.Value) {
  throw 'DPAPI key-directory owner does not match the signer account SID'
}
Write-Output $accountSid.Value
