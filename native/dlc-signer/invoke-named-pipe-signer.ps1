param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [ValidateRange(100, 30000)][int]$TimeoutMs = 10000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$maximumRequestBytes = 65536
$maximumResponseBytes = 1048576
if ($PipeName -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'named pipe name is invalid' }

function Read-ExactBytes {
  param([System.IO.Stream]$Stream, [int]$Count)
  $bytes = [byte[]]::new($Count)
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($bytes, $offset, $Count - $offset)
    if ($read -le 0) { throw 'named pipe broker closed a truncated frame' }
    $offset += $read
  }
  return $bytes
}

$inputStream = [Console]::OpenStandardInput()
$requestBuffer = [System.IO.MemoryStream]::new()
$readBuffer = [byte[]]::new(8192)
while (($read = $inputStream.Read($readBuffer, 0, $readBuffer.Length)) -gt 0) {
  if ($requestBuffer.Length + $read -gt $maximumRequestBytes) {
    throw 'named pipe signer request length is invalid'
  }
  $requestBuffer.Write($readBuffer, 0, $read)
}
$request = $requestBuffer.ToArray()
if ($request.Length -lt 1 -or $request.Length -gt $maximumRequestBytes) {
  throw 'named pipe signer request length is invalid'
}
$client = [System.IO.Pipes.NamedPipeClientStream]::new(
  '.',
  $PipeName,
  [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::WriteThrough,
  [System.Security.Principal.TokenImpersonationLevel]::Identification
)
try {
  $client.Connect($TimeoutMs)
  $length = [BitConverter]::GetBytes([int]$request.Length)
  $client.Write($length, 0, $length.Length)
  $client.Write($request, 0, $request.Length)
  $client.Flush()
  $header = Read-ExactBytes -Stream $client -Count 4
  $responseLength = [BitConverter]::ToInt32($header, 0)
  if ($responseLength -lt 1 -or $responseLength -gt $maximumResponseBytes) {
    throw 'named pipe broker response length is invalid'
  }
  $responseBytes = Read-ExactBytes -Stream $client -Count $responseLength
  $response = [System.Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json
  if ($response.ok -isnot [bool] -or
      ($response.exitCode -isnot [int] -and $response.exitCode -isnot [long]) -or
      $response.stdout -isnot [string] -or $response.stderr -isnot [string]) {
    throw 'named pipe broker response schema is invalid'
  }
  $stdout = [Convert]::FromBase64String($response.stdout)
  $stderr = [Convert]::FromBase64String($response.stderr)
  [Console]::OpenStandardOutput().Write($stdout, 0, $stdout.Length)
  [Console]::OpenStandardError().Write($stderr, 0, $stderr.Length)
  if (-not $response.ok -or $response.exitCode -ne 0) { exit 1 }
} finally {
  $client.Dispose()
}
