param(
  [string]$SourceWallet = 'utxoref-testnet',
  [string]$TargetWallet = 'utxoref-swarm-watchonly',
  [string]$DataDirectory = 'D:\BitcoinTestnet',
  [string]$BitcoinCli = 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin\bitcoin-cli.exe',
  [string]$SnapshotDirectory = 'D:\bitagent-testnet4\btc-test-snapshots',
  [ValidateRange(600, 86400)][int]$LookbackSeconds = 7200,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($SourceWallet -notmatch '^[A-Za-z0-9._-]{1,64}$' -or
    $TargetWallet -notmatch '^[A-Za-z0-9._-]{1,64}$' -or
    $SourceWallet -eq $TargetWallet) {
  throw 'source and target wallet names must be distinct bounded identifiers'
}
if (-not (Test-Path -LiteralPath $BitcoinCli -PathType Leaf) -or
    -not [System.IO.Path]::IsPathFullyQualified($DataDirectory) -or
    -not [System.IO.Path]::IsPathFullyQualified($SnapshotDirectory)) {
  throw 'watch-only wallet paths must be existing or fully qualified'
}

function Invoke-BitcoinJson {
  param([string]$Method, [string[]]$Parameters = @(), [string]$Wallet = '')
  $arguments = @("-datadir=$DataDirectory", '-chain=testnet4', '-rpcclienttimeout=600')
  if ($Wallet) { $arguments += "-rpcwallet=$Wallet" }
  $arguments += $Method
  $arguments += $Parameters
  $output = & $BitcoinCli @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "bitcoin-cli $Method failed" }
  return (($output -join "`n") | ConvertFrom-Json)
}

function Get-UtxoSummary {
  param([string]$Wallet)
  $values = @(Invoke-BitcoinJson -Method 'listunspent' -Parameters @('1', '9999999') -Wallet $Wallet)
  return @($values | Sort-Object txid, vout | ForEach-Object {
    [ordered]@{
      outpoint = "$($_.txid):$($_.vout)"
      amount = ([decimal]$_.amount).ToString('0.00000000', [System.Globalization.CultureInfo]::InvariantCulture)
      scriptPubKey = $_.scriptPubKey
      confirmations = [int64]$_.confirmations
    }
  })
}

