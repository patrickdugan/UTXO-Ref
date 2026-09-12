param(
  [string]$DataDirectory = 'D:\BitcoinTestnet',
  [string]$WalletName = 'utxoref-testnet',
  [string]$BitcoinCli = 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin\bitcoin-cli.exe',
  [string]$BitcoinDaemon = 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin\bitcoind.exe',
  [ValidateRange(1, 65535)][int]$RpcPort = 48332,
  [string]$AgentIdentity = '',
  [string]$ProxyTokenFile = '',
  [switch]$TrustedCoordinator,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedSignerSubject = 'CN=Bitcoin Core Code Signing LLC, O=Bitcoin Core Code Signing LLC, L=Lewes, S=Delaware, C=US'
$expectedSignerThumbprint = '3A31CC9595E7A30096A8EA77F9DA2A6CB63F766F'
$expectedBitcoindSha256 = 'f79eeb94e1379986df9f7be4c78c8fc8e18dc9be64a31cbaa8acad249d3db77a'
$expectedBitcoinCliSha256 = 'f6ff1c850fd812c88afd817daac488dfac48b1a12eb99090ce541a663787698b'

function Add-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail)
  $script:checks.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail })
}

function Resolve-Sid {
  param($Identity)
  $text = if ($Identity -is [string]) { $Identity } else { $Identity.Value }
  if ($text -match '^S-1-[0-9]+(?:-[0-9]+)+$') { return $text }
  try {
    if ($Identity -isnot [string]) {
      return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    return ([System.Security.Principal.NTAccount]::new($text)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    return $null
  }
}

function Test-RestrictedAcl {
  param([string]$Path, [bool]$RequireProtected)
  if (-not (Test-Path -LiteralPath $Path)) {
    Add-Check "acl:$Path" $false 'required path is missing'
    return
  }
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = Resolve-Sid $acl.Owner
  $unexpected = @($acl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (Resolve-Sid $_.IdentityReference) -notin $allowedSids
  })
  $passed = $ownerSid -in $allowedSids -and $unexpected.Count -eq 0 -and
    (-not $RequireProtected -or $acl.AreAccessRulesProtected)
  $detail = if ($passed) {
    'owner and effective allow rules are restricted to the coordinator, SYSTEM, and Administrators'
  } else {
    "protected=$($acl.AreAccessRulesProtected); ownerAllowed=$($ownerSid -in $allowedSids); unexpectedAllowRules=$($unexpected.Count)"
  }
  Add-Check "acl:$Path" $passed $detail
}

function Test-PinnedBitcoinBinary {
  param([string]$Name, [string]$Path, [string]$ExpectedSha256)
  if (-not [System.IO.Path]::IsPathFullyQualified($Path) -or
      -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-Check "binary:$Name" $false 'pinned absolute binary path is missing'
    return $false
  }
  $item = Get-Item -LiteralPath $Path -Force
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  $linked = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  $passed = -not $linked -and $signature.Status -eq 'Valid' -and
    $signature.SignerCertificate.Subject -ceq $expectedSignerSubject -and
    $signature.SignerCertificate.Thumbprint -ceq $expectedSignerThumbprint -and
    $sha256 -ceq $ExpectedSha256
  Add-Check "binary:$Name" $passed "linked=$linked; signature=$($signature.Status); signerPinned=$($signature.SignerCertificate.Thumbprint -ceq $expectedSignerThumbprint); sha256Pinned=$($sha256 -ceq $ExpectedSha256)"
  return $passed
}

function Test-ActualRpcListener {
  param([int]$Port, [string]$ExpectedDaemon)
  $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
  if (-not (Test-Path -LiteralPath $netstat -PathType Leaf)) {
    Add-Check 'actual-loopback-rpc-listener' $false 'netstat is unavailable'
    return
  }
  $listeners = @(& $netstat -ano -p tcp | ForEach-Object {
    $parts = $_.Trim() -split '\s+'
    if ($parts.Count -ge 5 -and $parts[0] -eq 'TCP' -and $parts[3] -eq 'LISTENING' -and
        $parts[1] -match ":$Port$") {
      [pscustomobject]@{ LocalAddress = $parts[1]; OwningProcess = [int]$parts[4] }
    }
  })
  $allowedEndpoints = @("127.0.0.1:$Port", "[::1]:$Port")
  $ownerPids = @($listeners.OwningProcess | Sort-Object -Unique)
  $ownerPath = $null
  if ($ownerPids.Count -eq 1) {
    try { $ownerPath = (Get-Process -Id $ownerPids[0] -ErrorAction Stop).Path } catch { $ownerPath = $null }
  }
  $expectedPath = [System.IO.Path]::GetFullPath($ExpectedDaemon)
  $ownerMatches = $ownerPath -and [System.IO.Path]::GetFullPath($ownerPath) -ieq $expectedPath
  $passed = $listeners.Count -gt 0 -and
    @($listeners | Where-Object { $_.LocalAddress -notin $allowedEndpoints }).Count -eq 0 -and
    $ownerPids.Count -eq 1 -and $ownerMatches
  Add-Check 'actual-loopback-rpc-listener' $passed "listeners=$($listeners.Count); nonLoopback=$(@($listeners | Where-Object { $_.LocalAddress -notin $allowedEndpoints }).Count); ownerPids=$($ownerPids.Count); ownerBinaryPinned=$ownerMatches"
}

function Test-ProxyTokenBoundary {
  param([string]$Path, [string]$AgentSid)
  if (-not $Path -or -not [System.IO.Path]::IsPathFullyQualified($Path) -or
      -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-Check 'proxy-token-boundary' $false 'an absolute existing proxy token file is required'
    return
  }
  $item = Get-Item -LiteralPath $Path -Force
  $linked = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  $token = (Get-Content -LiteralPath $Path -Raw).Trim()
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = Resolve-Sid $acl.Owner
  $tokenAllowedSids = @($currentSid, $AgentSid, 'S-1-5-18', 'S-1-5-32-544')
  $unexpected = @($acl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (Resolve-Sid $_.IdentityReference) -notin $tokenAllowedSids
  })
  $agentAllows = @($acl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (Resolve-Sid $_.IdentityReference) -eq $AgentSid
  })
  $writeMask = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $agentCanRead = @($agentAllows | Where-Object {
    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0
  }).Count -gt 0
  $agentCanWrite = @($agentAllows | Where-Object { ($_.FileSystemRights -band $writeMask) -ne 0 }).Count -gt 0
  $parentPath = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  $parentAcl = Get-Acl -LiteralPath $parentPath
  $parentOwnerSid = Resolve-Sid $parentAcl.Owner
  $parentUnexpected = @($parentAcl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (Resolve-Sid $_.IdentityReference) -notin $tokenAllowedSids
  })
  $agentParentAllows = @($parentAcl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (Resolve-Sid $_.IdentityReference) -eq $AgentSid
  })
  $agentCanTraverseParent = @($agentParentAllows | Where-Object {
    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
      [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  }).Count -gt 0
  $agentCanWriteParent = @($agentParentAllows | Where-Object {
    ($_.FileSystemRights -band $writeMask) -ne 0 -or
    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::CreateFiles) -ne 0 -or
    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0
  }).Count -gt 0
  $passed = -not $linked -and $token -match '^[0-9a-f]{64}$' -and
    $acl.AreAccessRulesProtected -and $ownerSid -in $allowedSids -and
    $unexpected.Count -eq 0 -and $agentCanRead -and -not $agentCanWrite -and
    $parentAcl.AreAccessRulesProtected -and $parentOwnerSid -in $allowedSids -and
    $parentUnexpected.Count -eq 0 -and $agentCanTraverseParent -and -not $agentCanWriteParent
  $detail = "linked=$linked; protected=$($acl.AreAccessRulesProtected); ownerAllowed=$($ownerSid -in $allowedSids); unexpectedAllowRules=$($unexpected.Count); agentCanRead=$agentCanRead; agentCanWrite=$agentCanWrite; parentProtected=$($parentAcl.AreAccessRulesProtected); parentOwnerAllowed=$($parentOwnerSid -in $allowedSids); parentUnexpectedAllowRules=$($parentUnexpected.Count); agentCanTraverseParent=$agentCanTraverseParent; agentCanWriteParent=$agentCanWriteParent"
  Add-Check 'proxy-token-boundary' $passed $detail
}

