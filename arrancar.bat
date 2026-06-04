@echo off
title Nymara Estilistas - Servicios
cd /d "%~dp0"

echo ============================================
echo  Nymara Estilistas - Arranque de servicios
echo ============================================
echo.
echo Cerrando servicios anteriores...
taskkill /f /fi "WINDOWTITLE eq Sync Helper" /t >nul 2>nul
taskkill /f /fi "WINDOWTITLE eq WhatsApp Bridge" /t /im node.exe >nul 2>nul
timeout /t 1 /nobreak >nul
echo.
echo Arrancando Sync Helper...
start "Sync Helper" node sync-helper.js
timeout /t 2 /nobreak >nul

echo Arrancando WhatsApp Bridge...
start "WhatsApp Bridge" node wa-bridge.js
timeout /t 2 /nobreak >nul

echo.
echo ============================================
echo  Servicios iniciados
echo ============================================
echo.
echo  Sync Helper:     http://localhost:3456
echo  Bridge WhatsApp: http://localhost:3457
echo.
echo  IMPORTANTE: Para conectar WhatsApp:
echo  1. Abre la ventana "WhatsApp Bridge"
echo  2. Escanea el codigo QR con WhatsApp (Ajustes ^> Dispositivos vinculados)
echo  3. El QR se actualiza cada 20s
echo  4. Para cambiar de numero, borra la carpeta wa_auth/ y reinicia
echo.
echo  Cierra esta ventana si quieres (los servicios siguen corriendo).
echo ============================================
echo.
