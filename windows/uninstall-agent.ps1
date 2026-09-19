#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Remove the remote-agent-hub agent: stop + delete the scheduled task and
  (optionally) delete the install directory with its config and logs.
.EXAMPLE
  .\uninstall-agent.ps1 -Purge
#>
[CmdletBinding()]
param(
  [string]$TaskName = "RemoteAgentHub",
  [switch]$Purge
)
$ErrorActionPreference = "SilentlyContinue"
$InstallDir = Join-Path $env:ProgramData "remote-agent-hub"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[uninstall] removed scheduled task '$TaskName'"
} else {
  Write-Host "[uninstall] no task '$TaskName' found"
}

# stop any lingering agent node process pointed at our install dir
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*remote-agent-hub*agent.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "[uninstall] killed pid $($_.ProcessId)" }

if ($Purge) {
  Remove-Item -Recurse -Force $InstallDir
  Write-Host "[uninstall] purged $InstallDir"
} else {
  Write-Host "[uninstall] left $InstallDir in place (use -Purge to delete config + logs)"
}
