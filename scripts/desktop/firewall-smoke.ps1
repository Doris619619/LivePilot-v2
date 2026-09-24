# 文件用途：仅在一次性 GitHub Windows 环境验证真实防火墙辅助程序与规则生命周期。
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable Windows runner required' }
Add-Type -AssemblyName System.Security
$fixtureDirectory = Join-Path $env:TEMP ('livenest-firewall-' + [guid]::NewGuid())
$rootId = [guid]::NewGuid().ToString()
$group = 'LiveNest-Control-' + $rootId
$utf8 = New-Object Text.UTF8Encoding($false)
$items = @()
New-Item -ItemType Directory -Path (Join-Path $fixtureDirectory 'state\desktop') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $fixtureDirectory '.livenest-root.json'), (@{product='LiveNest';version=1;id=$rootId}|ConvertTo-Json), $utf8)
foreach ($id in @('main','second')) {
  $base = Join-Path $fixtureDirectory ('obs\' + $id)
  New-Item -ItemType Directory -Path (Join-Path $base 'bin\64bit') -Force | Out-Null
  $exe = Join-Path $base 'bin\64bit\obs64.exe'
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination $exe
  [IO.File]::WriteAllText((Join-Path $base '.livenest-owner'), $id, $utf8)
  $fixturePort = if ($id -eq 'main') {14455} else {14456}
  $items += @{id=$id;exe=$exe;port=$fixturePort;managed=$true;initialized=$true}
}
# 原用户 DPAPI 与正式配置格式相同；没有真实账号或 OBS 凭据。
function Save-Fixture {
  $value = @{rootId=$rootId;dataRoot=$fixtureDirectory;instances=$items} | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllText((Join-Path $fixtureDirectory 'state\desktop\settings.json'), (ConvertTo-Json -InputObject ('dpapi:' + [Convert]::ToBase64String($bytes))), $utf8)
}
# 子进程执行固定辅助文件；失败不能被父进程默认为成功。
function Run-Helper {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/desktop/obs-firewall.ps1 -Root64 ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fixtureDirectory))) -RootId $rootId
  if ($LASTEXITCODE -ne 0) { throw 'Helper failed' }
}
try {
  Save-Fixture; Run-Helper; Run-Helper
  $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Group $group)
  if ($rules.Count -ne 2) { throw 'Rules not idempotent' }
  foreach ($rule in $rules) {
    if ($rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Block') { throw 'Wrong rule direction' }
    $remote = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress)
    if ($remote.Count -ne 3 -or $remote -contains 'Any' -or $remote -contains '::1' -or $remote -contains '127.0.0.1') { throw 'Loopback exclusion missing' }
  }
  # 用已受规则约束的测试程序检查 IPv4/IPv6 本机控制与独立出站 HTTPS。
  $networkProbe=Join-Path $fixtureDirectory 'network-probe.cjs'
  $networkSource=@'
const net=require('node:net'),https=require('node:https');
async function loopback(host){
 const server=net.createServer(socket=>socket.end('ok'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(14455,host,resolve)});
 try {await new Promise((resolve,reject)=>{const socket=net.connect({host,port:14455});let received='';socket.setTimeout(5000,()=>socket.destroy(new Error('timeout')));socket.on('data',chunk=>received+=chunk);socket.once('error',reject);socket.once('end',()=>received==='ok'?resolve():reject(new Error('response')))});}
 finally {await new Promise(resolve=>server.close(resolve))}
}
(async()=>{
 await loopback('127.0.0.1');await loopback('::1');
 await new Promise((resolve,reject)=>{const request=https.request('https://api.github.com/',{method:'HEAD',headers:{'User-Agent':'LiveNest-CI'}},response=>{response.resume();response.once('end',resolve)});request.setTimeout(15000,()=>request.destroy(new Error('timeout')));request.once('error',reject);request.end()});
 console.log('PASS IPv4/IPv6 loopback control and outbound HTTPS');
})().catch(()=>{console.error('Isolated firewall network acceptance failed');process.exitCode=1});
'@
  [IO.File]::WriteAllText($networkProbe,$networkSource,$utf8)
  & $items[0].exe $networkProbe
  if($LASTEXITCODE -ne 0){throw 'Loopback or outbound acceptance failed'}
  $items[1].port=14457; Save-Fixture; Run-Helper
  if ((Get-NetFirewallRule -Name ($group+'-second') | Get-NetFirewallPortFilter).LocalPort -ne '14457') { throw 'Port reconciliation failed' }
  $items = @($items[0]); Save-Fixture; Run-Helper
  if (@(Get-NetFirewallRule -Group $group).Count -ne 1) { throw 'Obsolete owned rule remains' }
  Write-Output 'PASS: two targets, idempotence, IPv4/IPv6 scoped inbound rules, port change and owned-rule cleanup. External-host reachability is a separate acceptance boundary.'
} finally { Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
