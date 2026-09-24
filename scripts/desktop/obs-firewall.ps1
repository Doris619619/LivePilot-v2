# 文件用途：固定的提权防火墙辅助程序，仅读取原 Windows 用户加密配置并限制自有 OBS 控制端口。
param([Parameter(Mandatory=$true)][string]$Root64, [Parameter(Mandatory=$true)][string]$RootId)
$ErrorActionPreference = 'Stop'
$phase = 'root-validation'
try {
  Add-Type -AssemblyName System.Security
  $dataDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Root64))
  if (-not [IO.Path]::IsPathRooted($dataDirectory) -or $dataDirectory.StartsWith('\\')) { throw 'Invalid root' }
  # 检查每级路径，拒绝 junction 和符号链接，不跟随外部程序路径。
  function Assert-Ordinary([string]$entry) {
    $current = Get-Item -LiteralPath $entry -Force
    while ($null -ne $current) {
      if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
      if ($current -is [IO.FileInfo]) { $current = $current.Directory } else { $current = $current.Parent }
    }
  }
  Assert-Ordinary $dataDirectory
  $markerFile = Join-Path $dataDirectory '.livenest-root.json'; Assert-Ordinary $markerFile
  $marker = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
  if ($marker.product -ne 'LiveNest' -or $marker.version -ne 1 -or $marker.id -cne $RootId -or $RootId -notmatch '^[a-f0-9-]{36}$') { throw 'Ownership mismatch' }
  $settingsFile = Join-Path $dataDirectory 'state\desktop\settings.json'; Assert-Ordinary $settingsFile
  $phase = 'settings-decryption'
  $encrypted = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
  if (-not $encrypted.StartsWith('dpapi:')) { throw 'Unsupported credentials' }
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encrypted.Substring(6)), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $settings = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
  if ($settings.rootId -cne $RootId -or [IO.Path]::GetFullPath($settings.dataRoot) -ine [IO.Path]::GetFullPath($dataDirectory)) { throw 'Configuration mismatch' }
  $targets = @($settings.instances | Where-Object { $_.managed -eq $true -and $_.initialized -eq $true })
  if ($targets.Count -gt 64) { throw 'Too many targets' }
  # IPv4 排除整个 127/8；IPv6 排除 ::1，不创建会覆盖回环的全范围阻止规则。
  $remote = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
  $group = 'LiveNest-Control-' + $RootId
  $wanted = @()
  foreach ($target in $targets) {
    $phase = 'instance-validation'
    if ($target.id -cnotmatch '^[a-z][a-z0-9_-]{0,31}$' -or $target.port -lt 1024 -or $target.port -gt 65535) { throw 'Invalid target' }
    $base = Join-Path $dataDirectory ('obs\' + $target.id)
    $exe = Join-Path $base 'bin\64bit\obs64.exe'
    Assert-Ordinary $exe
    $ownerFile = Join-Path $base '.livenest-owner'; Assert-Ordinary $ownerFile
    if ([IO.Path]::GetFullPath($target.exe) -ine [IO.Path]::GetFullPath($exe) -or (Get-Content -LiteralPath $ownerFile -Raw) -cne $target.id) { throw 'OBS ownership mismatch' }
    $name = $group + '-' + $target.id
    $wanted += $name
    $phase = 'rule-read'
    $rule = Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue
    if ($rule -and $rule.Group -ne $group) { throw 'Rule ownership mismatch' }
    if ($rule) {
      $phase = 'rule-update'
      Set-NetFirewallRule -PolicyStore PersistentStore -Name $name -Direction Inbound -Action Block -Enabled True -Profile Any -Program $exe -Protocol TCP -LocalPort $target.port -RemoteAddress $remote | Out-Null
    } else {
      $phase = 'rule-create'
      New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName ('LiveNest OBS control ' + $target.id) -Group $group -Direction Inbound -Action Block -Enabled True -Profile Any -Program $exe -Protocol TCP -LocalPort $target.port -RemoteAddress $remote | Out-Null
    }
  }
  # 只清理同一个已验证数据根的自有规则，不触碰 Windows 或用户规则。
  $phase = 'owned-rule-cleanup'
  Get-NetFirewallRule -PolicyStore PersistentStore -Group $group -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin $wanted -and $_.Name.StartsWith($group + '-') } | Remove-NetFirewallRule
  exit 0
} catch { [Console]::Error.WriteLine('LiveNest firewall phase=' + $phase + '; type=' + $_.Exception.GetType().Name + '; code=' + $_.Exception.HResult); exit 1 }
