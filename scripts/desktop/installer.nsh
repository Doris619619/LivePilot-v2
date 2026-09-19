; 文件用途：NSIS 安装标记，且安装/卸载时拒绝强杀正在运行的 LiveNest。
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\livenest-installed" w
  FileWrite $0 "nsis"
  FileClose $0
!macroend
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "LiveNest.exe" $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please exit LiveNest from its tray menu before installing or uninstalling. Running broadcasts will not be interrupted." /SD IDOK
    Abort
  ${EndIf}
!macroend