function Get-Sha256 {
  param([string]$Text)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  try {
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

$chain = Invoke-BitcoinJson 'getblockchaininfo'
if ($chain.chain -ne 'testnet4' -or $chain.initialblockdownload -or $chain.blocks -ne $chain.headers) {
  throw 'watch-only wallet provisioning requires a fully synced testnet4 node'
}
$sourceInfo = Invoke-BitcoinJson -Method 'getwalletinfo' -Wallet $SourceWallet
if ($sourceInfo.descriptors -ne $true -or $sourceInfo.scanning -ne $false) {
  throw 'source descriptor wallet must be loaded and idle'
}
$sourceUtxos = Get-UtxoSummary $SourceWallet
if ($sourceUtxos.Count -lt 1) { throw 'source wallet has no confirmed UTXOs to verify after import' }

$oldestTime = [int64]::MaxValue
foreach ($txid in @($sourceUtxos.outpoint | ForEach-Object { $_.Split(':')[0] } | Select-Object -Unique)) {
  $transaction = Invoke-BitcoinJson -Method 'gettransaction' -Parameters @($txid) -Wallet $SourceWallet
  if ($transaction.confirmations -lt 1 -or $null -eq $transaction.blocktime) {
    throw 'source wallet UTXO is not anchored to a confirmed transaction'
  }
  $oldestTime = [Math]::Min($oldestTime, [int64]$transaction.blocktime)
}
$scanTimestamp = [Math]::Max(1, $oldestTime - $LookbackSeconds)
$descriptorSet = Invoke-BitcoinJson -Method 'listdescriptors' -Parameters @('false') -Wallet $SourceWallet
$descriptors = @($descriptorSet.descriptors)
if ($descriptors.Count -lt 1 -or $descriptors.Count -gt 64 -or
    @($descriptors | Where-Object { $_.desc -match '(?i)(?:xprv|tprv|yprv|zprv)' }).Count -ne 0) {
  throw 'source public descriptor set is empty, oversized, or contains private extended keys'
}

$loaded = @((Invoke-BitcoinJson 'listwallets'))
$walletDirectoryResult = Invoke-BitcoinJson 'listwalletdir'
$walletDirectory = @($walletDirectoryResult.wallets | ForEach-Object { $_.name })
$targetExists = $TargetWallet -in $walletDirectory
if (-not $Apply) {
  [ordered]@{
    schema = 'utxoref_testnet4_watchonly_wallet_plan_v1'
    mode = 'plan'
    network = 'bitcoin-testnet4'
    sourceWallet = $SourceWallet
    targetWallet = $TargetWallet
    targetExists = $targetExists
    targetLoaded = $TargetWallet -in $loaded
    publicDescriptorCount = $descriptors.Count
    privateDescriptorsAccepted = $false
    sourcePrivateKeysEnabled = [bool]$sourceInfo.private_keys_enabled
    sourceConfirmedUtxos = $sourceUtxos.Count
    scanTimestamp = $scanTimestamp
    mutationPerformed = $false
    signingUsed = $false
    broadcastAttempted = $false
  } | ConvertTo-Json -Depth 4
  exit 0
}

$created = $false
if (-not $targetExists) {
  [void](Invoke-BitcoinJson 'createwallet' @($TargetWallet, 'true', 'true', '', 'false', 'true', 'false', 'false'))
  $created = $true
} elseif ($TargetWallet -notin $loaded) {
  [void](Invoke-BitcoinJson 'loadwallet' @($TargetWallet))
}
$targetInfo = Invoke-BitcoinJson -Method 'getwalletinfo' -Wallet $TargetWallet
if ($targetInfo.private_keys_enabled -ne $false -or $targetInfo.descriptors -ne $true) {
  throw 'target wallet is not a private-key-disabled descriptor wallet'
}

$targetDescriptorSet = Invoke-BitcoinJson -Method 'listdescriptors' -Parameters @('false') -Wallet $TargetWallet
$targetDescriptors = @($targetDescriptorSet.descriptors)
if (@($targetDescriptors | Where-Object { $_.desc -match '(?i)(?:xprv|tprv|yprv|zprv)' }).Count -ne 0) {
  throw 'target wallet unexpectedly exposes a private extended-key descriptor'
}
$sourceDescriptorNames = @($descriptors | ForEach-Object { $_.desc })
$targetDescriptorNames = @($targetDescriptors | ForEach-Object { $_.desc })
if (@($targetDescriptorNames | Where-Object { $_ -notin $sourceDescriptorNames }).Count -ne 0) {
  throw 'target wallet contains a descriptor outside the source public descriptor set'
}
$missingDescriptors = @($descriptors | Where-Object { $_.desc -notin $targetDescriptorNames })
$imports = @($missingDescriptors | ForEach-Object {
  $entry = [ordered]@{
    desc = $_.desc
    timestamp = $scanTimestamp
    active = [bool]$_.active
    internal = [bool]$_.internal
  }
  if ($null -ne $_.range) { $entry['range'] = @([int64]$_.range[0], [int64]$_.range[1]) }
  if ($null -ne $_.next) { $entry['next_index'] = [int64]$_.next }
  $entry
})
$importResult = @()
if ($imports.Count -gt 0) {
  $importJson = $imports | ConvertTo-Json -Depth 5 -Compress
  try {
    $importResult = @(Invoke-BitcoinJson -Method 'importdescriptors' -Parameters @($importJson) -Wallet $TargetWallet)
  } finally {
    $importJson = $null
  }
}
if ($importResult.Count -ne $missingDescriptors.Count -or
    @($importResult | Where-Object { $_.success -ne $true }).Count -ne 0) {
  throw 'one or more public descriptor imports failed'
}
$targetDescriptorSet = Invoke-BitcoinJson -Method 'listdescriptors' -Parameters @('false') -Wallet $TargetWallet
$targetDescriptorNames = @($targetDescriptorSet.descriptors | ForEach-Object { $_.desc })
if ($targetDescriptorNames.Count -ne $sourceDescriptorNames.Count -or
    @($sourceDescriptorNames | Where-Object { $_ -notin $targetDescriptorNames }).Count -ne 0) {
  throw 'target wallet public descriptor set does not match the source wallet'
}
$targetInfo = Invoke-BitcoinJson -Method 'getwalletinfo' -Wallet $TargetWallet
if ($targetInfo.private_keys_enabled -ne $false -or $targetInfo.scanning -ne $false) {
  throw 'watch-only wallet did not finish as a private-key-disabled wallet'
}

$stableTip = $null
$targetUtxos = @()
$sourceCanonical = $null
$targetCanonical = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $tipBefore = (Invoke-BitcoinJson 'getblockchaininfo').bestblockhash
  $sourceUtxos = Get-UtxoSummary $SourceWallet
  $targetUtxos = Get-UtxoSummary $TargetWallet
  $tipAfter = (Invoke-BitcoinJson 'getblockchaininfo').bestblockhash
  $targetInfo = Invoke-BitcoinJson -Method 'getwalletinfo' -Wallet $TargetWallet
  if ($tipBefore -eq $tipAfter -and $targetInfo.lastprocessedblock.hash -eq $tipAfter) {
    $stableTip = $tipAfter
    $sourceCanonical = $sourceUtxos | ConvertTo-Json -Depth 4 -Compress
    $targetCanonical = $targetUtxos | ConvertTo-Json -Depth 4 -Compress
    break
  }
}
if (-not $stableTip) {
  throw 'could not capture both wallets at one stable processed testnet4 tip'
}
if ($sourceCanonical -cne $targetCanonical) {
  throw 'watch-only wallet UTXO set differs from the source wallet at the stable tip'
}

$report = [ordered]@{
  schema = 'utxoref_testnet4_watchonly_wallet_evidence_v1'
  capturedAt = [DateTime]::UtcNow.ToString('o')
  network = 'bitcoin-testnet4'
  sourceWallet = $SourceWallet
  targetWallet = $TargetWallet
  targetCreated = $created
  stableTip = $stableTip
  descriptorCount = $sourceDescriptorNames.Count
  descriptorsImportedThisRun = $importResult.Count
  scanTimestamp = $scanTimestamp
  privateKeysEnabled = $false
  sourceWalletModified = $false
  sourceConfirmedUtxos = $sourceUtxos.Count
  targetConfirmedUtxos = $targetUtxos.Count
  utxoSetSha256 = Get-Sha256 $sourceCanonical
  exactUtxoSetMatch = $true
  signingUsed = $false
  broadcastAttempted = $false
}
[System.IO.Directory]::CreateDirectory($SnapshotDirectory) | Out-Null
$snapshotPath = Join-Path $SnapshotDirectory 'watchonly-wallet-latest.json'
[System.IO.File]::WriteAllText(
  $snapshotPath,
  ($report | ConvertTo-Json -Depth 5),
  [System.Text.UTF8Encoding]::new($false)
)
$imports = $null
$missingDescriptors = $null
$targetDescriptors = $null
$targetDescriptorSet = $null
$targetDescriptorNames = $null
$sourceDescriptorNames = $null
$descriptors = $null
$descriptorSet = $null
$report | ConvertTo-Json -Depth 5
