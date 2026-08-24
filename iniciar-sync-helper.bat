@echo off
cd /d "%~dp0"
echo Iniciando Sync Helper TPV...
echo.
echo Servidor en: http://localhost:3456
echo Archivo: %%APPDATA%%\tpv-peluqueria\sync\appointments.json
echo.
echo Para detenerlo, cierra esta ventana.
echo ==========================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-sync-appdata.ps1"
pause
