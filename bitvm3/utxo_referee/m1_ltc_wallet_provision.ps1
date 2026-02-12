param(
  [string]$RpcUrl = "http://127.0.0.1:19332",
  [string]$RpcUser = "user",
  [string]$RpcPass = "pass",
  [string]$SourceWallet = "tl",
  [string]$DestinationWallet = "tl-wallet",
  [string]$Tag = "",
  [double]$OperatorLtc = 0.00500000,
  [double]$OracleLtc = 0.00300000,
  [double]$AliceLtc = 0.00400000,
  [double]$BobLtc = 0.00400000,
  [double]$ResidualLtc = 0.00500000,
  [switch]$CreateOnly
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Tag)) {
  $Tag = "m1-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}

$auth = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$RpcUser`:$RpcPass"))

function Invoke-LtcRpc {
  param(
    [string]$Wallet,
    [string]$Method,
    [object[]]$Params = @()
  )

  if ([string]::IsNullOrEmpty($Wallet)) {
    $uri = "$RpcUrl/"
  } else {
    $uri = "$RpcUrl/wallet/$([uri]::EscapeDataString($Wallet))"
  }

  $body = @{
    jsonrpc = "1.0"
    id = "m1-provision"
    method = $Method
    params = $Params
  } | ConvertTo-Json -Compress -Depth 20

  $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = $auth } -Body $body -ContentType "application/json"
  if ($null -ne $resp.error) {
    throw "RPC $Method failed: $($resp.error.message)"
  }
  return $resp.result
}

$roles = @("operator", "oracle", "alice", "bob", "residual")
$addresses = @{}

foreach ($role in $roles) {
  $label = "$Tag-$role"
  $addr = Invoke-LtcRpc -Wallet $DestinationWallet -Method "getnewaddress" -Params @($label, "bech32")
  $addresses[$role] = $addr
}

$amounts = @{}
$amounts[$addresses["operator"]] = $OperatorLtc
$amounts[$addresses["oracle"]] = $OracleLtc
$amounts[$addresses["alice"]] = $AliceLtc
$amounts[$addresses["bob"]] = $BobLtc
$amounts[$addresses["residual"]] = $ResidualLtc

$srcBalances = Invoke-LtcRpc -Wallet $SourceWallet -Method "getbalances"
$required = [decimal]($OperatorLtc + $OracleLtc + $AliceLtc + $BobLtc + $ResidualLtc)
$available = [decimal]$srcBalances.mine.trusted

$txid = $null
$txConfirmations = $null

if (-not $CreateOnly) {
  if ($available -lt $required) {
    throw "Insufficient trusted balance in source wallet '$SourceWallet': required=$required LTC, available=$available LTC. Use -CreateOnly or lower funding amounts."
  }

  $txid = Invoke-LtcRpc -Wallet $SourceWallet -Method "sendmany" -Params @("", $amounts)
  $tx = Invoke-LtcRpc -Wallet $SourceWallet -Method "gettransaction" -Params @($txid)
  $txConfirmations = $tx.confirmations
}

$dstBalances = Invoke-LtcRpc -Wallet $DestinationWallet -Method "getbalances"

[pscustomobject]@{
  tag = $Tag
  rpc_url = $RpcUrl
  source_wallet = $SourceWallet
  destination_wallet = $DestinationWallet
  create_only = [bool]$CreateOnly
  required_total_ltc = $required
  source_trusted_ltc = $available
  txid = $txid
  tx_confirmations = $txConfirmations
  addresses = $addresses
  amounts_ltc = $amounts
  source_wallet_mine = $srcBalances.mine
  destination_wallet_mine = $dstBalances.mine
} | ConvertTo-Json -Depth 20
