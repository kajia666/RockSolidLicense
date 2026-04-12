param(
  [string]$ReleaseRoot = "build/win-sdk-package",
  [string]$Version = ""
)

if (-not $Version) {
  $Version = (Get-Content -LiteralPath "sdk/VERSION" -Raw).Trim()
}

$cppZip = Join-Path $ReleaseRoot ("rocksolid-sdk-cpp-" + $Version + ".zip")
$capiZip = Join-Path $ReleaseRoot ("rocksolid-sdk-capi-" + $Version + ".zip")
$targets = @($cppZip, $capiZip)

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    throw "Missing release archive: $target"
  }
}

$hashes = foreach ($target in $targets) {
  $item = Get-Item -LiteralPath $target
  $hash = Get-FileHash -LiteralPath $target -Algorithm SHA256
  [ordered]@{
    file = $item.Name
    algorithm = "SHA256"
    sha256 = $hash.Hash.ToLowerInvariant()
    size = $item.Length
  }
}

$sumLines = foreach ($entry in $hashes) {
  "{0} *{1}" -f $entry.sha256, $entry.file
}

Set-Content -LiteralPath (Join-Path $ReleaseRoot "SHA256SUMS.txt") -Value $sumLines -Encoding ascii
($hashes | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath (Join-Path $ReleaseRoot "checksums.json") -Encoding ascii
