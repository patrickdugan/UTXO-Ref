param(
  [string]$SnapshotDirectory = 'D:\bitagent-testnet4\btc-test-snapshots',
  [string]$EvaluationRoot = 'D:\bitagent-testnet4\dedicated-account-eval',
  [string]$SignerBinaryPath = 'D:\bitagent-testnet4\bin\utxoref-dlc-signer.exe'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$probeScript = Join-Path $repository 'eval\dlc_dedicated_account_probe.js'
$sourceDirectory = Join-Path $repository 'native\dlc-signer'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$clientSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = [System.Security.Principal.WindowsPrincipal]::new(
  [System.Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'dedicated-account evaluation requires an elevated Windows administrator token'
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;

namespace UtxoRef {
  public static class LocalAccountNative {
    private const uint UserPrivilegeUser = 1;
    private const uint UserAccountDisabled = 0x0002;
    private const uint UserNormalAccount = 0x0200;
    private const uint UserPasswordCannotChange = 0x0040;
    private const uint UserPasswordNeverExpires = 0x10000;
    private const uint UserScript = 0x0001;
    private const uint IncludeIndirectGroups = 1;
    private const uint PreferredMaximumLength = 0xffffffff;
    private const int UserNotFound = 2221;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct UserInfo1 {
      [MarshalAs(UnmanagedType.LPWStr)] public string Name;
      public IntPtr Password;
      public uint PasswordAge;
      public uint Privilege;
      [MarshalAs(UnmanagedType.LPWStr)] public string HomeDirectory;
      [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
      public uint Flags;
      [MarshalAs(UnmanagedType.LPWStr)] public string ScriptPath;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UserInfo1008 { public uint Flags; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LocalGroupUsersInfo0 {
      [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    }

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int NetUserAdd(string serverName, uint level, ref UserInfo1 buffer, out uint parameterError);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int NetUserDel(string serverName, string userName);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int NetUserSetInfo(string serverName, string userName, uint level, ref UserInfo1008 buffer, out uint parameterError);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int NetUserGetInfo(string serverName, string userName, uint level, out IntPtr buffer);

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int NetUserGetLocalGroups(
      string serverName, string userName, uint level, uint flags, out IntPtr buffer,
      uint preferredMaximumLength, out uint entriesRead, out uint totalEntries
    );

    [DllImport("Netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);

    private static void ThrowIfError(int result, string operation) {
      if (result != 0) throw new Win32Exception(result, operation);
    }

    public static void Add(string userName, SecureString password, string comment) {
      IntPtr passwordBuffer = IntPtr.Zero;
      try {
        passwordBuffer = Marshal.SecureStringToGlobalAllocUnicode(password);
        UserInfo1 info = new UserInfo1 {
          Name = userName,
          Password = passwordBuffer,
          PasswordAge = 0,
          Privilege = UserPrivilegeUser,
          HomeDirectory = null,
          Comment = comment,
          Flags = UserScript | UserNormalAccount | UserPasswordCannotChange | UserPasswordNeverExpires,
          ScriptPath = null
        };
        uint parameterError;
        int result = NetUserAdd(null, 1, ref info, out parameterError);
        ThrowIfError(result, "NetUserAdd failed at parameter " + parameterError);
      } finally {
        if (passwordBuffer != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(passwordBuffer);
      }
    }

    public static void Disable(string userName) {
      UserInfo1008 info = new UserInfo1008 { Flags = UserNormalAccount | UserAccountDisabled };
      uint parameterError;
      int result = NetUserSetInfo(null, userName, 1008, ref info, out parameterError);
      ThrowIfError(result, "NetUserSetInfo failed at parameter " + parameterError);
    }

    public static void Delete(string userName) {
      ThrowIfError(NetUserDel(null, userName), "NetUserDel failed");
    }

    public static bool Exists(string userName) {
      IntPtr buffer;
      int result = NetUserGetInfo(null, userName, 0, out buffer);
      if (result == UserNotFound) return false;
      ThrowIfError(result, "NetUserGetInfo failed");
      if (buffer != IntPtr.Zero) NetApiBufferFree(buffer);
      return true;
    }

    public static string[] GetLocalGroups(string userName) {
      IntPtr buffer;
      uint entriesRead;
      uint totalEntries;
      int result = NetUserGetLocalGroups(
        null, userName, 0, IncludeIndirectGroups, out buffer,
        PreferredMaximumLength, out entriesRead, out totalEntries
      );
      ThrowIfError(result, "NetUserGetLocalGroups failed");
      try {
        List<string> groups = new List<string>();
        int size = Marshal.SizeOf(typeof(LocalGroupUsersInfo0));
        for (int index = 0; index < entriesRead; index++) {
          IntPtr entry = new IntPtr(buffer.ToInt64() + (long)index * size);
          LocalGroupUsersInfo0 info = (LocalGroupUsersInfo0)Marshal.PtrToStructure(entry, typeof(LocalGroupUsersInfo0));
          groups.Add(info.Name);
        }
        return groups.ToArray();
      } finally {
        if (buffer != IntPtr.Zero) NetApiBufferFree(buffer);
      }
    }
  }
}
'@
foreach ($requiredFile in @($probeScript, $SignerBinaryPath, $powershell)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "required file is missing: $requiredFile" }
}
$evaluationBase = [System.IO.Path]::GetFullPath($EvaluationRoot)
$snapshotRoot = [System.IO.Path]::GetFullPath($SnapshotDirectory)
if ([System.IO.Path]::GetPathRoot($evaluationBase) -ne 'D:\' -or
    [System.IO.Path]::GetPathRoot($snapshotRoot) -ne 'D:\') {
  throw 'dedicated-account evaluation and snapshots must remain on D:'
}
$runId = [guid]::NewGuid().ToString('N')
$accountName = "utxodlc-$($runId.Substring(0, 12))"
$accountDescription = "UTXORef ephemeral signer evaluation $runId"
$runDirectory = [System.IO.Path]::GetFullPath((Join-Path $evaluationBase $runId))
$expectedPrefix = $evaluationBase.TrimEnd('\') + '\'
if (-not $runDirectory.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'dedicated-account evaluation path escaped its controlled root'
}
$codeDirectory = Join-Path $runDirectory 'code'
$stateDirectory = Join-Path $runDirectory 'state'
$keyDirectory = Join-Path $stateDirectory 'keys'
$provisionStdout = Join-Path $stateDirectory 'provision.stdout'
$provisionStderr = Join-Path $stateDirectory 'provision.stderr'
$brokerStdout = Join-Path $stateDirectory 'broker.stdout'
$brokerStderr = Join-Path $stateDirectory 'broker.stderr'
$createdAccount = $false
$securePassword = [System.Security.SecureString]::new()
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$classes = @('ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_=+')
try {
  foreach ($class in $classes) {
    $byte = [byte[]]::new(1)
    $random.GetBytes($byte)
    $securePassword.AppendChar($class[$byte[0] % $class.Length])
  }
  $allCharacters = ($classes -join '')
  for ($index = 0; $index -lt 36; $index++) {
    $byte = [byte[]]::new(1)
    $random.GetBytes($byte)
    $securePassword.AppendChar($allCharacters[$byte[0] % $allCharacters.Length])
  }
} finally {
  $random.Dispose()
}
$securePassword.MakeReadOnly()
$credential = [System.Management.Automation.PSCredential]::new(".\$accountName", $securePassword)

function ConvertTo-WindowsArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Contains([char]0)) { throw 'process argument contains a null character' }
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes++ }
    elseif ($character -eq '"') {
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

function Start-AsSigner {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$StandardOutputPath,
    [Parameter(Mandatory = $true)][string]$StandardErrorPath,
    [switch]$Wait
  )
  $argumentText = ($Arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
  $parameters = @{
    FilePath = $powershell
    ArgumentList = $argumentText
    Credential = $credential
    LoadUserProfile = $true
    WindowStyle = 'Hidden'
    PassThru = $true
    RedirectStandardOutput = $StandardOutputPath
    RedirectStandardError = $StandardErrorPath
  }
  if ($Wait) { $parameters.Wait = $true }
  Start-Process @parameters
}

function Set-ControlledDirectoryAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$SignerSid,
    [Parameter(Mandatory = $true)][bool]$SignerMayWrite
  )
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($entry in @(
    @{ Sid = $clientSid; Rights = [System.Security.AccessControl.FileSystemRights]::FullControl },
    @{ Sid = 'S-1-5-18'; Rights = [System.Security.AccessControl.FileSystemRights]::FullControl },
    @{ Sid = 'S-1-5-32-544'; Rights = [System.Security.AccessControl.FileSystemRights]::FullControl },
    @{ Sid = $SignerSid; Rights = $(if ($SignerMayWrite) {
      [System.Security.AccessControl.FileSystemRights]::Modify
    } else {
      [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    }) }
  )) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new($entry.Sid),
      $entry.Rights,
      $inheritance,
      $propagation,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
  }
  $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new($clientSid))
  [System.IO.Directory]::SetAccessControl($Path, $security)
}

$brokerProcess = $null
$result = $null
$accountRemoved = $false
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
try {
  [UtxoRef.LocalAccountNative]::Add($accountName, $securePassword, $accountDescription)
  $createdAccount = $true
  $signerSid = ([System.Security.Principal.NTAccount]::new("$env:COMPUTERNAME\$accountName")).Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($signerSid -eq $clientSid) { throw 'ephemeral signer SID matches the client SID' }
  $administratorGroupName = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate(
    [System.Security.Principal.NTAccount]
  ).Value.Split('\')[-1]
  if ([UtxoRef.LocalAccountNative]::GetLocalGroups($accountName) -contains $administratorGroupName) {
    throw 'ephemeral signer account unexpectedly has administrator authority'
  }

  New-Item -ItemType Directory -Path $codeDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
  Copy-Item -LiteralPath $SignerBinaryPath -Destination (Join-Path $codeDirectory 'utxoref-dlc-signer.exe')
  foreach ($name in @(
    'initialize-dpapi-key-directory.ps1', 'provision-dpapi-keyset.ps1',
    'verify-dpapi-key-access.ps1', 'run-named-pipe-broker.ps1', 'invoke-named-pipe-signer.ps1'
  )) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $name) -Destination (Join-Path $codeDirectory $name)
  }
  Set-ControlledDirectoryAcl -Path $codeDirectory -SignerSid $signerSid -SignerMayWrite $false
  Set-ControlledDirectoryAcl -Path $stateDirectory -SignerSid $signerSid -SignerMayWrite $true

  $binary = Join-Path $codeDirectory 'utxoref-dlc-signer.exe'
  $verifier = Join-Path $codeDirectory 'verify-dpapi-key-access.ps1'
  $provisioner = Join-Path $codeDirectory 'provision-dpapi-keyset.ps1'
  $provisionProcess = Start-AsSigner -Wait -StandardOutputPath $provisionStdout -StandardErrorPath $provisionStderr -Arguments @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $provisioner, '-DirectoryPath', $keyDirectory,
    '-SignerBinaryPath', $binary, '-AccessVerifierPath', $verifier
  )
  if ($provisionProcess.ExitCode -ne 0) {
    throw "dedicated signer provisioning failed: $((Get-Content -Raw $provisionStderr).Trim())"
  }
  $provisioning = (Get-Content -Raw $provisionStdout).Trim() | ConvertFrom-Json
  if ($provisioning.accountSid -cne $signerSid) { throw 'provisioning ran under an unexpected account SID' }

  $pipeName = "utxoref-dedicated-$($runId.Substring(0, 16))"
  $prepareText = (& node $probeScript prepare $binary $codeDirectory $keyDirectory $provisionStdout `
    $pipeName $signerSid $clientSid $powershell 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "dedicated-account probe preparation failed: $prepareText" }
  $prepared = $prepareText | ConvertFrom-Json
  $broker = Join-Path $codeDirectory 'run-named-pipe-broker.ps1'
  $brokerProcess = Start-AsSigner -StandardOutputPath $brokerStdout -StandardErrorPath $brokerStderr -Arguments @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $broker, '-PipeName', $pipeName, '-SignerBinaryPath', $binary,
    '-KeyDirectory', $keyDirectory, '-ValidatorPolicyPath', $prepared.validatorPolicyPath,
    '-ValidatorPolicySha256', $prepared.validatorPolicyDigest,
    '-AccessVerifierPath', $verifier, '-AccessVerifierSha256', $prepared.verifierDigest,
    '-ExpectedSignerAccountSid', $signerSid, '-ExpectedSignerBinarySha256', $prepared.binarySha256,
    '-AllowedClientSid', $clientSid, '-MaxRequests', '1', '-IdleTimeoutSeconds', '30'
  )
  $probeText = (& node $probeScript run $prepared.probePath 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    if ($null -ne $brokerProcess -and -not $brokerProcess.HasExited) { $brokerProcess.Kill() }
    throw "dedicated-account signing probe failed: $probeText; broker: $((Get-Content -Raw $brokerStderr).Trim())"
  }
  $probeResult = $probeText | ConvertFrom-Json
  if (-not $brokerProcess.WaitForExit(10000) -or $brokerProcess.ExitCode -ne 0) {
    if (-not $brokerProcess.HasExited) { $brokerProcess.Kill() }
    throw "dedicated-account broker failed: $((Get-Content -Raw $brokerStderr).Trim())"
  }
  $brokerProcess = $null
  $keyFiles = @(Get-ChildItem -LiteralPath $keyDirectory -File)
  if (@($keyFiles | Where-Object { $_.Name -match '(?i)\.key$' }).Count -ne 0 -or
      @($keyFiles | Where-Object { $_.Name -match '(?i)\.key\.dpapi$' }).Count -ne 2) {
    throw 'dedicated signer key directory does not contain exactly two DPAPI key blobs'
  }
  $result = [ordered]@{
    schema = 'utxoref_dlc_dedicated_account_evidence_v1'
    capturedAt = [DateTime]::UtcNow.ToString('o')
    network = 'bitcoin-testnet4'
    sourceCommit = (git -c safe.directory=C:/projects/UTXORef/UTXO-Ref -C $repository rev-parse HEAD).Trim()
    signerAccountName = $accountName
    signerAccountSid = $signerSid
    clientAccountSid = $clientSid
    signerBinarySha256 = [string]$probeResult.executableSha256
    runtimeClosureDigest = [string]$probeResult.runtimeClosureDigest
    signerPubkeyX = [string]$probeResult.signerPubkeyX
    presignatureDigest = [string]$probeResult.presignatureDigest
    assertions = [ordered]@{
      elevatedHarness = $true
      ephemeralNonAdministratorSignerAccount = $true
      distinctSignerAndClientSids = $true
      inAccountDpapiProvisioning = $true
      noPasswordFileOrArgument = $true
      protectedCodeDirectory = $true
      signerCannotWriteRuntimeClosure = $true
      protectedKeyDirectory = $true
      dpapiKeyBlobsOnly = $true
      sidAuthenticatedNamedPipe = $true
      runtimeSignedResponseVerifiedByClient = [bool]$probeResult.verified
      syntheticKeysOnly = $true
      broadcastAttempted = $false
    }
    productionReady = $false
    externalAuditRequired = $true
  }
} finally {
  if ($null -ne $brokerProcess -and -not $brokerProcess.HasExited) {
    try { $brokerProcess.Kill() } catch { $cleanupErrors.Add("broker cleanup: $($_.Exception.Message)") }
  }
  if ($createdAccount) {
    try { [UtxoRef.LocalAccountNative]::Disable($accountName) }
    catch { $cleanupErrors.Add("account disable: $($_.Exception.Message)") }
    try { [UtxoRef.LocalAccountNative]::Delete($accountName) }
    catch { $cleanupErrors.Add("account removal: $($_.Exception.Message)") }
    try { $accountRemoved = -not [UtxoRef.LocalAccountNative]::Exists($accountName) }
    catch { $cleanupErrors.Add("account removal verification: $($_.Exception.Message)") }
  }
  $credential = $null
  try { $securePassword.Dispose() }
  catch { $cleanupErrors.Add("password cleanup: $($_.Exception.Message)") }
  if (Test-Path -LiteralPath $runDirectory) {
    try {
      $resolvedRunDirectory = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $runDirectory).Path)
      if (-not $resolvedRunDirectory.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'refusing to remove an evaluation directory outside the controlled root'
      }
      Remove-Item -LiteralPath $resolvedRunDirectory -Recurse -Force
    } catch {
      $cleanupErrors.Add("workspace cleanup: $($_.Exception.Message)")
    }
  }
}
if ($cleanupErrors.Count -gt 0) { throw ($cleanupErrors -join '; ') }
if ($null -eq $result -or -not $accountRemoved) { throw 'dedicated signer account cleanup was not verified' }
$result.assertions.ephemeralSignerAccountRemoved = $true
$result.assertions.ephemeralKeyWorkspaceRemoved = -not (Test-Path -LiteralPath $runDirectory)
New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
$evidencePath = Join-Path $snapshotRoot 'dlc-dedicated-account-latest.json'
[System.IO.File]::WriteAllText(
  $evidencePath,
  (($result | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Output "signerSid=$($result.signerAccountSid)"
Write-Output "clientSid=$($result.clientAccountSid)"
Write-Output 'crossAccountSigning=verified'
Write-Output 'ephemeralAccountRemoved=true'
Write-Output "evidence=$evidencePath"
