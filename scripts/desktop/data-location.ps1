# 文件用途：安装器数据位置校验与非敏感定位记录；不读取或复制直播素材。
param([ValidateSet('Inspect','Validate','Persist')][string]$Mode, [string]$Bootstrap, [string]$Target, [string]$Installation, [string]$Result)
$ErrorActionPreference = 'Stop'
$script:PendingSelection = $false
# 将结果写为 UTF-16 INI，避免 NSIS 管道对中文路径的编码差异。
function ResultFile([string]$Root, [string]$ErrorText = '') {
  [IO.File]::WriteAllText($Result, "[location]`r`nroot=$Root`r`nerror=$ErrorText`r`n", [Text.Encoding]::Unicode)
}
# 验证父级没有重解析点，禁止 junction 绕过安装目录分离。
function Ordinary([string]$Value) {
  if (-not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\') -or $Value -match '[\r\n]') { throw '请选择本机磁盘的绝对路径。' }
  $full = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '路径包含文件或目录链接，请选择普通文件夹。' }
    }
    $next = Split-Path -Parent $cursor
    if ($next -eq $cursor) { break }; $cursor = $next
  }
  $cursor=$full; $tail=New-Object 'System.Collections.Generic.List[string]'
  while (-not (Test-Path -LiteralPath $cursor)) {
    $tail.Insert(0,(Split-Path -Leaf $cursor)); $cursor=Split-Path -Parent $cursor
    if (-not $cursor) { throw '目标磁盘不可用。' }
  }
  $buffer=New-Object Text.StringBuilder 32768
  if ([LiveNestNativePath]::GetLongPathName($cursor,$buffer,32768) -eq 0) { throw '无法确认目标真实路径。' }
  $resolved=$buffer.ToString()
  foreach($part in $tail) { $resolved=Join-Path $resolved $part }
  return $resolved.TrimEnd('\')
}
# 已安装用户优先读取定位记录；旧版密文仅用于沿用原位置，不创建新身份。
function ExistingRoot {
  $locator = Join-Path $Bootstrap 'data-location.json'
  if (Test-Path -LiteralPath $locator) {
    $location = Get-Content -LiteralPath $locator -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($location.version -ne 1 -or -not $location.dataRoot) { throw '已有数据位置记录损坏，请保留配置。' }
    $script:PendingSelection = $location.pending -eq $true
    return [string]$location.dataRoot
  }
  $legacy = Join-Path $Bootstrap 'settings.json'
  if (Test-Path -LiteralPath $legacy) {
    $encrypted = Get-Content -LiteralPath $legacy -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $encrypted.StartsWith('dpapi:')) { throw '请先使用原 Windows 用户打开旧版 LiveNest，完成配置兼容后再安装。' }
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encrypted.Substring(6)), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $settings = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if (-not $settings.dataRoot) { throw '无法读取旧数据位置，请保留原配置。' }
    return [string]$settings.dataRoot
  }
  return ''
}
try {
  # NSIS 的插件目录含原生 System.dll；不能让 Add-Type 将其当作 .NET 引用。
  [Environment]::CurrentDirectory = $PSHOME
  Add-Type -AssemblyName System.Security
  Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class LiveNestNativePath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetLongPathName(string input, StringBuilder output, uint size);
}
"@
  $existing = ExistingRoot
  if ($Mode -eq 'Inspect') { ResultFile $existing; exit 0 }
  $root = Ordinary $Target; $installed = Ordinary $Installation
  if ($root.Equals($installed, [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($installed+'\',[StringComparison]::OrdinalIgnoreCase) -or $installed.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '程序安装位置和 LiveNest 数据位置不能相同或相互包含。' }
  if ($existing -and -not $root.Equals((Ordinary $existing),[StringComparison]::OrdinalIgnoreCase)) { throw '已有数据位置必须保留，请安装后在设置中更改位置。' }
  if ($existing -and -not $script:PendingSelection -and -not (Test-Path -LiteralPath $root -PathType Container)) { throw '原数据盘不可用，请连接原数据盘后重试。' }
  if ((Test-Path -LiteralPath $root) -and -not $existing) {
    $files = @(Get-ChildItem -LiteralPath $root -Force)
    if ($files.Count) {
      $markerPath=Join-Path $root '.livenest-root.json'
      $marker=Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($marker.product -ne 'LiveNest' -or $marker.version -ne 1 -or $marker.id -notmatch '^[a-f0-9-]{36}$' -or ((Get-Item -LiteralPath $markerPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '目标不是有效 LiveNest 数据目录，没有覆盖文件。' }
    }
  }
  # 在最近已有父目录验证当前用户写权限；不在未知目录内创建文件。
  $parent = Split-Path -Parent $root
  while (-not (Test-Path -LiteralPath $parent)) { $parent=Split-Path -Parent $parent }
  $probe=Join-Path $parent ('.livenest-probe-'+[Guid]::NewGuid().ToString())
  $stream=[IO.File]::Open($probe,[IO.FileMode]::CreateNew); $stream.Dispose(); [IO.File]::Delete($probe)
  if ($Mode -eq 'Persist' -and -not $existing) {
    [IO.Directory]::CreateDirectory($Bootstrap) | Out-Null
    $locator=Join-Path $Bootstrap 'data-location.json'
    $json=@{version=1;dataRoot=$root;pending=$true} | ConvertTo-Json -Compress
    $temporary=$locator+'.'+[Guid]::NewGuid().ToString()+'.tmp'
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes($json);$stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    [IO.File]::Move($temporary,$locator)
  }
  ResultFile $root; exit 0
} catch { ResultFile '' '无法使用此数据位置：请检查磁盘、写入权限、目录归属，以及程序和数据位置是否分离。原配置与文件保留。'; exit 1 }
