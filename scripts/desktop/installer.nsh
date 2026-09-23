; 文件用途：安装时分别选择程序与数据位置，升级沿用数据，卸载保留业务文件。
!include nsDialogs.nsh
!include LogicLib.nsh
!ifndef BUILD_UNINSTALLER
Var DataParent
Var DataRoot
Var DataInput
Var DataPreview
Var DataExisting
Var DataError
Var DataBootstrap
!define LIVENEST_DATA_LOCATION_HELPER "${__FILEDIR__}\data-location.ps1"

!macro customInit
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=data-location.ps1 "${LIVENEST_DATA_LOCATION_HELPER}"
!macroend

; 延迟到模板头部再编译函数，确保 MUI 和插件目录已经注册。
!macro customHeader
; 使用 -File 参数调用，不将用户路径拼入 PowerShell 代码。
Function InspectDataLocation
  ; 数据属于当前 Windows 账号；全用户程序安装也不能改用 ProgramData。
  SetShellVarContext current
  StrCpy $DataBootstrap "$APPDATA\LiveNest"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\data-location.ps1" -Mode Inspect -Bootstrap "$DataBootstrap" -Result "$PLUGINSDIR\data-result.ini"'
  Pop $0
  Pop $1
  ReadINIStr $DataExisting "$PLUGINSDIR\data-result.ini" "location" "root"
  ReadINIStr $DataError "$PLUGINSDIR\data-result.ini" "location" "error"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "$DataError" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Function UpdateDataPreview
  ${NSD_GetText} $DataInput $DataParent
  StrCpy $0 "$DataParent" 1 -1
  ${If} $0 == "\"
    StrCpy $DataParent "$DataParent" -1
  ${EndIf}
  StrCpy $DataRoot "$DataParent\LiveNest"
  ${NSD_SetText} $DataPreview "实际保存位置：$DataRoot"
FunctionEnd

Function OnDataParentChange
  Pop $0
  Call UpdateDataPreview
FunctionEnd

Function BrowseDataParent
  Pop $0
  nsDialogs::SelectFolderDialog "选择保存数据的父文件夹" "$DataParent"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $DataInput "$0"
    Call UpdateDataPreview
  ${EndIf}
FunctionEnd

Function DataLocationPage
  Call InspectDataLocation
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  !insertmacro MUI_HEADER_TEXT "LiveNest 数据保存位置" "程序安装位置与直播数据位置分别设置"
  ${If} $DataExisting != ""
    StrCpy $DataRoot $DataExisting
    ${NSD_CreateLabel} 0 8u 100% 55u "已有 LiveNest 数据位置：$DataRoot$\r$\n升级和重装将继续使用这里。需要搬迁时，请安装后在设置中选择“更改位置”。"
    Pop $0
  ${Else}
    ${If} $DataParent == ""
      StrCpy $DataParent "$LOCALAPPDATA"
      IfFileExists "D:\*.*" 0 +2
        StrCpy $DataParent "D:"
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 30u "选择父文件夹，程序自动创建 LiveNest 文件夹。OBS、素材、授权和状态保存在这里。"
    Pop $0
    ${NSD_CreateDirRequest} 0 38u 78% 14u "$DataParent"
    Pop $DataInput
    ${NSD_OnChange} $DataInput OnDataParentChange
    ${NSD_CreateButton} 80% 38u 20% 14u "浏览…"
    Pop $0
    ${NSD_OnClick} $0 BrowseDataParent
    ${NSD_CreateLabel} 0 63u 100% 45u ""
    Pop $DataPreview
    Call UpdateDataPreview
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ValidateDataLocation
  ${If} $DataExisting != ""
    StrCpy $DataRoot $DataExisting
  ${EndIf}
  ; assistedInstaller 可能自动补产品文件夹，提前采用相同结果校验。
  StrCpy $2 "$INSTDIR"
  ${StrContains} $0 "LiveNest" $2
  ${If} $0 == ""
    StrCpy $2 "$2\LiveNest"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\data-location.ps1" -Mode Validate -Bootstrap "$DataBootstrap" -Target "$DataRoot" -Installation "$2" -Result "$PLUGINSDIR\data-result.ini"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $DataError "$PLUGINSDIR\data-result.ini" "location" "error"
    MessageBox MB_OK|MB_ICONSTOP "$DataError" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

!macroend

!macro customPageAfterChangeDir
  Page custom DataLocationPage ValidateDataLocation
!macroend

!macro customInstall
  Call InspectDataLocation
  ${If} $DataExisting != ""
    StrCpy $DataRoot $DataExisting
  ${EndIf}
  ; 静默新安装没有明确数据位置时失败，不能猜测位置创建身份。
  ${If} $DataRoot == ""
    MessageBox MB_OK|MB_ICONSTOP "请运行交互安装向导选择 LiveNest 数据位置。" /SD IDOK
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\data-location.ps1" -Mode Persist -Bootstrap "$DataBootstrap" -Target "$DataRoot" -Installation "$INSTDIR" -Result "$PLUGINSDIR\data-result.ini"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $DataError "$PLUGINSDIR\data-result.ini" "location" "error"
    MessageBox MB_OK|MB_ICONSTOP "$DataError" /SD IDOK
    Abort
  ${EndIf}
  FileOpen $0 "$INSTDIR\resources\livenest-installed" w
  FileWrite $0 "nsis"
  FileClose $0
!macroend

!endif

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    Call InspectDataLocation
    Call ValidateDataLocation
  !endif
  ${nsProcess::FindProcess} "LiveNest.exe" $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please exit LiveNest from its tray menu before installing or uninstalling. Running broadcasts will not be interrupted." /SD IDOK
    Abort
  ${EndIf}
!macroend
