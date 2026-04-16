param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$TcpHost = "127.0.0.1",
  [int]$TcpPort = 4000,
  [int]$TimeoutSeconds = 10,
  [switch]$SkipTcp
)

$ErrorActionPreference = "Stop"

$healthUrl = "$($BaseUrl.TrimEnd('/'))/api/health"
$response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec $TimeoutSeconds
$healthData = if ($null -ne $response.data) { $response.data } else { $response }
$status = if ($null -ne $healthData.status) { $healthData.status } else { $null }

if ($status -ne "ok") {
  throw "Health endpoint returned unexpected status: $status"
}

$tcpOk = $true
if (-not $SkipTcp) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $asyncResult = $client.BeginConnect($TcpHost, $TcpPort, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutSeconds * 1000, $false)) {
      throw "TCP gateway connection timed out."
    }
    $client.EndConnect($asyncResult) | Out-Null
  } finally {
    $client.Dispose()
  }
}

$httpOk = if ($null -ne $response.ok) { [bool]$response.ok } else { $status -eq "ok" }

$result = [ordered]@{
  checkedAt = (Get-Date).ToString("o")
  http = @{
    url = $healthUrl
    ok = $httpOk
    status = $status
    env = $healthData.env
  }
  tcp = @{
    checked = (-not $SkipTcp)
    host = $TcpHost
    port = $TcpPort
    ok = $tcpOk
  }
  storage = $healthData.storage
}

$result | ConvertTo-Json -Depth 8