function Invoke-BitcoinJson {
  param([string]$Method, [string[]]$Parameters = @(), [switch]$Wallet)
  $arguments = @("-datadir=$DataDirectory", '-chain=testnet4')
  if ($Wallet) { $arguments += "-rpcwallet=$WalletName" }
  $arguments += $Method
  $arguments += $Parameters
  $output = & $BitcoinCli @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "bitcoin-cli $Method failed" }
  return (($output -join "`n") | ConvertFrom-Json)
}

$checks = [System.Collections.Generic.List[object]]::new()
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
$agentSid = if ($AgentIdentity) { Resolve-Sid $AgentIdentity } else { $null }
$dataDirectoryPath = [System.IO.Path]::GetFullPath($DataDirectory)
$chainDirectory = Join-Path $dataDirectoryPath 'testnet4'
$cookiePath = Join-Path $chainDirectory '.cookie'
$walletDirectory = Join-Path $chainDirectory (Join-Path 'wallets' $WalletName)
$walletDatabase = Join-Path $walletDirectory 'wallet.dat'
$configurationPath = Join-Path $dataDirectoryPath 'bitcoin.conf'

$cliPinned = Test-PinnedBitcoinBinary 'bitcoin-cli' $BitcoinCli $expectedBitcoinCliSha256
$daemonPinned = Test-PinnedBitcoinBinary 'bitcoind' $BitcoinDaemon $expectedBitcoindSha256
Test-ActualRpcListener $RpcPort $BitcoinDaemon
if ($TrustedCoordinator) {
  Add-Check 'dedicated-swarm-account' $true 'not required for the trusted-coordinator inspection mode'
  Add-Check 'proxy-token-boundary' $true 'not required for the trusted-coordinator inspection mode'
} else {
  $accountDistinct = $agentSid -and $agentSid -notin @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  $localAccountEnabled = $false
  $unexpectedLocalGroups = @()
  if ($accountDistinct) {
    try {
      $computer = [ADSI]("WinNT://$env:COMPUTERNAME")
      $localAccounts = @($computer.Children | Where-Object { $_.SchemaClassName -eq 'User' })
      $localAccount = @($localAccounts | Where-Object {
        ([System.Security.Principal.SecurityIdentifier]::new($_.objectSID[0], 0)).Value -eq $agentSid
      })
      if ($localAccount.Count -ne 1) { throw 'agent is not one local user' }
      $localAccountEnabled = (([int]$localAccount[0].UserFlags.Value) -band 2) -eq 0
      $groupRecords = @($computer.Children | Where-Object { $_.SchemaClassName -eq 'Group' } | ForEach-Object {
        $memberSids = @($_.psbase.Invoke('Members') | ForEach-Object {
          $bytes = $_.GetType().InvokeMember('objectSID', 'GetProperty', $null, $_, $null)
          ([System.Security.Principal.SecurityIdentifier]::new($bytes, 0)).Value
        })
        [pscustomobject]@{
          Sid = ([System.Security.Principal.SecurityIdentifier]::new($_.objectSID[0], 0)).Value
          MemberSids = $memberSids
        }
      })
      $reachableSids = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
      )
      [void]$reachableSids.Add($agentSid)
      do {
        $added = $false
        foreach ($group in $groupRecords) {
          if (-not $reachableSids.Contains($group.Sid) -and
              @($group.MemberSids | Where-Object { $reachableSids.Contains($_) }).Count -gt 0) {
            [void]$reachableSids.Add($group.Sid)
            $added = $true
          }
        }
      } while ($added)
      $privilegedGroupSids = @(
        'S-1-5-32-544', # Administrators
        'S-1-5-32-547', # Power Users
        'S-1-5-32-548', # Account Operators
        'S-1-5-32-549', # Server Operators
        'S-1-5-32-550', # Print Operators
        'S-1-5-32-551', # Backup Operators
        'S-1-5-32-555', # Remote Desktop Users
        'S-1-5-32-556', # Network Configuration Operators
        'S-1-5-32-559', # Performance Log Users
        'S-1-5-32-562', # Distributed COM Users
        'S-1-5-32-569', # Cryptographic Operators
        'S-1-5-32-573', # Event Log Readers
        'S-1-5-32-578', # Hyper-V Administrators
        'S-1-5-32-580'  # Remote Management Users
      )
      $unexpectedLocalGroups = @($groupRecords | Where-Object {
        $reachableSids.Contains($_.Sid) -and $_.Sid -in $privilegedGroupSids
      })
    } catch {
      $accountDistinct = $false
    }
  }
  Add-Check 'dedicated-swarm-account' (
    $accountDistinct -and $localAccountEnabled -and $unexpectedLocalGroups.Count -eq 0
  ) $(
    if (-not $agentSid) { 'AgentIdentity is required and must resolve to a Windows SID' }
    elseif (-not $accountDistinct) { 'agent identity is privileged, matches the coordinator, or could not be audited' }
    elseif (-not $localAccountEnabled) { 'agent identity is not an enabled local user' }
    elseif ($unexpectedLocalGroups.Count -ne 0) { "agent has privileged direct or nested local-group memberships=$($unexpectedLocalGroups.Count)" }
    else { "distinct enabled low-privilege local agent SID=$agentSid" }
  )
  Test-ProxyTokenBoundary $ProxyTokenFile $agentSid
}
Test-RestrictedAcl $dataDirectoryPath $true
Test-RestrictedAcl $configurationPath $false
Test-RestrictedAcl $chainDirectory $false
Test-RestrictedAcl $cookiePath $false
Test-RestrictedAcl $walletDirectory $false
Test-RestrictedAcl $walletDatabase $false

