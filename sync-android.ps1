$ErrorActionPreference = 'SilentlyContinue'

function Get-LocalIP {
    $ips = @()
    Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.InterfaceAlias -notlike '*Loopback*' } | ForEach-Object {
        $ips += $_.IPAddress
    }
    return $ips[0]
}

$syncFile = "C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\sync\appointments.json"
$wwwDir = "C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\android-agenda\www"

Write-Host "=== Sincronizar TPV Windows con App Android ===" -ForegroundColor Cyan

$ip = Get-LocalIP
if (-not $ip) {
    Write-Host "ERROR: No se pudo determinar la IP del equipo" -ForegroundColor Red
    exit 1
}
Write-Host "IP detectada: $ip" -ForegroundColor Green

$serverUrl = "http://$($ip):3456"

$json = Get-Content $syncFile -Raw
if ($json -match '^\s*{') {
    Write-Host "Archivo JSON válido" -ForegroundColor Green
} else {
    Write-Host "ADVERTENCIA: Posible problema con el JSON" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Datos en el servidor sync:" -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "$serverUrl/health" -TimeoutSec 5
    Write-Host "  Clientes: $($health.clients)" -ForegroundColor White
    Write-Host "  Servicios: $($health.services)" -ForegroundColor White
    Write-Host "  Empleados: $($health.employees)" -ForegroundColor White
    Write-Host "  Productos: $($health.products)" -ForegroundColor White
    Write-Host "  Secciones: $((Get-Content $syncFile -Raw | ConvertFrom-Json).sections.Count)" -ForegroundColor White
    Write-Host "  Proveedores: $((Get-Content $syncFile -Raw | ConvertFrom-Json).providers.Count)" -ForegroundColor White
} catch {
    Write-Host "  No se pudo conectar al servidor sync" -ForegroundColor Yellow
    Write-Host "  Asegúrate de que sync-helper.js esté ejecutándose" -ForegroundColor Yellow
}

$configFile = "$wwwDir\sync-config.json"
$config = @{
    serverUrl = $serverUrl
    lastSync = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json

Set-Content -Path $configFile -Value $config -Encoding UTF8
Write-Host ""
Write-Host "Configuración guardada en: $configFile" -ForegroundColor Green

$indexFile = "$wwwDir\index.html"
$content = Get-Content $indexFile -Raw -Encoding UTF8

if ($content -match 'const\s+SYNC_SERVER\s*=') {
    $content = $content -replace 'const\s+SYNC_SERVER\s*=\s*[^;]+;', "const SYNC_SERVER = '$serverUrl';"
} else {
    $content = $content -replace '(const\s+API\s*=\s*window\.location\.origin;)', "`$1`nconst SYNC_SERVER = '$serverUrl';"
}

if ($content -notmatch 'const\s+API\s*=\s*window\.location\.origin;') {
    Write-Host "ADVERTENCIA: No se encontró la línea 'const API = window.location.origin;'" -ForegroundColor Yellow
}

Set-Content -Path $indexFile -Value $content -Encoding UTF8
Write-Host "index.html actualizado con servidor: $serverUrl" -ForegroundColor Green

Write-Host ""
Write-Host "=== Para sincronizar la app Android ===" -ForegroundColor Cyan
Write-Host "1. Asegúrate de que el servidor sync-helper.js esté ejecutándose en este PC" -ForegroundColor White
Write-Host "2. Compila la app Android de nuevo" -ForegroundColor White
Write-Host "3. Instala el APK en el móvil" -ForegroundColor White
Write-Host "4. El móvil debe estar en la misma red WiFi que este PC" -ForegroundColor White
Write-Host ""
Write-Host "URL del servidor: $serverUrl" -ForegroundColor Yellow