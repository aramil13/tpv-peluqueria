# Auto-generado por instalar-autoarranque-sync.ps1
# Arranca sync-helper.js con las variables de entorno correctas
Set-Location 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria'
$env:SYNC_FILE = 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\sync\appointments.json'
if (Test-Path 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\.env.local') {
    Get-Content 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\.env.local' | ForEach-Object {
        if ($_ -match '^\s*([^#=]+?)\s*=\s*(.+?)\s*$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
        }
    }
}
$env:SYNC_FILE = 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\sync\appointments.json'
# Arrancar node en segundo plano y guardar PID
$proc = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList 'sync-helper.js' `
    -WorkingDirectory 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria' `
    -WindowStyle Hidden `
    -PassThru
$proc.Id | Out-File (Join-Path 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria' 'sync\.pid') -Encoding UTF8
