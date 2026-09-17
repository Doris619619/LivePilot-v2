# 文件用途：在当前交互用户登录后启动 Agent，不在 Session 0 运行桌面 OBS。
param([string]$TaskName = "LivePilot-Agent")
$ErrorActionPreference = "Stop"
$agentRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$agentEntry = Join-Path $agentRoot "scripts\agent-launch.mjs"
$agentBuild = Join-Path $agentRoot "dist\agent.cjs"
$agentEnv = Join-Path $agentRoot ".env.agent"
if (!(Test-Path -LiteralPath $agentBuild) -or !(Test-Path -LiteralPath $agentEntry) -or !(Test-Path -LiteralPath $agentEnv)) { throw "先完成 agent:build、.env.agent 配置和设备配对。" }
$agentNode = (Get-Command node.exe -ErrorAction Stop).Source
$agentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $agentNode -Argument ('"' + $agentEntry + '" run') -WorkingDirectory $agentRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $agentUser
$principal = New-ScheduledTaskPrincipal -UserId $agentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "LivePilot：当前用户登录后连接云端；需要保持 Windows 登录。" | Out-Null
Write-Output "已注册登录启动任务；本脚本不会立即启动 OBS 或直播。请停止旧本地服务后手动运行 Agent 验证。"
