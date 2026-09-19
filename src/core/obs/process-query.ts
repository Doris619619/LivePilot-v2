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
using Microsoft.Win32.SafeHandles;
public static class ObsImageIdentity {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll", CharSet=CharSet.Unicode)] static extern uint GetProcessImageFileName(IntPtr handle, StringBuilder path, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  // 规范化句柄路径，兼容进程镜像名中的 8.3 短目录名。
  static string FinalPath(string filename) {
    using (var file = CreateFile(filename, 0x80, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (file.IsInvalid) throw new IOException("Cannot open executable identity");
      var path = new StringBuilder(32768);
      var length = GetFinalPathNameByHandle(file.DangerousGetHandle(), path, (uint)path.Capacity, 2);
      if (length == 0 || length >= path.Capacity) throw new IOException("Cannot resolve executable identity");
      return path.ToString();
    }
  }
  // 只通过物理设备路径打开运行镜像；不能转回可能被 MSIX 重定向的盘符路径。
  public static int[] Find(string filename) {
    var target = FinalPath(filename);
    var matches = new List<int>();
    foreach (var process in Process.GetProcessesByName("obs64")) {
      using (process) {
        var handle = OpenProcess(0x1000, false, (uint)process.Id);
        if (handle == IntPtr.Zero) continue;
        try {
          var path = new StringBuilder(32768);
          if (GetProcessImageFileName(handle, path, path.Capacity) > 0) {
            try {
              var actual = FinalPath(@"\\?\GLOBALROOT" + path.ToString());
              if (String.Equals(target, actual, StringComparison.OrdinalIgnoreCase)) matches.Add(process.Id);
            } catch (IOException) { /* 已退出或无权读取的进程不认领，端口归属检查仍保留。 */ }
          }
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
