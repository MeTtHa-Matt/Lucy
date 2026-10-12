!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\LUCY.lnk" "$INSTDIR\lucy.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\LUCY.lnk"
!macroend
