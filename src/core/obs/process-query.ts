/** 使用内核文件路径识别 OBS，避免 MSIX 虚拟路径把两份程序误判成同一实例。 */
export const obsProcessQuery = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ObsImageIdentity {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll", CharSet=CharSet.Unicode)] static extern uint GetProcessImageFileName(IntPtr handle, StringBuilder path, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint size, uint flags);
  // 对目标文件句柄和进程内核镜像使用同一种 NT 路径，拒绝逻辑别名误匹配。
  public static int[] Find(string filename) {
    string target;
    using (var file = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      var path = new StringBuilder(32768);
      var length = GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(), path, (uint)path.Capacity, 2);
      if (length == 0 || length >= path.Capacity) throw new IOException("Cannot resolve executable identity");
      target = path.ToString();
    }
    var matches = new List<int>();
    foreach (var process in Process.GetProcessesByName("obs64")) {
      using (process) {
        var handle = OpenProcess(0x1000, false, (uint)process.Id);
        if (handle == IntPtr.Zero) continue;
        try {
          var path = new StringBuilder(32768);
          if (GetProcessImageFileName(handle, path, path.Capacity) > 0 && String.Equals(target, path.ToString(), StringComparison.OrdinalIgnoreCase)) matches.Add(process.Id);
        } finally { CloseHandle(handle); }
      }
    }
    return matches.ToArray();
  }
}
"@
$matches=@([ObsImageIdentity]::Find($env:LIVEPILOT_TARGET_EXE))
if($matches.Count -gt 1){throw 'Multiple matching OBS processes'}
$pidValue=$null
if($matches.Count -eq 1){$pidValue=[int]$matches[0]}
@{pid=$pidValue}|ConvertTo-Json -Compress`;
