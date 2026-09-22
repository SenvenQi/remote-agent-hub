# Remote Agent Hub - tray control panel (client side).
# A small window to fill in the hub/token and see connection status. Minimizes
# to the system tray. Saving writes a valid config.json (via ConvertTo-Json, so
# no hand-editing mistakes) and restarts the agent (elevates once via UAC).
# The agent itself runs as SYSTEM; this is just a control surface for the user.

[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')

$TaskName   = 'RemoteAgentHub'
$ConfigPath = Join-Path $env:ProgramData 'remote-agent-hub\config.json'
$LogPath    = Join-Path $env:ProgramData 'remote-agent-hub\agent.log'

function Read-Config {
  try { return (Get-Content $ConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

# ---- classify status from task state + last log line ----------------------
function Get-Status {
  $running = $false
  try { $q = schtasks /query /tn $TaskName /fo csv 2>$null | ConvertFrom-Csv; if ($q) { $running = ($q.Status -eq 'Running') } } catch {}
  $line = ''
  try { $line = Get-Content $LogPath -Tail 60 -ErrorAction Stop | Where-Object { $_ -match '\S' } | Select-Object -Last 1 } catch {}
  if     ($line -match 'registered as')               { return @{ text='已连接';          color=[System.Drawing.Color]::LimeGreen } }
  elseif ($line -match 'denied')                      { return @{ text='被拒 (token 不对)'; color=[System.Drawing.Color]::Red } }
  elseif ($line -match 'CANNOT START|NOT VALID JSON') { return @{ text='配置错误';         color=[System.Drawing.Color]::Red } }
  elseif ($line -match 'dialing|retrying|ws error')   { return @{ text='连接中/重试…';     color=[System.Drawing.Color]::Orange } }
  elseif ($running)                                   { return @{ text='运行中';           color=[System.Drawing.Color]::Orange } }
  else                                                { return @{ text='未运行';           color=[System.Drawing.Color]::Gray } }
}

# ---- colored dot icon built at runtime ------------------------------------
$IconCache = @{}
function Get-DotIcon([System.Drawing.Color]$c) {
  if ($IconCache.ContainsKey($c.Name)) { return $IconCache[$c.Name] }
  $bmp = New-Object System.Drawing.Bitmap 16,16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $c
  $g.FillEllipse($brush, 2, 2, 11, 11); $g.Dispose(); $brush.Dispose()
  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $IconCache[$c.Name] = $ico; return $ico
}

# ---- window ---------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Remote Agent Hub'
$form.Size = New-Object System.Drawing.Size(440, 300)
$form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'

$lblState = New-Object System.Windows.Forms.Label
$lblState.Location = New-Object System.Drawing.Point(16, 14)
$lblState.Size = New-Object System.Drawing.Size(408, 30)
$lblState.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$lblState.Text = '状态: …'
$form.Controls.Add($lblState)

$lblHub = New-Object System.Windows.Forms.Label
$lblHub.Location = New-Object System.Drawing.Point(16, 58); $lblHub.Size = New-Object System.Drawing.Size(90, 22)
$lblHub.Text = '服务器 Hub:'; $form.Controls.Add($lblHub)
$txtHub = New-Object System.Windows.Forms.TextBox
$txtHub.Location = New-Object System.Drawing.Point(110, 55); $txtHub.Size = New-Object System.Drawing.Size(314, 24)
$form.Controls.Add($txtHub)

$lblTok = New-Object System.Windows.Forms.Label
$lblTok.Location = New-Object System.Drawing.Point(16, 92); $lblTok.Size = New-Object System.Drawing.Size(90, 22)
$lblTok.Text = 'Token:'; $form.Controls.Add($lblTok)
$txtTok = New-Object System.Windows.Forms.TextBox
$txtTok.Location = New-Object System.Drawing.Point(110, 89); $txtTok.Size = New-Object System.Drawing.Size(314, 24)
$form.Controls.Add($txtTok)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Location = New-Object System.Drawing.Point(110, 122); $btnSave.Size = New-Object System.Drawing.Size(150, 32)
$btnSave.Text = '保存并连接'; $btnSave.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnSave)

$btnTray = New-Object System.Windows.Forms.Button
$btnTray.Location = New-Object System.Drawing.Point(274, 122); $btnTray.Size = New-Object System.Drawing.Size(150, 32)
$btnTray.Text = '收进托盘'; $form.Controls.Add($btnTray)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Location = New-Object System.Drawing.Point(16, 166); $logBox.Size = New-Object System.Drawing.Size(408, 88)
$logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = 'Vertical'
$logBox.Font = New-Object System.Drawing.Font('Consolas', 8)
$form.Controls.Add($logBox)

# prefill from existing config
$cfg = Read-Config
$txtHub.Text = if ($cfg -and $cfg.hub) { $cfg.hub } else { 'ws://43.172.117.227:8787' }
$txtTok.Text = if ($cfg -and $cfg.token) { $cfg.token } else { '' }

# ---- save + connect (writes valid JSON, restarts agent, elevates once) ----
$btnSave.Add_Click({
  $hub = $txtHub.Text.Trim(); $tok = $txtTok.Text.Trim()
  if (-not $hub -or -not $tok) {
    [System.Windows.Forms.MessageBox]::Show('Hub 和 Token 都要填。', 'Remote Agent Hub') | Out-Null; return
  }
  $eh = $hub -replace "'", "''"; $et = $tok -replace "'", "''"
  # write UTF-8 WITHOUT BOM (Node's JSON.parse rejects a BOM)
  $cmd = "`$c=[ordered]@{hub='$eh';token='$et';logfile='$($LogPath -replace "'","''")'};" +
         "[IO.File]::WriteAllText('$($ConfigPath -replace "'","''")',(`$c|ConvertTo-Json),(New-Object System.Text.UTF8Encoding(`$false)));" +
         "schtasks /end /tn $TaskName 2>`$null; Start-Sleep -Milliseconds 500; schtasks /run /tn $TaskName"
  try {
    Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',$cmd
    $lblState.Text = '状态: 已保存,重启中…'; $lblState.ForeColor = [System.Drawing.Color]::Orange
  } catch {
    [System.Windows.Forms.MessageBox]::Show('需要管理员权限才能保存配置。请在 UAC 弹窗点“是”。', 'Remote Agent Hub') | Out-Null
  }
})

