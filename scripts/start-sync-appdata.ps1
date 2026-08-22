# Helper UNICO de sincronia LOCAL (sin nube) apuntando al JSON del TPV instalado
Set-Location 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria'
$env:SYNC_FILE = "$env:APPDATA\tpv-peluqueria\sync\appointments.json"
$env:DATA_DIR  = "$env:APPDATA\tpv-peluqueria\sync"
# IMPORTANTE: deliberadamente NO se cargan SYNC_FORWARD_URL ni claves de nube
$env:SYNC_FORWARD_URL = ''
$env:WEB_API_KEY = ''
$proc = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList 'sync-helper.js' `
    -WorkingDirectory 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria' `
    -WindowStyle Hidden `
    -PassThru
$proc.Id | Out-File 'sync\.pid' -Encoding UTF8
"helper LOCAL arrancado PID $($proc.Id) (sin nube)"
