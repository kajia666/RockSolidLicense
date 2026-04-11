param(
  [string]$RulePrefix = "RockSolidLicense",
  [int]$HttpPort = 3000,
  [int]$TcpGatewayPort = 4000
)

$ErrorActionPreference = "Stop"

$rules = @(
  @{
    Name = "$RulePrefix HTTP"
    Port = $HttpPort
    Description = "RockSolidLicense HTTP admin and API port"
  },
  @{
    Name = "$RulePrefix TCP Gateway"
    Port = $TcpGatewayPort
    Description = "RockSolidLicense TCP client gateway port"
  }
)

foreach ($rule in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $($rule.Name)"
    continue
  }

  New-NetFirewallRule `
    -DisplayName $rule.Name `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $rule.Port `
    -Profile Any `
    -Description $rule.Description | Out-Null

  Write-Host "Created firewall rule: $($rule.Name) on port $($rule.Port)"
}
