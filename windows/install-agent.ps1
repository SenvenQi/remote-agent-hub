#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install the remote-agent-hub agent on this Windows machine as a background
  Scheduled Task that starts at boot and restarts itself on failure.

.DESCRIPTION
  Installs to $env:ProgramData\remote-agent-hub. Only install this on machines
  you own or are authorized to administer. The shared token is stored in
  config.json, which is ACL'd to SYSTEM + Administrators only.

.EXAMPLE
  .\install-agent.ps1 -Hub ws://10.4.0.6:8787 -Token <shared-secret> -Name dev-box-1

.PARAMETER RunAsUser
  Optional. Run the agent as this user instead of SYSTEM (e.g. "DOMAIN\dev").
  You will be prompted for the password. Use this when the agent needs a real
  user profile / desktop session rather than the SYSTEM account.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Hub,
  [Parameter(Mandatory)][string]$Token,
  [string]$Name = $env:COMPUTERNAME,
  [string]$Shell = "powershell.exe",
  [string]$RunAsUser,
  [string]$TaskName = "RemoteAgentHub"
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:ProgramData "remote-agent-hub"
$LogFile    = Join-Path $InstallDir "agent.log"
$ConfigPath = Join-Path $InstallDir "config.json"

# --- locate node ----------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH. Install Node.js first." }
Write-Host "[install] node: $node"

# --- lay down files -------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$srcDir = Split-Path -Parent $PSScriptRoot   # repo root (windows\ is under it)
foreach ($f in @("src\agent.js", "src\protocol.js")) {
  $dest = Join-Path $InstallDir (Split-Path $f -Leaf)
  Copy-Item (Join-Path $srcDir $f) $dest -Force
}
# minimal ws dependency
$wsSrc = Join-Path $srcDir "node_modules\ws"
if (Test-Path $wsSrc) {
  $nm = Join-Path $InstallDir "node_modules"
  New-Item -ItemType Directory -Force -Path $nm | Out-Null
  Copy-Item $wsSrc (Join-Path $nm "ws") -Recurse -Force
} else {
  Write-Warning "node_modules\ws not found next to repo; run 'npm install' there, or 'npm install ws' inside $InstallDir"
}

# --- write config (token lives here, not on the command line) -------------
$config = [ordered]@{ hub = $Hub; token = $Token; name = $Name; shell = $Shell; logfile = $LogFile }
$config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
Write-Host "[install] wrote $ConfigPath"

# lock config + install dir down to SYSTEM + Administrators
icacls $ConfigPath /inheritance:r /grant:r "SYSTEM:(F)" "BUILTIN\Administrators:(F)" | Out-Null

# --- register the scheduled task ------------------------------------------
$agentJs = Join-Path $InstallDir "agent.js"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$agentJs`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

if ($RunAsUser) {
  $cred = Get-Credential -UserName $RunAsUser -Message "Password for $RunAsUser (agent will run as this user)"
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
} else {
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
}
Write-Host "[install] registered scheduled task '$TaskName'"

# --- start it now ---------------------------------------------------------
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "[install] task state: $state"
Write-Host "[install] done. Log: $LogFile"
Write-Host "[install] tail the log:  Get-Content '$LogFile' -Wait -Tail 20"