$configuration = @(Get-Content -LiteralPath $configurationPath | ForEach-Object { $_.Trim() } |
  Where-Object { $_ -and -not $_.StartsWith('#') -and -not $_.StartsWith(';') })
$remoteRpc = @($configuration | Where-Object {
  ($_ -match '^rpcallowip=(.+)$' -and $Matches[1] -notmatch '^(127(?:\.[0-9]+){3}(?:/[0-9]+)?|::1)$') -or
  ($_ -match '^rpcbind=(.+)$' -and $Matches[1] -notmatch '^(127(?:\.[0-9]+){3}|::1)(?::[0-9]+)?$')
})
Add-Check 'loopback-rpc-configuration' ($remoteRpc.Count -eq 0) "nonLoopbackEntries=$($remoteRpc.Count)"

$chain = Invoke-BitcoinJson 'getblockchaininfo'
$network = Invoke-BitcoinJson 'getnetworkinfo'
$wallet = Invoke-BitcoinJson 'getwalletinfo' -Wallet
$synced = $chain.chain -eq 'testnet4' -and -not $chain.initialblockdownload -and $chain.blocks -eq $chain.headers
$connected = $network.networkactive -eq $true -and $network.connections -gt 0
$walletAtTip = $wallet.scanning -eq $false -and $null -ne $wallet.lastprocessedblock -and
  $wallet.lastprocessedblock.height -eq $chain.blocks -and
  $wallet.lastprocessedblock.hash -eq $chain.bestblockhash
