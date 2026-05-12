Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria"" && node sync-helper.js", 0, False
