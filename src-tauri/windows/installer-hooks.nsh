!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "Stremera"
  !insertmacro CheckIfAppIsRunning "streamy.exe" "Streamy"

  ReadRegStr $R0 SHCTX "Software\vamptux\Stremera" ""
  ${If} $R0 == ""
    ReadRegStr $R0 SHCTX "Software\vamptux\Streamy" ""
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Streamy"
  DeleteRegKey SHCTX "Software\vamptux\Streamy"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Streamy"

  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\streamy.exe"

    ${If} ${FileExists} "$DESKTOP\Streamy.lnk"
      !insertmacro UnpinShortcut "$DESKTOP\Streamy.lnk"
      Delete "$DESKTOP\Streamy.lnk"
    ${EndIf}

    ${If} ${FileExists} "$SMPROGRAMS\Streamy.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\Streamy.lnk"
      Delete "$SMPROGRAMS\Streamy.lnk"
    ${EndIf}

    ${If} ${FileExists} "$SMPROGRAMS\Streamy\Streamy.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\Streamy\Streamy.lnk"
      Delete "$SMPROGRAMS\Streamy\Streamy.lnk"
    ${EndIf}
    RMDir "$SMPROGRAMS\Streamy"

    !if "${STARTMENUFOLDER}" != ""
      CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
      CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    !else
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !endif

    ${If} $NoShortcutMode != 1
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend