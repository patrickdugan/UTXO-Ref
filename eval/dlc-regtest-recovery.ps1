param(
  [string]$BitcoinBin = 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin',
  [string]$WorkingDirectoryBase = 'D:\bitagent-testnet4\dlc-regtest-recovery',
  [string]$SnapshotPath = 'D:\bitagent-testnet4\btc-test-snapshots\dlc-regtest-recovery-latest.json',
  [int]$RpcPort = 29443,
  [int]$P2pPort = 29444,
  [string]$RepositoryPath = $(Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$bitcoind = Join-Path $BitcoinBin 'bitcoind.exe'
$bitcoinCli = Join-Path $BitcoinBin 'bitcoin-cli.exe'
if (-not (Test-Path -LiteralPath $bitcoind -PathType Leaf) -or
    -not (Test-Path -LiteralPath $bitcoinCli -PathType Leaf)) {
  throw "Bitcoin Core binaries were not found in $BitcoinBin"
}
if ($RpcPort -lt 1024 -or $RpcPort -gt 65535 -or $P2pPort -lt 1024 -or $P2pPort -gt 65535 -or
    $RpcPort -eq $P2pPort) {
  throw 'RPC and P2P ports must be distinct unprivileged TCP ports'
}

$workingBase = [System.IO.Path]::GetFullPath($WorkingDirectoryBase)
$snapshotFile = [System.IO.Path]::GetFullPath($SnapshotPath)
if ([System.IO.Path]::GetPathRoot($workingBase) -ne 'D:\' -or
    [System.IO.Path]::GetPathRoot($snapshotFile) -ne 'D:\') {
  throw 'DLC regtest recovery artifacts must remain on D drive'
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
$walletName = "dlc-recovery-$runId"
$nodeProcess = $null
$nodeRunning = $false

function Invoke-BitcoinCli {
  param([string[]]$RpcArguments, [switch]$Wallet, [string]$WalletOverride = '')
  $prefix = @($script:nodeArguments)
  if ($WalletOverride) { $prefix += "-rpcwallet=$WalletOverride" }
  elseif ($Wallet) { $prefix += "-rpcwallet=$script:walletName" }
  $output = & $script:bitcoinCli @prefix @RpcArguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "bitcoin-cli $($RpcArguments[0]) failed: $($output -join [Environment]::NewLine)"
  }
  return ($output -join [Environment]::NewLine)
}

function Start-RegtestNode {
  param([switch]$ClearMempool, [decimal]$MinRelaySatsPerVb = 1)
  if ($MinRelaySatsPerVb -lt 1 -or $MinRelaySatsPerVb -gt 1000) {
    throw 'regtest minimum relay fee must be 1..1000 sat/vB'
  }
  $minRelayBtcPerKvb = ($MinRelaySatsPerVb * [decimal]0.00001000).ToString(
    '0.00000000',
    [Globalization.CultureInfo]::InvariantCulture
  )
  $arguments = @(
    '-regtest', "-datadir=$script:dataDirectory", '-server=1', "-rpcport=$script:RpcPort",
    "-port=$script:P2pPort", '-listen=0', '-discover=0', '-dnsseed=0',
    '-fallbackfee=0.00001000', "-minrelaytxfee=$minRelayBtcPerKvb", '-txindex=1', '-printtoconsole=0'
  )
  if ($ClearMempool) { $arguments += '-persistmempool=0' }
  $script:nodeProcess = Start-Process -FilePath $script:bitcoind -ArgumentList $arguments -WindowStyle Hidden -PassThru
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $script:nodeProcess.Refresh()
    if ($script:nodeProcess.HasExited) {
      throw "isolated DLC regtest node exited before RPC startup with code $($script:nodeProcess.ExitCode)"
    }
    & $script:bitcoinCli '-rpcclienttimeout=1' @script:nodeArguments getblockchaininfo 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $script:nodeRunning = $true
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'isolated DLC regtest node did not become ready'
}

function Stop-RegtestNode {
  if (-not $script:nodeRunning) { return }
  & $script:bitcoinCli @script:nodeArguments stop 2>$null | Out-Null
  if (-not $script:nodeProcess.WaitForExit(30000)) {
    throw 'isolated DLC regtest node did not stop cleanly'
  }
  $script:nodeRunning = $false
}

function ConvertFrom-JsonArray {
  param([string]$Json)
  if ($Json -match '^\s*\[\s*\]\s*$') {
    Write-Output -NoEnumerate @()
    return
  }
  return @(ConvertFrom-Json -InputObject $Json)
}

function Require-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

try {
  $safeRepository = $RepositoryPath -replace '\\', '/'
  $repositoryStatus = & git -c "safe.directory=$safeRepository" -C $RepositoryPath status --porcelain
  if ($LASTEXITCODE -ne 0 -or $repositoryStatus) { throw 'UTXORef repository must be clean for commit-pinned regtest evidence' }
  $repositoryCommit = (& git -c "safe.directory=$safeRepository" -C $RepositoryPath rev-parse HEAD).Trim()

  Start-RegtestNode
  $chainInfo = Invoke-BitcoinCli @('getblockchaininfo') | ConvertFrom-Json
  Require-Condition ($chainInfo.chain -eq 'regtest') 'Bitcoin Core did not start on regtest'
  $networkInfo = Invoke-BitcoinCli @('getnetworkinfo') | ConvertFrom-Json
  Invoke-BitcoinCli @('createwallet', $walletName) | Out-Null
  $miningAddress = Invoke-BitcoinCli @('getnewaddress', 'initial-mining', 'bech32m') -Wallet
  $burnWalletName = "maturity-mining-$runId"
  Invoke-BitcoinCli @('createwallet', $burnWalletName) | Out-Null
  $burnAddress = Invoke-BitcoinCli @('getnewaddress', 'maturity-mining', 'bech32m') -WalletOverride $burnWalletName
  Invoke-BitcoinCli @('unloadwallet', $walletName) | Out-Null
  Invoke-BitcoinCli @('unloadwallet', $burnWalletName) | Out-Null
  $fundingBlocks = ConvertFrom-JsonArray (Invoke-BitcoinCli @('generatetoaddress', '1', $miningAddress))
  $maturityBlocks = ConvertFrom-JsonArray (Invoke-BitcoinCli @('generatetoaddress', '100', $burnAddress))
  $initialBlocks = @($fundingBlocks) + @($maturityBlocks)
  Require-Condition ($initialBlocks.Count -eq 101) 'failed to mine the expected initial regtest blocks'
  Invoke-BitcoinCli @('loadwallet', $walletName) | Out-Null
  Require-Condition ([decimal](Invoke-BitcoinCli @('getbalance') -Wallet) -ge [decimal]50) 'mature regtest coinbase was not restored to the wallet'

  $anchorAddress = Invoke-BitcoinCli @('getnewaddress', 'dlc-anchor', 'bech32') -Wallet
  $parentOutputs = @(@{ $anchorAddress = '0.00000330' }) | ConvertTo-Json -Compress
  $parentOptions = @{ add_to_wallet = $true; replaceable = $false; change_position = 0 } | ConvertTo-Json -Compress
  $parentResult = Invoke-BitcoinCli @('-named', 'send', "outputs=$parentOutputs", 'fee_rate=1', "options=$parentOptions") -Wallet | ConvertFrom-Json
  $parentWalletTx = Invoke-BitcoinCli @('gettransaction', $parentResult.txid) -Wallet | ConvertFrom-Json
  $parentDecoded = Invoke-BitcoinCli @('decoderawtransaction', $parentWalletTx.hex) | ConvertFrom-Json
  $anchorOutputs = @($parentDecoded.vout | Where-Object { $_.scriptPubKey.address -eq $anchorAddress })
  Require-Condition ($anchorOutputs.Count -eq 1) 'parent transaction did not contain exactly one owned anchor'
  Require-Condition ([decimal]$anchorOutputs[0].value -eq [decimal]0.00000330) 'parent anchor was not exactly 330 sats'
  $anchorVout = [int]$anchorOutputs[0].n

  $recoveryAddress = Invoke-BitcoinCli @('getnewaddress', 'dlc-recovery', 'bech32') -Wallet
  $childOutputs = @(@{ $recoveryAddress = '0.01000000' }) | ConvertTo-Json -Compress
  $childOptions = @{
    add_to_wallet = $true
    add_inputs = $true
    include_unsafe = $true
    replaceable = $true
    change_position = 0
    inputs = @(@{ txid = $parentResult.txid; vout = $anchorVout; sequence = 4294967293 })
  } | ConvertTo-Json -Compress -Depth 5
  $lowChild = Invoke-BitcoinCli @('-named', 'send', "outputs=$childOutputs", 'fee_rate=2', "options=$childOptions") -Wallet | ConvertFrom-Json
  $lowChildHex = (Invoke-BitcoinCli @('gettransaction', $lowChild.txid) -Wallet | ConvertFrom-Json).hex
  $bumpOptions = @{ fee_rate = 20; replaceable = $true } | ConvertTo-Json -Compress
  $highChild = Invoke-BitcoinCli @('bumpfee', $lowChild.txid, $bumpOptions) -Wallet | ConvertFrom-Json
  $highChildHex = (Invoke-BitcoinCli @('gettransaction', $highChild.txid) -Wallet | ConvertFrom-Json).hex
  $pinOptions = @{ fee_rate = 200; replaceable = $false } | ConvertTo-Json -Compress
  $pinChild = Invoke-BitcoinCli @('bumpfee', $highChild.txid, $pinOptions) -Wallet | ConvertFrom-Json
  $pinChildHex = (Invoke-BitcoinCli @('gettransaction', $pinChild.txid) -Wallet | ConvertFrom-Json).hex
  $rescueOptions = @{ fee_rate = 300; replaceable = $true } | ConvertTo-Json -Compress
  $rescueChild = Invoke-BitcoinCli @('bumpfee', $pinChild.txid, $rescueOptions) -Wallet | ConvertFrom-Json
  $rescueChildHex = (Invoke-BitcoinCli @('gettransaction', $rescueChild.txid) -Wallet | ConvertFrom-Json).hex

  Stop-RegtestNode
  Start-RegtestNode -ClearMempool -MinRelaySatsPerVb 2
  $mempoolBefore = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($mempoolBefore.Count -eq 0) 'regtest mempool was not empty after the controlled restart'
  $parentOnlyJson = ConvertTo-Json -InputObject @($parentWalletTx.hex) -Compress
  $parentOnly = Invoke-BitcoinCli @('testmempoolaccept', $parentOnlyJson) | ConvertFrom-Json
  Require-Condition ($parentOnly[0].allowed -eq $false) 'low-fee parent unexpectedly passed the strict relay floor alone'
  Require-Condition ($parentOnly[0].'reject-reason' -eq 'min relay fee not met') 'parent failed for a reason other than the strict relay floor'
  $lowPackageJson = @($parentWalletTx.hex, $lowChildHex) | ConvertTo-Json -Compress
  $lowPackage = Invoke-BitcoinCli @('submitpackage', $lowPackageJson) | ConvertFrom-Json
  Require-Condition ($lowPackage.package_msg -eq 'success') 'parent plus low-fee child package was rejected'
  $highPackageJson = @($parentWalletTx.hex, $highChildHex) | ConvertTo-Json -Compress
  $highPackage = Invoke-BitcoinCli @('submitpackage', $highPackageJson) | ConvertFrom-Json
  Require-Condition ($highPackage.package_msg -eq 'success') 'higher-fee recovery package was rejected'
  Require-Condition (@($highPackage.'replaced-transactions') -contains $lowChild.txid) 'higher-fee child did not replace the low-fee child'
  $pinPackageJson = @($parentWalletTx.hex, $pinChildHex) | ConvertTo-Json -Compress
  $pinPackage = Invoke-BitcoinCli @('submitpackage', $pinPackageJson) | ConvertFrom-Json
  Require-Condition ($pinPackage.package_msg -eq 'success') 'fee-pin package was rejected'
  Require-Condition (@($pinPackage.'replaced-transactions') -contains $highChild.txid) 'fee-pin child did not replace the recovery child'
  $pinnedRecoveryRetry = Invoke-BitcoinCli @('submitpackage', $highPackageJson) | ConvertFrom-Json
  Require-Condition ($pinnedRecoveryRetry.package_msg -ne 'success') 'cheaper recovery unexpectedly displaced the fee pin'
  $mempoolWhilePinned = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($mempoolWhilePinned -contains $pinChild.txid) 'fee-pin child disappeared after the cheaper recovery attempt'
  Require-Condition (-not ($mempoolWhilePinned -contains $highChild.txid)) 'cheaper recovery entered the mempool despite the fee pin'
  $rescuePackageJson = @($parentWalletTx.hex, $rescueChildHex) | ConvertTo-Json -Compress
  $rescuePackage = Invoke-BitcoinCli @('submitpackage', $rescuePackageJson) | ConvertFrom-Json
  Require-Condition ($rescuePackage.package_msg -eq 'success') 'fee-pin rescue package was rejected'
  Require-Condition (@($rescuePackage.'replaced-transactions') -contains $pinChild.txid) 'fee-pin rescue did not replace the pin child'
  $mempoolAfterReplacement = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($mempoolAfterReplacement -contains $parentResult.txid) 'parent was absent after package recovery'
  Require-Condition ($mempoolAfterReplacement -contains $rescueChild.txid) 'fee-pin rescue child was absent after replacement'
  Require-Condition (-not ($mempoolAfterReplacement -contains $lowChild.txid)) 'low-fee child remained after replacement'

  Invoke-BitcoinCli @('loadwallet', $walletName) | Out-Null
  $reorgMiningAddress = Invoke-BitcoinCli @('getnewaddress', 'reorg-mining', 'bech32m') -Wallet
  Invoke-BitcoinCli @('unloadwallet', $walletName) | Out-Null
  $reorgBlocks = ConvertFrom-JsonArray (Invoke-BitcoinCli @('generatetoaddress', '6', $reorgMiningAddress))
  Require-Condition ($reorgBlocks.Count -eq 6) 'failed to mine the six-block reorg branch'
  $heightBeforeInvalidation = [int](Invoke-BitcoinCli @('getblockcount'))
  Invoke-BitcoinCli @('invalidateblock', $reorgBlocks[0]) | Out-Null
  $heightAfterInvalidation = [int](Invoke-BitcoinCli @('getblockcount'))
  $mempoolAfterInvalidation = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($heightAfterInvalidation -eq $heightBeforeInvalidation - 6) 'six-block invalidation did not regress the expected depth'
  Require-Condition ($mempoolAfterInvalidation -contains $parentResult.txid) 'parent was not recovered to mempool after invalidation'
  Require-Condition ($mempoolAfterInvalidation -contains $rescueChild.txid) 'child was not recovered to mempool after invalidation'
  Invoke-BitcoinCli @('reconsiderblock', $reorgBlocks[0]) | Out-Null
  $heightAfterReconsider = [int](Invoke-BitcoinCli @('getblockcount'))
  $mempoolAfterReconsider = ConvertFrom-JsonArray (Invoke-BitcoinCli @('getrawmempool'))
  Require-Condition ($heightAfterReconsider -eq $heightBeforeInvalidation) 'reconsiderblock did not restore the six-block branch'
  Require-Condition ($mempoolAfterReconsider.Count -eq 0) 'confirmed package remained in mempool after branch restoration'

  $snapshot = [ordered]@{
    schema = 'utxoref_dlc_regtest_recovery_v1'
    capturedAt = [DateTime]::UtcNow.ToString('o')
    effect = 'isolated_regtest_only'
    network = 'bitcoin-regtest'
    bitcoinCore = [ordered]@{ version = $networkInfo.version; subversion = $networkInfo.subversion }
    repository = $RepositoryPath
    commit = $repositoryCommit
    runDirectory = $runDirectory
    ports = [ordered]@{ rpc = $RpcPort; p2p = $P2pPort }
    anchor = [ordered]@{ txid = $parentResult.txid; vout = $anchorVout; amountSats = 330; address = $anchorAddress }
    package = [ordered]@{
      strictRelayFloorSatsPerVb = 2
      parentStandaloneAllowed = $parentOnly[0].allowed
      parentStandaloneReject = $parentOnly[0].'reject-reason'
      lowChildTxid = $lowChild.txid
      highChildTxid = $highChild.txid
      pinChildTxid = $pinChild.txid
      rescueChildTxid = $rescueChild.txid
      lowPackageMessage = $lowPackage.package_msg
      highPackageMessage = $highPackage.package_msg
      pinPackageMessage = $pinPackage.package_msg
      pinnedRecoveryRetryMessage = $pinnedRecoveryRetry.package_msg
      rescuePackageMessage = $rescuePackage.package_msg
      highReplacedTransactions = @($highPackage.'replaced-transactions')
      pinReplacedTransactions = @($pinPackage.'replaced-transactions')
      rescueReplacedTransactions = @($rescuePackage.'replaced-transactions')
      originalFeeBtc = $highChild.origfee
      replacementFeeBtc = $highChild.fee
      pinFeeBtc = $pinChild.fee
      rescueFeeBtc = $rescueChild.fee
    }
    reorg = [ordered]@{
      depth = 6
      firstInvalidatedBlock = $reorgBlocks[0]
      previousTip = $reorgBlocks[-1]
      heightBefore = $heightBeforeInvalidation
      heightAfterInvalidation = $heightAfterInvalidation
      recoveredMempool = $mempoolAfterInvalidation
      heightAfterReconsider = $heightAfterReconsider
      mempoolAfterReconsider = $mempoolAfterReconsider
    }
    assertions = [ordered]@{
      exactOwnedAnchor = $true
      packageFeeRescuedParentBelowRelayFloor = $true
      packageAccepted = $true
      rbfRecoveryAccepted = $true
      cheaperRecoveryBlockedByFeePin = $true
      higherFeeRecoveryDisplacedPin = $true
      sixBlockDisconnectRecoveredPackage = $true
      branchRestorationClearedMempool = $true
    }
    passed = $true
  }
  $snapshotDirectory = Split-Path -Parent $snapshotFile
  New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
  [System.IO.File]::WriteAllText(
    $snapshotFile,
    (($snapshot | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Output "passed=true"
  Write-Output "snapshot=$snapshotFile"
} finally {
  Stop-RegtestNode
}
