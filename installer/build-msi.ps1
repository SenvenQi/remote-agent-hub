#Requires -Version 5
<#
.SYNOPSIS
  Assemble the staging tree and build RemoteAgentHubAgent.msi.

.DESCRIPTION
  Bundles Node + the agent so clients need nothing preinstalled. The shared
  token is NOT baked into the MSI; it is supplied at install time:
      msiexec /i RemoteAgentHubAgent.msi RAHTOKEN=<secret> /qb
  Installs to C:\Program Files\RemoteAgentHub, writes config to
  C:\ProgramData\remote-agent-hub\config.json, and registers a boot-start
  SYSTEM scheduled task (removed on uninstall).

.EXAMPLE
  .\build-msi.ps1 -HubUrl ws://43.172.117.227:8787
#>
[CmdletBinding()]
param(
  [string]$HubUrl = "ws://43.172.117.227:8787",
  [string]$Out    = "$PSScriptRoot\RemoteAgentHubAgent.msi"
)
$ErrorActionPreference = "Stop"
$repo  = Split-Path -Parent $PSScriptRoot
$stage = "$PSScriptRoot\stage"
$app   = "$stage\app"
$data  = "$stage\data"

# locate tools
$node = (Get-Command node -ErrorAction Stop).Source
$wix  = (Get-Command wix -ErrorAction SilentlyContinue).Source
if (-not $wix) { $wix = "$env:USERPROFILE\.dotnet\tools\wix.exe" }
if (-not (Test-Path $wix)) { throw "wix not found. Install: dotnet tool install --global wix --version 5.0.2" }

# clean + assemble staging
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$app\node_modules", $data | Out-Null
Copy-Item $node "$app\node.exe" -Force
Copy-Item "$repo\src\agent.js","$repo\src\protocol.js" $app -Force
Copy-Item "$repo\node_modules\ws" "$app\node_modules\ws" -Recurse -Force
Copy-Item "$PSScriptRoot\task.xml" $app -Force
Copy-Item "$PSScriptRoot\tray\rah-tray.ps1","$PSScriptRoot\tray\rah-tray.vbs" $app -Force

# config.json without a token (injected at install time via RAHTOKEN)
[ordered]@{
  hub     = $HubUrl
  token   = ""
  logfile = "C:\ProgramData\remote-agent-hub\agent.log"
} | ConvertTo-Json | Set-Content "$data\config.json" -Encoding UTF8

# build (remove stale output first so a failure can't look like success)
Remove-Item $Out -Force -ErrorAction SilentlyContinue
& $wix build "$PSScriptRoot\Product.wxs" `
  -ext WixToolset.Util.wixext -ext WixToolset.UI.wixext `
  -arch x64 -o $Out
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Out)) { throw "wix build failed (exit $LASTEXITCODE)" }
"Built $Out ({0:N1} MB)" -f ((Get-Item $Out).Length / 1MB)
