# 在桌面创建"一键启动"快捷方式
$ErrorActionPreference = 'Stop'

$src     = 'D:\workbuddy\2026-09-26-20-02-15\daily-writing-pc'
$bat     = Join-Path $src 'start-app.bat'
$ico     = Join-Path $src 'assets\app.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk     = Join-Path $desktop 'AI儿童每日写作训练.lnk'

if (-not (Test-Path $bat)) { throw "start-app.bat 不存在: $bat" }
if (-not (Test-Path $ico)) { throw "app.ico 不存在: $ico" }

# 先看桌面有没有同名项（含用户手工放的）
$existing = @()
Get-ChildItem -Path $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue |
  ForEach-Object { $existing += $_.Name }

$ws = New-Object -ComObject WScript.Shell
$s  = $ws.CreateShortcut($lnk)
$s.TargetPath       = $bat
$s.WorkingDirectory = $src
$s.IconLocation     = "$ico,0"
$s.Description      = 'AI 儿童每日写作训练 - 一键启动（自动允许摄像头、自动起深度服务）'
$s.WindowStyle      = 1
$s.Save()

# ---- 读回自检 ----
$v = $ws.CreateShortcut($lnk)
$lines = @()
$lines += 'LNK      = ' + $lnk
$lines += 'EXISTS   = ' + (Test-Path $lnk)
$lines += 'TARGET   = ' + $v.TargetPath
$lines += 'TARGETOK = ' + (Test-Path $v.TargetPath)
$lines += 'WORKDIR  = ' + $v.WorkingDirectory
$lines += 'WORKDOK  = ' + (Test-Path $v.WorkingDirectory)
$lines += 'ICON     = ' + $v.IconLocation
$lines += 'ICONOK   = ' + (Test-Path $ico)
$lines += 'DESC     = ' + $v.Description
$lines += 'WINDOW   = ' + $v.WindowStyle
$lines += '--- 桌面现有 .lnk ---'
$lines += ($existing -join ' | ')
Set-Content -Path "$env:TEMP\lnk-check.txt" -Value ($lines -join "`r`n") -Encoding UTF8

Write-Output 'DONE'
