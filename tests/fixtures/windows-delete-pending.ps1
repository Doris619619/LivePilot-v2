# Test-only Windows delete-pending lock owner; release only its own native handle.
param([string]$LockPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PendingLockFixture {
  [StructLayout(LayoutKind.Sequential)] public struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle,out IoStatus status,ref byte information,uint length,uint kind);
  public static int DeletePending(SafeFileHandle handle) { byte deleted=1; IoStatus status; return NtSetInformationFile(handle,out status,ref deleted,1,13); }
}
'@
$handle = [PendingLockFixture]::CreateFile($LockPath,[uint32]3221291008,7,[IntPtr]::Zero,1,128,[IntPtr]::Zero)
if ($handle.IsInvalid) { throw ('Fixture cannot create owned lock: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()+' / '+$LockPath) }
$stream = [IO.FileStream]::new($handle,[IO.FileAccess]::ReadWrite)
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$PID)
  $stream.Write($bytes,0,$bytes.Length); $stream.Flush()
  [Console]::Out.WriteLine('held')
  [Console]::In.ReadLine() | Out-Null
  if ([PendingLockFixture]::DeletePending($handle) -ne 0) { throw 'Fixture cannot mark its owned lock delete-pending' }
  [Console]::Out.WriteLine('pending')
  [Console]::In.ReadLine() | Out-Null
} finally { $stream.Dispose(); $handle.Dispose() }
