@echo off
cd /d "%~dp0"
echo Arrancando Sync Helper...
start "Sync Helper" node sync-helper.js
timeout /t 2 /nobreak >nul
echo Arrancando WhatsApp Bridge...
start "WhatsApp Bridge" node wa-bridge.js
echo.
echo Ambos servicios iniciados. Cierra esta ventana si quieres.
echo Sync Helper: http://localhost:3456