# ---- tray -----------------------------------------------------------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = 'Remote Agent Hub'; $tray.Visible = $true
$tray.Icon = Get-DotIcon ([System.Drawing.Color]::Gray)
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $menu.Items.Add('显示面板'); [void]$menu.Items.Add('-'); $miExit = $menu.Items.Add('退出托盘')
$tray.ContextMenuStrip = $menu
function Show-Window { $form.Show(); $form.WindowState = 'Normal'; $form.Activate() }
$miShow.Add_Click({ Show-Window })
$miExit.Add_Click({ $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.Add_MouseDoubleClick({ Show-Window })
$btnTray.Add_Click({ $form.WindowState = 'Minimized' })

$form.Add_Resize({ if ($form.WindowState -eq 'Minimized') { $form.Hide(); $tray.ShowBalloonTip(1200,'Remote Agent Hub','已最小化到托盘,仍在监控中。',[System.Windows.Forms.ToolTipIcon]::Info) } })
$form.Add_FormClosing({ param($s,$e) if ($e.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) { $e.Cancel = $true; $form.Hide() } })

# ---- poll status ----------------------------------------------------------
$lastText = ''
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  $st = Get-Status
  $lblState.Text = '状态: ' + $st.text; $lblState.ForeColor = $st.color
  $tray.Icon = Get-DotIcon $st.color; $tray.Text = 'Remote Agent Hub - ' + $st.text
  try { $logBox.Text = ((Get-Content $LogPath -Tail 8 -ErrorAction Stop) -join "`r`n") } catch { $logBox.Text = '(暂无日志)' }
  if ($st.text -ne $lastText) {
    if ($lastText -ne '') { $tray.ShowBalloonTip(2000, 'Remote Agent Hub', '状态: ' + $st.text, [System.Windows.Forms.ToolTipIcon]::Info) }
    $lastText = $st.text
  }
})
$timer.Start()

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
$tray.Visible = $false
