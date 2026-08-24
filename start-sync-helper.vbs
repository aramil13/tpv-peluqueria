Set WshShell = CreateObject("WScript.Shell")
' Arranque unico: delega en scripts\start-sync-appdata.ps1 (BD viva en APPDATA)
WshShell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\scripts\start-sync-appdata.ps1""", 0, False
