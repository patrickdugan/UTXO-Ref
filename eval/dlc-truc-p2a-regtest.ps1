param(
  [string]$BitcoinBin = 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin',
  [string]$WorkingDirectoryBase = 'D:\bitagent-testnet4\dlc-truc-p2a-regtest',
  [string]$SnapshotPath = 'D:\bitagent-testnet4\btc-test-snapshots\dlc-truc-p2a-regtest-latest.json',
  [int]$RpcPort = 29543,
  [int]$P2pPort = 29544,
  [string]$RepositoryPath = $(Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$bitcoind = Join-Path $BitcoinBin 'bitcoind.exe'
$bitcoinCli = Join-Path $BitcoinBin 'bitcoin-cli.exe'
$bitcoinTx = Join-Path $BitcoinBin 'bitcoin-tx.exe'
foreach ($binary in @($bitcoind, $bitcoinCli, $bitcoinTx)) {
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Bitcoin Core binary was not found: $binary" }
}
if ($RpcPort -lt 1024 -or $RpcPort -gt 65535 -or $P2pPort -lt 1024 -or $P2pPort -gt 65535 -or $RpcPort -eq $P2pPort) {
  throw 'RPC and P2P ports must be distinct unprivileged TCP ports'
}

$workingBase = [System.IO.Path]::GetFullPath($WorkingDirectoryBase)
$snapshotFile = [System.IO.Path]::GetFullPath($SnapshotPath)
if ([System.IO.Path]::GetPathRoot($workingBase) -ne 'D:\' -or [System.IO.Path]::GetPathRoot($snapshotFile) -ne 'D:\') {
  throw 'TRUC/P2A regtest artifacts must remain on D drive'
}
$runId = "{0}-{1}-{2}" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), $PID, ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$runDirectory = Join-Path $workingBase $runId
$dataDirectory = Join-Path $runDirectory 'data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$dataDirectory = (Resolve-Path -LiteralPath $dataDirectory).Path
if (-not $dataDirectory.StartsWith($workingBase + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'resolved regtest data directory escaped its configured D-drive base'
}

$nodeArguments = @('-regtest', "-datadir=$dataDirectory", "-rpcport=$RpcPort")
$walletName = "dlc-truc-p2a-$runId"
$burnWalletName = "dlc-truc-p2a-burn-$runId"
$nodeProcess = $null
$nodeRunning = $false

function Invoke-BitcoinCli {
  param([string[]]$RpcArguments, [switch]$Wallet, [string]$WalletOverride = '')
  $prefix = @($script:nodeArguments)
  if ($WalletOverride) { $prefix += "-rpcwallet=$WalletOverride" }
  elseif ($Wallet) { $prefix += "-rpcwallet=$script:walletName" }
  $output = & $script:bitcoinCli @prefix @RpcArguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "bitcoin-cli $($RpcArguments[0]) failed: $($output -join [Environment]::NewLine)" }
  return ($output -join [Environment]::NewLine)
}

function Invoke-BitcoinTx {
  param([string[]]$Arguments)
  $output = & $script:bitcoinTx '-chain=regtest' @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "bitcoin-tx failed: $($output -join [Environment]::NewLine)" }
  return ($output -join [Environment]::NewLine).Trim()
}

function ConvertFrom-JsonArray {
  param([string]$Json)
  if ($Json -match '^\s*\[\s*\]\s*$') { Write-Output -NoEnumerate @(); return }
  return @(ConvertFrom-Json -InputObject $Json)
}

function Require-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Stop-RegtestNode {
  if (-not $script:nodeRunning) { return }
  & $script:bitcoinCli @script:nodeArguments stop 2>$null | Out-Null
  if (-not $script:nodeProcess.WaitForExit(30000)) { throw 'isolated TRUC/P2A regtest node did not stop cleanly' }
  $script:nodeRunning = $false
}