$watchOnly = $wallet.private_keys_enabled -eq $false
Add-Check 'synced-testnet4-chain' $synced "height=$($chain.blocks); headers=$($chain.headers); ibd=$($chain.initialblockdownload)"
Add-Check 'active-peer-network' $connected "networkactive=$($network.networkactive); peers=$($network.connections)"
Add-Check 'wallet-at-stable-tip' $walletAtTip "scanning=$($wallet.scanning); lastProcessedHeight=$($wallet.lastprocessedblock.height)"
Add-Check 'watch-only-wallet' ($watchOnly -or $TrustedCoordinator) $(
  if ($watchOnly) { 'private keys are disabled' }
  elseif ($TrustedCoordinator) { 'private keys are enabled; trusted-coordinator override is active' }
  else { 'private keys are enabled; untrusted agents must use a watch-only wallet' }
)

$failed = @($checks | Where-Object { -not $_.passed })
$report = [ordered]@{
  schema = 'utxoref_bitcoin_testnet4_host_preflight_v1'
  capturedAt = [DateTime]::UtcNow.ToString('o')
  network = 'bitcoin-testnet4'
  mode = if ($TrustedCoordinator) { 'trusted-coordinator' } else { 'untrusted-agent' }
  safe = $failed.Count -eq 0
  currentSid = $currentSid
  agentSid = $agentSid
  checks = $checks
  failedChecks = @($failed | ForEach-Object { $_.name })
  signingUsed = $false
  broadcastAttempted = $false
}

if ($Json) {
  $report | ConvertTo-Json -Depth 6
} else {
  $report.checks | ForEach-Object { '{0} {1}: {2}' -f $(if ($_.passed) { 'PASS' } else { 'FAIL' }), $_.name, $_.detail }
  "safe=$($report.safe)"
}
if (-not $report.safe) { exit 1 }
