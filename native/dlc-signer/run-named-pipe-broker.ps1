param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$SignerBinaryPath,
  [Parameter(Mandatory = $true)][string]$KeyDirectory,
  [Parameter(Mandatory = $true)][string]$ValidatorPolicyPath,
  [Parameter(Mandatory = $true)][string]$ValidatorPolicySha256,
  [Parameter(Mandatory = $true)][string]$AccessVerifierPath,
  [Parameter(Mandatory = $true)][string]$AccessVerifierSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedSignerAccountSid,
  [Parameter(Mandatory = $true)][string]$ExpectedSignerBinarySha256,
  [Parameter(Mandatory = $true)][string]$AllowedClientSid,
  [ValidateRange(1, 1024)][int]$MaxRequests = 1024,
  [ValidateRange(1, 300)][int]$IdleTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap {
  [Console]::Error.WriteLine($_.Exception.Message)
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  exit 1
}
$maximumRequestBytes = 65536
$maximumResponseBytes = 1048576
if ($PipeName -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'named pipe name is invalid' }
foreach ($sid in @($ExpectedSignerAccountSid, $AllowedClientSid)) {
  if ($sid -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') { throw 'named pipe account SID is invalid' }
}
foreach ($digest in @($ValidatorPolicySha256, $AccessVerifierSha256, $ExpectedSignerBinarySha256)) {
  if ($digest -notmatch '^[0-9a-f]{64}$') { throw 'named pipe broker digest is invalid' }
}
$binary = [System.IO.Path]::GetFullPath($SignerBinaryPath)
$keys = [System.IO.Path]::GetFullPath($KeyDirectory)
$policy = [System.IO.Path]::GetFullPath($ValidatorPolicyPath)
$verifier = [System.IO.Path]::GetFullPath($AccessVerifierPath)
if (-not [System.IO.Path]::IsPathRooted($SignerBinaryPath) -or
    -not [System.IO.Path]::IsPathRooted($KeyDirectory) -or
    -not [System.IO.Path]::IsPathRooted($ValidatorPolicyPath) -or
    -not [System.IO.Path]::IsPathRooted($AccessVerifierPath) -or
    -not (Test-Path -LiteralPath $binary -PathType Leaf) -or
    -not (Test-Path -LiteralPath $keys -PathType Container) -or
    -not (Test-Path -LiteralPath $policy -PathType Leaf) -or
    -not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
  throw 'named pipe broker paths must be existing absolute paths'
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($currentSid -cne $ExpectedSignerAccountSid) { throw 'named pipe broker is running under an unexpected signer SID' }
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSignerBinarySha256 -or
    (Get-FileHash -LiteralPath $policy -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ValidatorPolicySha256 -or
    (Get-FileHash -LiteralPath $verifier -Algorithm SHA256).Hash.ToLowerInvariant() -cne $AccessVerifierSha256) {
  throw 'named pipe broker runtime closure digest mismatch'
}

function Read-ExactBytes {
  param([System.IO.Stream]$Stream, [int]$Count)
  $bytes = [byte[]]::new($Count)
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($bytes, $offset, $Count - $offset)
    if ($read -le 0) { throw 'named pipe peer closed a truncated frame' }
    $offset += $read
  }
  return $bytes
}

function Write-Frame {
  param([System.IO.Stream]$Stream, [byte[]]$Payload)
  $length = [BitConverter]::GetBytes([int]$Payload.Length)
  $Stream.Write($length, 0, $length.Length)
  $Stream.Write($Payload, 0, $Payload.Length)
  $Stream.Flush()
}

function ConvertTo-WindowsArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 2048 -or $Value.Contains([char]0)) { throw 'signer launch argument is invalid' }
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
    } elseif ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
    } else {
      if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)) }
      [void]$builder.Append($character)
      $backslashes = 0
    }
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

$pipeSecurity = [System.IO.Pipes.PipeSecurity]::new()
$pipeSecurity.SetAccessRuleProtection($true, $false)
foreach ($sid in @($ExpectedSignerAccountSid, $AllowedClientSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.IO.Pipes.PipeAccessRule]::new(
    $identity,
    [System.IO.Pipes.PipeAccessRights]::ReadWrite,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $pipeSecurity.AddAccessRule($rule)
}
$pipeSecurity.SetOwner([System.Security.Principal.SecurityIdentifier]::new($ExpectedSignerAccountSid))

for ($requestIndex = 0; $requestIndex -lt $MaxRequests; $requestIndex++) {
  $server = [System.IO.Pipes.NamedPipeServerStream]::new(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::WriteThrough,
    $maximumRequestBytes + 4,
    $maximumResponseBytes + 4,
    $pipeSecurity
  )
  try {
    $connected = $server.WaitForConnectionAsync().Wait([TimeSpan]::FromSeconds($IdleTimeoutSeconds))
    if (-not $connected) { break }
    $clientName = $server.GetImpersonationUserName()
    $clientSid = ([System.Security.Principal.NTAccount]::new($clientName)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
    if ($clientSid -cne $AllowedClientSid) { throw 'named pipe client SID is not authorized' }
    $header = Read-ExactBytes -Stream $server -Count 4
    $requestLength = [BitConverter]::ToInt32($header, 0)
    if ($requestLength -lt 1 -or $requestLength -gt $maximumRequestBytes) {
      throw 'named pipe request frame length is invalid'
    }
    $requestBytes = Read-ExactBytes -Stream $server -Count $requestLength
    $process = $null
    $stdoutStream = $null
    try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $binary
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $signerArguments = @(
      $keys, $policy, $ValidatorPolicySha256, $verifier, $AccessVerifierSha256,
      $ExpectedSignerAccountSid, $ExpectedSignerBinarySha256
    )
    $startInfo.Arguments = ($signerArguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $startInfo.EnvironmentVariables.Clear()
    if ($null -ne $env:SystemRoot) { $startInfo.EnvironmentVariables['SystemRoot'] = $env:SystemRoot }
    if ($null -ne $env:WINDIR) { $startInfo.EnvironmentVariables['WINDIR'] = $env:WINDIR }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdoutStream = [System.IO.MemoryStream]::new()
    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) {
      $process.Kill()
      throw 'named pipe signer execution timed out'
    }
    $stdoutTask.GetAwaiter().GetResult()
    $stdoutBytes = $stdoutStream.ToArray()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdoutBytes.Length -gt $maximumResponseBytes -or
        [System.Text.Encoding]::UTF8.GetByteCount($stderr) -gt $maximumResponseBytes) {
      throw 'named pipe signer response is oversized'
    }
    $brokerResponse = [ordered]@{
      ok = ($process.ExitCode -eq 0)
      exitCode = $process.ExitCode
      stdout = [Convert]::ToBase64String($stdoutBytes)
      stderr = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($stderr))
    } | ConvertTo-Json -Compress
    $brokerResponseBytes = [System.Text.Encoding]::UTF8.GetBytes($brokerResponse)
    if ($brokerResponseBytes.Length -gt $maximumResponseBytes) {
      throw 'named pipe broker response envelope is oversized'
    }
    Write-Frame -Stream $server -Payload $brokerResponseBytes
    } finally {
      if ($null -ne $process) {
        if (-not $process.HasExited) {
          try { $process.Kill() } catch { }
        }
        $process.Dispose()
      }
      if ($null -ne $stdoutStream) { $stdoutStream.Dispose() }
    }
  } finally {
    $server.Dispose()
  }
}
