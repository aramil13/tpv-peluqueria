@echo off
chcp 65001 > NUL

:: Auto-elevacion a Administrador si no se tienen permisos
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process cmd -ArgumentList '/c ""%~f0""' -Verb RunAs"
    exit /b
)

title Desinstalador TPV-Builder2 1.11.0
echo =======================================================================
echo           DESINSTALADOR DE TPV-BUILDER2 / TPV PELUQUERIA
echo =======================================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Desinstalar-TPV-Builder2.ps1"
echo.
echo Presione cualquier tecla para salir...
pause > NUL
