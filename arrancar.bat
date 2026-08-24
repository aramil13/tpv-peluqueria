@echo off
title Nymara Estilistas - Servicios
cd /d "%~dp0"

echo ============================================
echo  Nymara Estilistas - Sync Helper
echo ============================================
echo.
echo Cerrando servicios anteriores...
taskkill /f /fi "WINDOWTITLE eq Sync Helper" /t >nul 2>nul
timeout /t 1 /nobreak >nul
echo.
echo Arrancando Sync Helper (BD viva en %%APPDATA%%\tpv-peluqueria)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-sync-appdata.ps1"
timeout /t 2 /nobreak >nul

echo.
echo ============================================
echo  Sync Helper iniciado
echo ============================================
echo.
echo  Sync Helper: http://localhost:3456
echo.
pause
