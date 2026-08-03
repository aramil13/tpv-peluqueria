# ==============================================================================
# Script de Desinstalacion Completa de TPV-Builder2 / TPV Peluqueria v1.11.0
# ==============================================================================

[CmdletBinding()]
param(
    [switch]$KeepUserData = $false, # Si se activa, conserva los datos locales en %APPDATA%
    [switch]$Silent = $false        # Ejecuta la desinstalacion de forma silenciosa
)

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "       DESINSTALADOR DE TPV-BUILDER2 / TPV PELUQUERIA (v1.11.0)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Detener procesos en ejecucion
Write-Host "[1/5] Cerrando procesos del TPV y servicios asociados..." -ForegroundColor Yellow
$processNames = @("tpv-peluqueria", "TPV-Builder2", "electron")
foreach ($procName in $processNames) {
    $procs = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "  -> Deteniendo proceso: $procName" -ForegroundColor Yellow
        Stop-Process -Name $procName -Force -ErrorAction SilentlyContinue
    }
}

# Detener procesos Node que esten ejecutando sync-helper
$nodeProcs = Get-WmiObject Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
foreach ($p in $nodeProcs) {
    if ($p.CommandLine -like "*sync-helper.js*" -or $p.CommandLine -like "*access-sync.js*") {
        Write-Host "  -> Deteniendo proceso de sincronizacion background (PID: $($p.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 1
Write-Host "  [OK] Procesos finalizados." -ForegroundColor Green

# 2. Buscar desinstalador oficial en Registro de Windows
Write-Host "`n[2/5] Buscando desinstalador en el Registro de Windows..." -ForegroundColor Yellow

$regPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

$installedApp = $null
foreach ($path in $regPaths) {
    $found = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue | Where-Object {
        $_.PSChildName -eq "com.peluqueria.tpv" -or
        $_.DisplayName -like "*TPV*Peluqueria*" -or
        $_.DisplayName -like "*tpv-peluqueria*" -or
        $_.DisplayName -like "*TPV-Builder2*"
    }
    if ($found) {
        $installedApp = $found
        break
    }
}

$uninstalled = $false

if ($installedApp -and $installedApp.UninstallString) {
    Write-Host "  -> Aplicacion encontrada: $($installedApp.DisplayName) (Version: $($installedApp.DisplayVersion))" -ForegroundColor Cyan
    Write-Host "  -> Comando registrado: $($installedApp.UninstallString)" -ForegroundColor Gray

    $rawCmd = $installedApp.UninstallString.Trim()
    $exePath = ""
    $extraArgs = ""

    if ($rawCmd.StartsWith('"')) {
        $endQuote = $rawCmd.IndexOf('"', 1)
        if ($endQuote -gt 1) {
            $exePath = $rawCmd.Substring(1, $endQuote - 1)
            $extraArgs = $rawCmd.Substring($endQuote + 1).Trim()
        }
    } else {
        $spaceIdx = $rawCmd.IndexOf(' ')
        if ($spaceIdx -gt 0) {
            $exePath = $rawCmd.Substring(0, $spaceIdx)
            $extraArgs = $rawCmd.Substring($spaceIdx + 1).Trim()
        } else {
            $exePath = $rawCmd
        }
    }

    if (Test-Path $exePath) {
        Write-Host "  -> Ejecutable desinstalador: $exePath" -ForegroundColor Cyan
        $argList = @()
        if ($extraArgs) { $argList += $extraArgs }
        if ($Silent) { $argList += "/S" }

        $argString = $argList -join " "
        Write-Host "  -> Ejecutando desinstalador oficial NSIS ($argString)..." -ForegroundColor Yellow
        
        $proc = Start-Process -FilePath $exePath -ArgumentList $argString -Wait -PassThru
        if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq $null) {
            Write-Host "  [OK] Desinstalador oficial completado." -ForegroundColor Green
            $uninstalled = $true
        } else {
            Write-Host "  [!] El desinstalador retorno codigo: $($proc.ExitCode)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  -> No se encontro entrada oficial en el registro." -ForegroundColor Gray
}

# 3. Eliminar archivos en rutas habituales de instalacion
Write-Host "`n[3/5] Limpiando carpetas de programa instaladas..." -ForegroundColor Yellow

$installPaths = @(
    "$env:LOCALAPPDATA\Programs\tpv-peluqueria",
    "$env:LOCALAPPDATA\Programs\TPV-Builder2",
    "$env:ProgramFiles\tpv-peluqueria",
    "$env:ProgramFiles(x86)\tpv-peluqueria",
    "$env:LOCALAPPDATA\tpv-peluqueria-updater"
)

foreach ($path in $installPaths) {
    if (Test-Path $path) {
        Write-Host "  -> Eliminando directorio: $path" -ForegroundColor Yellow
        Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 4. Eliminar accesos directos (Escritorio, Menu Inicio y Inicio automatico)
Write-Host "`n[4/5] Limpiando accesos directos..." -ForegroundColor Yellow

$shortcuts = @(
    "$env:USERPROFILE\Desktop\TPV Peluqueria.lnk",
    "$env:USERPROFILE\Desktop\tpv-peluqueria.lnk",
    "$env:USERPROFILE\Desktop\TPV-Builder2.lnk",
    "$env:USERPROFILE\Desktop\Gestor Citas TPV.lnk",
    "$env:PUBLIC\Desktop\TPV Peluqueria.lnk",
    "$env:PUBLIC\Desktop\tpv-peluqueria.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\tpv-peluqueria.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\TPV Peluqueria.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\iniciar-sync-helper.bat.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\tpv-peluqueria.lnk"
)

foreach ($sc in $shortcuts) {
    if (Test-Path $sc) {
        Write-Host "  -> Borrando acceso directo: $sc" -ForegroundColor Yellow
        Remove-Item -Path $sc -Force -ErrorAction SilentlyContinue
    }
}

# Limpiar carpeta en Menu Inicio si existe
$startMenuFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\tpv-peluqueria"
if (Test-Path $startMenuFolder) {
    Remove-Item -Path $startMenuFolder -Recurse -Force -ErrorAction SilentlyContinue
}

# 5. Limpieza de datos de usuario (%APPDATA%\tpv-peluqueria)
Write-Host "`n[5/5] Gestion de datos de aplicacion y cache..." -ForegroundColor Yellow

$appDataFolder = "$env:APPDATA\tpv-peluqueria"

if (Test-Path $appDataFolder) {
    if ($KeepUserData) {
        Write-Host "  -> Se han conservado los datos de usuario en: $appDataFolder" -ForegroundColor Cyan
    } else {
        Write-Host "  -> Eliminando cache y datos locales en: $appDataFolder" -ForegroundColor Yellow
        Remove-Item -Path $appDataFolder -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  [OK] Datos locales eliminados." -ForegroundColor Green
    }
} else {
    Write-Host "  -> No se encontraron datos en AppData." -ForegroundColor Gray
}

# Limpiar entrada residual del registro si quedara
Remove-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.peluqueria.tpv" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.peluqueria.tpv" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n========================================================================" -ForegroundColor Green
Write-Host "  DESINSTALACION Y LIMPIEZA DE TPV-BUILDER2 COMPLETADA CON EXITO!" -ForegroundColor Green
Write-Host "========================================================================" -ForegroundColor Green
Write-Host ""
