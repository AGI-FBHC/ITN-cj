Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetDatablockOptimize on
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

Name "Lumin"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Lumin"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "InstallLocation"
BrandingText "Lumin · 智训云枢"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "Lumin 安装程序"
VIAddVersionKey /LANG=2052 "FileDescription" "Lumin 桌面学习工作台安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Lumin 项目团队"

!define MUI_ICON "${INSTALLER_ICON}"
!define MUI_UNICON "${INSTALLER_ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 Lumin"
!define MUI_WELCOMEPAGE_TEXT "Lumin 桌面学习工作台将安装到此电脑。$\r$\n$\r$\n程序包含运行所需组件，无需单独安装仓颉、Node.js 或 Python。$\r$\n$\r$\n已有知识库、会话和模型设置保留在用户数据目录中。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Lumin.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_TEXT "启动 Lumin"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro CheckRunning PREFIX
  IfFileExists "$INSTDIR\Lumin.exe" 0 ${PREFIX}done
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Lumin.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  StrCmp $0 -1 ${PREFIX}blocked
  System::Call 'kernel32::CloseHandle(p r0)'
  IfFileExists "$INSTDIR\resources\kernel\lumin-core.exe" 0 ${PREFIX}done
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\resources\kernel\lumin-core.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  StrCmp $0 -1 ${PREFIX}blocked
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto ${PREFIX}done
  ${PREFIX}blocked:
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先退出此目录中的 Lumin，再继续安装或卸载。若已经退出，请检查目录写入权限。"
    SetErrorLevel 2
    Abort
  ${PREFIX}done:
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "Lumin 需要 Windows 10/11 64 位系统。"
    SetErrorLevel 1633
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastBuild} 18362
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "Lumin 需要 Windows 10 1903 或更新版本，或 Windows 11。"
    SetErrorLevel 1633
    Abort
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Lumin ${VERSION}（必需）" MainSection
  SectionIn RO
  !insertmacro CheckRunning install_
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${INPUT_DIR}\*"
  File /oname=Lumin.ico "${INSTALLER_ICON}"
  IfErrors 0 +3
  SetErrorLevel 5
  Abort
  WriteUninstaller "$INSTDIR\Uninstall Lumin.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "DisplayName" "Lumin"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "Publisher" "Lumin 项目团队"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "DisplayIcon" "$INSTDIR\Lumin.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "UninstallString" '$\"$INSTDIR\Uninstall Lumin.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "QuietUninstallString" '$\"$INSTDIR\Uninstall Lumin.exe$\" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "EstimatedSize" ${INSTALL_SIZE_KB}
  WriteRegStr HKCU "Software\Classes\lumin" "" "URL:Lumin"
  WriteRegStr HKCU "Software\Classes\lumin" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\lumin\DefaultIcon" "" "$INSTDIR\Lumin.ico"
  WriteRegStr HKCU "Software\Classes\lumin\shell\open\command" "" '$\"$INSTDIR\Lumin.exe$\" $\"%1$\"'
  CreateDirectory "$SMPROGRAMS\Lumin"
  CreateShortcut "$SMPROGRAMS\Lumin\Lumin.lnk" "$INSTDIR\Lumin.exe" "" "$INSTDIR\Lumin.ico"
  CreateShortcut "$SMPROGRAMS\Lumin\卸载 Lumin.lnk" "$INSTDIR\Uninstall Lumin.exe" "" "$INSTDIR\Lumin.ico"
SectionEnd

Section /o "创建桌面快捷方式"
  CreateShortcut "$DESKTOP\Lumin.lnk" "$INSTDIR\Lumin.exe" "" "$INSTDIR\Lumin.ico"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "DesktopShortcut" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  !insertmacro CheckRunning uninstall_
FunctionEnd

Section "Uninstall"
  ; Remove only files shipped by this installer, never recursively erase a chosen directory.
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Lumin.ico"
  Delete "$INSTDIR\Uninstall Lumin.exe"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "InstallLocation"
  StrCmp $0 $INSTDIR 0 registry_done
  ReadRegDWORD $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin" "DesktopShortcut"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin"
  Delete "$SMPROGRAMS\Lumin\Lumin.lnk"
  Delete "$SMPROGRAMS\Lumin\卸载 Lumin.lnk"
  RMDir "$SMPROGRAMS\Lumin"
  StrCmp $1 1 0 +2
  Delete "$DESKTOP\Lumin.lnk"
  registry_done:
  ReadRegStr $0 HKCU "Software\Classes\lumin\shell\open\command" ""
  StrCmp $0 '$\"$INSTDIR\Lumin.exe$\" $\"%1$\"' 0 protocol_done
  DeleteRegKey HKCU "Software\Classes\lumin"
  protocol_done:
  ; %LOCALAPPDATA%\Lumin and user-selected knowledge folders are intentionally retained.
SectionEnd
