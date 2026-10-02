; baritoad's installer hooks (tauri.bundle.json).
;
; The app installs per machine (Program Files\baritoad); per-user data lives in
; %LOCALAPPDATA%\baritoad (karaoke-core paths.rs), not under the identifier,
; so the uninstaller's "Delete the application data" box needs telling where
; it is. Unticked (the default), and on updates, the library stays.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$LOCALAPPDATA\baritoad"
  ${EndIf}
!macroend
