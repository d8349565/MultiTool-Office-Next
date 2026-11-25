Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
CRCCheck force
SetCompressor /SOLID lzma

!include "LogicLib.nsh"
!include "x64.nsh"

Name "MultiTool Office Next"
OutFile "${OUTFILE}"
Icon "${__FILEDIR__}\..\icons\icon.ico"
VIProductVersion "${APPVERSION}.0"
VIAddVersionKey "ProductName" "MultiTool Office Next"
VIAddVersionKey "FileDescription" "MultiTool Office Next 单文件版"
VIAddVersionKey "LegalCopyright" "MultiTool Office Next contributors"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "ProductVersion" "${APPVERSION}"

Section
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此版本需要 64 位 Windows。"
    SetErrorLevel 1
    Quit
  ${EndIf}

  ; Each launch owns its temporary payload, including while the app is in the tray.
  InitPluginsDir
  ClearErrors
  SetOutPath "$PLUGINSDIR\app"
  File "${APPDIR}\office-next.exe"
  File "${APPDIR}\WebView2Loader.dll"
  File "${APPDIR}\LICENSE"
  File "${APPDIR}\NOTICE"
  File "${__FILEDIR__}\..\..\USAGE_AND_PRIVACY.txt"
  IfErrors failed
  SetOutPath "$PLUGINSDIR\app\ocr-worker"
  File /r "${APPDIR}\ocr-worker\*"
  IfErrors failed

  SetOutPath "$PLUGINSDIR\app"
  ExecWait '"$OUTDIR\office-next.exe"' $0
  IfErrors failed
  SetOutPath "$TEMP"
  SetErrorLevel $0
  Goto done

  failed:
    SetOutPath "$TEMP"
    MessageBox MB_OK|MB_ICONSTOP "程序展开或启动失败。请检查临时目录的可用空间及 WebView2 运行时。"
    SetErrorLevel 1
  done:
SectionEnd