try {
  $safeRepository = $RepositoryPath -replace '\\', '/'
  $repositoryStatus = & git -c "safe.directory=$safeRepository" -C $RepositoryPath status --porcelain
  if ($LASTEXITCODE -ne 0 -or $repositoryStatus) { throw 'UTXORef repository must be clean for commit-pinned TRUC/P2A evidence' }
  $repositoryCommit = (& git -c "safe.directory=$safeRepository" -C $RepositoryPath rev-parse HEAD).Trim()

  $arguments = @(
    '-regtest', "-datadir=$dataDirectory", '-server=1', "-rpcport=$RpcPort",
    "-port=$P2pPort", '-listen=1', "-bind=127.0.0.1:$P2pPort", '-listenonion=0', '-discover=0', '-dnsseed=0',
    '-fallbackfee=0.00001000', '-minrelaytxfee=0.00001000', '-txindex=1', '-persistmempool=0', '-printtoconsole=0'
  )
  $nodeProcess = Start-Process -FilePath $bitcoind -ArgumentList $arguments -WindowStyle Hidden -PassThru
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $nodeProcess.Refresh()
    if ($nodeProcess.HasExited) { throw "isolated TRUC/P2A regtest node exited with code $($nodeProcess.ExitCode)" }
    & $bitcoinCli '-rpcclienttimeout=1' @nodeArguments getblockchaininfo 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $nodeRunning = $true; break }
    Start-Sleep -Milliseconds 250
  }
  Require-Condition $nodeRunning 'isolated TRUC/P2A regtest node did not become ready'

  $networkInfo = Invoke-BitcoinCli @('getnetworkinfo') | ConvertFrom-Json
  Invoke-BitcoinCli @('createwallet', $walletName) | Out-Null
  Invoke-BitcoinCli @('createwallet', $burnWalletName) | Out-Null
  $fundingAddresses = 1..3 | ForEach-Object { Invoke-BitcoinCli @('getnewaddress', "funding-$_", 'bech32m') -Wallet }
  $burnAddress = Invoke-BitcoinCli @('getnewaddress', 'maturity', 'bech32m') -WalletOverride $burnWalletName
  foreach ($address in $fundingAddresses) { Invoke-BitcoinCli @('generatetoaddress', '1', $address) | Out-Null }
  Invoke-BitcoinCli @('unloadwallet', $walletName) | Out-Null
  Invoke-BitcoinCli @('unloadwallet', $burnWalletName) | Out-Null
  Invoke-BitcoinCli @('generatetoaddress', '100', $burnAddress) | Out-Null
  Invoke-BitcoinCli @('loadwallet', $walletName) | Out-Null
  $coins = @(Invoke-BitcoinCli @('listunspent', '101', '9999999') -Wallet | ConvertFrom-Json | Where-Object { $_.amount -eq 50 } | Sort-Object confirmations -Descending)
  Require-Condition ($coins.Count -ge 3) 'wallet did not expose three mature 50-BTC regtest inputs'

  $payoutAddress = Invoke-BitcoinCli @('getnewaddress', 'settlement-payout', 'bech32m') -Wallet
  $parentUnsigned = Invoke-BitcoinTx @(
    '-create', 'nversion=3', "in=$($coins[0].txid):$($coins[0].vout):4294967293",
    "outaddr=50.00000000:$payoutAddress", 'outscript=0:0x51024e73'
  )
  $parentSigned = Invoke-BitcoinCli @('signrawtransactionwithwallet', $parentUnsigned) -Wallet | ConvertFrom-Json
  Require-Condition $parentSigned.complete 'wallet did not complete the version-3 parent'
  $parent = Invoke-BitcoinCli @('decoderawtransaction', $parentSigned.hex) | ConvertFrom-Json
  $anchors = @($parent.vout | Where-Object { $_.scriptPubKey.hex -eq '51024e73' -and [decimal]$_.value -eq 0 })
  Require-Condition ($parent.version -eq 3 -and $anchors.Count -eq 1 -and $anchors[0].n -eq $parent.vout.Count - 1) 'parent did not commit version 3 and one final zero-sat P2A anchor'
  Require-Condition ($anchors[0].scriptPubKey.type -eq 'anchor') 'Core did not decode 51024e73 as an anchor output'
  $anchorVout = [int]$anchors[0].n

  function New-RecoveryChild {
    param([object]$Coin, [string]$Address, [string]$OutputAmount)
    $unsigned = Invoke-BitcoinTx @(
      '-create', 'nversion=3', "in=$($parent.txid):$($anchorVout):4294967293",
      "in=$($Coin.txid):$($Coin.vout):4294967293", "outaddr=$OutputAmount`:$Address"
    )
    $p2aPrevout = ConvertTo-Json -InputObject @(@{
      txid = $parent.txid
      vout = $anchorVout
      scriptPubKey = '51024e73'
      amount = 0
    }) -Compress
    $walletSigned = Invoke-BitcoinCli @('signrawtransactionwithwallet', $unsigned, $p2aPrevout) -Wallet | ConvertFrom-Json
    $keylessComplete = Invoke-BitcoinCli @('signrawtransactionwithkey', $walletSigned.hex, '[]', $p2aPrevout) | ConvertFrom-Json
    Require-Condition $keylessComplete.complete 'Core did not recognize the wallet-signed transaction plus keyless P2A input as complete'
    return [ordered]@{
      hex = $keylessComplete.hex
      decoded = (Invoke-BitcoinCli @('decoderawtransaction', $keylessComplete.hex) | ConvertFrom-Json)
    }
  }

  $firstAddress = Invoke-BitcoinCli @('getnewaddress', 'recovery-first', 'bech32m') -Wallet
  $replacementAddress = Invoke-BitcoinCli @('getnewaddress', 'recovery-replacement', 'bech32m') -Wallet
  $firstChild = New-RecoveryChild $coins[1] $firstAddress '49.99998000'
  $replacementChild = New-RecoveryChild $coins[2] $replacementAddress '49.99995000'
  Require-Condition ($firstChild.decoded.version -eq 3 -and $replacementChild.decoded.version -eq 3) 'recovery child was not version 3'
  Require-Condition ($firstChild.decoded.vsize -le 1000 -and $replacementChild.decoded.vsize -le 1000) 'recovery child exceeded the TRUC 1000-vB child limit'

  $parentOnlyJson = ConvertTo-Json -InputObject @($parentSigned.hex) -Compress
  $parentOnly = Invoke-BitcoinCli @('testmempoolaccept', $parentOnlyJson) | ConvertFrom-Json
  Require-Condition (-not $parentOnly[0].allowed) 'zero-fee P2A parent unexpectedly entered the mempool alone'
  Require-Condition ($parentOnly[0].'reject-reason' -eq 'min relay fee not met') 'zero-fee P2A parent failed for a reason other than the relay floor'

  $firstPackageJson = ConvertTo-Json -InputObject @($parentSigned.hex, $firstChild.hex) -Compress
  $firstPackage = Invoke-BitcoinCli @('submitpackage', $firstPackageJson) | ConvertFrom-Json
  Require-Condition ($firstPackage.package_msg -eq 'success') 'version-3 parent/P2A child package was rejected'
  $clusterBefore = Invoke-BitcoinCli @('getmempoolcluster', $parent.txid) | ConvertFrom-Json
  $mempoolBefore = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($mempoolBefore -contains $parent.txid -and $mempoolBefore -contains $firstChild.decoded.txid) 'initial TRUC cluster was incomplete'

  $replacementPolicyJson = ConvertTo-Json -InputObject @($replacementChild.hex) -Compress
  $replacementPolicy = Invoke-BitcoinCli @('testmempoolaccept', $replacementPolicyJson, '0') | ConvertFrom-Json
  Require-Condition ($replacementPolicy.Count -eq 1 -and $replacementPolicy[0].allowed -eq $true -and
    $replacementPolicy[0].txid -eq $replacementChild.decoded.txid) 'Core policy probe did not authorize the higher-fee TRUC sibling'
  $replacementTxid = Invoke-BitcoinCli @('sendrawtransaction', $replacementChild.hex)
  Require-Condition ($replacementTxid -eq $replacementChild.decoded.txid) 'Core returned an unexpected replacement child txid'
  $mempoolAfter = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($mempoolAfter -contains $parent.txid -and $mempoolAfter -contains $replacementChild.decoded.txid) 'replacement TRUC cluster was incomplete'
  Require-Condition (-not ($mempoolAfter -contains $firstChild.decoded.txid)) 'TRUC sibling eviction did not remove the first child'
  $clusterAfter = Invoke-BitcoinCli @('getmempoolcluster', $parent.txid) | ConvertFrom-Json

  $grandchildAddress = Invoke-BitcoinCli @('getnewaddress', 'forbidden-grandchild', 'bech32m') -Wallet
  $grandchildUnsigned = Invoke-BitcoinTx @(
    '-create', 'nversion=3', "in=$($replacementChild.decoded.txid):0:4294967293", "outaddr=49.99994000:$grandchildAddress"
  )
  $grandchildSigned = Invoke-BitcoinCli @('signrawtransactionwithwallet', $grandchildUnsigned) -Wallet | ConvertFrom-Json
  Require-Condition $grandchildSigned.complete 'wallet did not complete the cluster-limit probe transaction'
  $grandchildTestJson = ConvertTo-Json -InputObject @($grandchildSigned.hex) -Compress
  $grandchildTest = Invoke-BitcoinCli @('testmempoolaccept', $grandchildTestJson) | ConvertFrom-Json
  Require-Condition (-not $grandchildTest[0].allowed -and $grandchildTest[0].'reject-reason' -eq 'TRUC-violation') 'third unconfirmed TRUC transaction was not rejected by the cluster limit'

  $mempoolInfo = Invoke-BitcoinCli @('getmempoolinfo') | ConvertFrom-Json
  $parentEntry = Invoke-BitcoinCli @('getmempoolentry', $parent.txid) | ConvertFrom-Json
  $childEntry = Invoke-BitcoinCli @('getmempoolentry', $replacementChild.decoded.txid) | ConvertFrom-Json
  $feeDiagram = Invoke-BitcoinCli @('getmempoolfeeratediagram') | ConvertFrom-Json
  $snapshot = [ordered]@{
    schema = 'utxoref_dlc_truc_p2a_regtest_v1'
    capturedAt = [DateTime]::UtcNow.ToString('o')
    effect = 'isolated_regtest_only'
    network = 'bitcoin-regtest'
    bitcoinCore = [ordered]@{ version = $networkInfo.version; subversion = $networkInfo.subversion }
    repository = $RepositoryPath
    commit = $repositoryCommit
    runDirectory = $runDirectory
    ports = [ordered]@{ rpc = $RpcPort; p2p = $P2pPort }
    policy = [ordered]@{
      transactionVersion = 3
      p2aScriptPubKeyHex = '51024e73'
      anchorAmountSats = 0
      maxUnconfirmedClusterTransactions = 2
      maxSettlementVsize = 10000
      maxRecoveryVsize = 1000
      fullRbf = $mempoolInfo.fullrbf
      incrementalRelayFeeBtcPerKvB = $mempoolInfo.incrementalrelayfee
    }
    parent = [ordered]@{ txid = $parent.txid; vsize = $parent.vsize; anchorVout = $anchorVout; standaloneReject = $parentOnly[0].'reject-reason' }
    firstChild = [ordered]@{ txid = $firstChild.decoded.txid; vsize = $firstChild.decoded.vsize }
    replacementChild = [ordered]@{ txid = $replacementChild.decoded.txid; vsize = $replacementChild.decoded.vsize }
    cluster = [ordered]@{
      beforeSiblingEviction = $clusterBefore
      afterSiblingEviction = $clusterAfter
      finalMempool = $mempoolAfter
      parentEntry = $parentEntry
      replacementChildEntry = $childEntry
      replacementTestMempoolAccept = $replacementPolicy[0]
      feerateDiagram = $feeDiagram
      thirdTransactionReject = $grandchildTest[0].'reject-reason'
    }
    assertions = [ordered]@{
      coreDecodedP2aAnchor = $true
      zeroFeeParentRequiredPackageRelay = $true
      parentChildPackageAccepted = $true
      recoveryChildrenUnder1000Vb = $true
      higherFeeSiblingEvictedFirstChild = $true
      directCorePolicyAcceptedReplacement = $true
      unconfirmedClusterLimitedToTwoTransactions = $true
      coreClusterAndFeerateDiagramCaptured = $true
    }
    passed = $true
  }
  $snapshotDirectory = Split-Path -Parent $snapshotFile
  New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
  [System.IO.File]::WriteAllText($snapshotFile, (($snapshot | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Write-Output 'passed=true'
  Write-Output "snapshot=$snapshotFile"
} finally {
  Stop-RegtestNode
}
