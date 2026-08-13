# ==============================================================================
# Instala el autoarranque del sync-helper TPV (tarea programada de Windows)
# Ejecutar como Administrador o como usuario normal (se instala en HKCU)
# ==============================================================================

$ErrorActionPreference = 'Stop'

# Ruta del directorio del proyecto (donde está sync-helper.js)
$ProjectDir = Split-Path -Parent $PSScriptRoot

# Buscar node.exe
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCmd) { $nodeCmd.Source } else { $null }
if (-not $nodePath) {
    Write-Host "ERROR: No se encontró node.exe en el PATH." -ForegroundColor Red
    Write-Host "Instala Node.js desde https://nodejs.org y vuelve a ejecutar este script." -ForegroundColor Yellow
    exit 1
}

Write-Host "Usando Node.js: $nodePath" -ForegroundColor Cyan
Write-Host "Directorio proyecto: $ProjectDir" -ForegroundColor Cyan

$TaskName = "TPV-Peluqueria-SyncHelper"
$SyncFile = Join-Path $ProjectDir "sync\appointments.json"
$EnvFile  = Join-Path $ProjectDir ".env.local"

# Construir el script de arranque inline (evita problemas con comillas en Task Scheduler)
$WrapperScript = Join-Path $ProjectDir "scripts\start-sync-hidden.ps1"

$wrapperContent = @"
# Auto-generado por instalar-autoarranque-sync.ps1
# Arranca sync-helper.js con las variables de entorno correctas
Set-Location '$($ProjectDir -replace "'", "''")'
`$env:SYNC_FILE = '$($SyncFile -replace "'", "''")'
if (Test-Path '$($EnvFile -replace "'", "''")') {
    Get-Content '$($EnvFile -replace "'", "''")' | ForEach-Object {
        if (`$_ -match '^\s*([^#=]+?)\s*=\s*(.+?)\s*$') {
            [System.Environment]::SetEnvironmentVariable(`$Matches[1], `$Matches[2])
        }
    }
}
`$env:SYNC_FILE = '$($SyncFile -replace "'", "''")'
# Arrancar node en segundo plano y guardar PID
`$proc = Start-Process -FilePath '$($nodePath -replace "'", "''")' ``
    -ArgumentList 'sync-helper.js' ``
    -WorkingDirectory '$($ProjectDir -replace "'", "''")' ``
    -WindowStyle Hidden ``
    -PassThru
`$proc.Id | Out-File (Join-Path '$($ProjectDir -replace "'", "''")' 'sync\.pid') -Encoding UTF8
"@

Set-Content -Path $WrapperScript -Value $wrapperContent -Encoding UTF8
Write-Host "Script de arranque creado: $WrapperScript" -ForegroundColor Green

# Eliminar tarea anterior si existe
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarea anterior eliminada." -ForegroundColor Yellow
}

# Crear la acción: powershell -WindowStyle Hidden -File start-sync-hidden.ps1
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$WrapperScript`"" `
    -WorkingDirectory $ProjectDir

# Disparador: al iniciar sesión el usuario actual
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Configuración: no requerir usuario conectado a red, no elevar privilegios
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -RunOnlyIfNetworkAvailable:$false `
    -StartWhenAvailable

# Registrar la tarea (para el usuario actual, sin necesitar admin si es HKCU)
try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -RunLevel Limited `
        -Force | Out-Null
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  TAREA PROGRAMADA INSTALADA CON EXITO" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Nombre: $TaskName" -ForegroundColor White
    Write-Host "  Se inicia: Al iniciar sesion ($env:USERNAME)" -ForegroundColor White
    Write-Host "  Puerto: http://localhost:3456" -ForegroundColor White
    Write-Host ""
    Write-Host "Iniciando ahora para verificar..." -ForegroundColor Yellow
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    try {
        $health = Invoke-WebRequest -Uri "http://localhost:3456/health" -UseBasicParsing -TimeoutSec 5
        Write-Host "  [OK] Sync-helper respondiendo: $($health.Content.Substring(0,[Math]::Min(120,$health.Content.Length)))..." -ForegroundColor Green
    } catch {
        Write-Host "  [!] No se pudo verificar http://localhost:3456/health - puede que tarde unos segundos en arrancar." -ForegroundColor Yellow
    }
} catch {
    Write-Host "ERROR al registrar la tarea: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Intentando sin parametros de reinicio..." -ForegroundColor Yellow
    $settings2 = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
        -RunOnlyIfNetworkAvailable:$false
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings2 `
        -RunLevel Limited `
        -Force | Out-Null
    Write-Host "Tarea registrada (sin reinicio automatico)." -ForegroundColor Green
}

Write-Host ""
Write-Host "Para desinstalar: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor Gray
