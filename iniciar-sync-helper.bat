@echo off
cd /d "%~dp0"
echo Iniciando Sync Helper TPV...
echo.
echo Servidor en: http://localhost:3456
echo Archivo: %~dp0sync\appointments.json
echo.
echo Para detenerlo, cierra esta ventana.
echo ==========================================
node sync-helper.js
pause