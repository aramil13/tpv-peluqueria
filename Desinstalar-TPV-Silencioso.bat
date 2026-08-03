@echo off
chcp 65001 > NUL

:: Auto-elevacion a Administrador si no se tienen permisos
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process cmd -ArgumentList '/c ""%~f0""' -Verb RunAs"
    exit /b
)

:: Ejecucion del desinstalador de forma 100% silenciosa
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Desinstalar-TPV-Builder2.ps1" -Silent
