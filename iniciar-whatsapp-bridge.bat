@echo off
title Bridge WhatsApp AI - Nymara
cd /d "%~dp0"

echo ============================================
echo  Bridge WhatsApp AI - Nymara Estilistas
echo ============================================
echo.
echo Asegurate de tener el GROQ_API_KEY configurado
echo en las variables de entorno o en .env.vercel
echo.
echo El bridge necesita el sync-helper corriendo
echo en http://localhost:3456
echo.
echo Si quieres usar el servidor remoto en vez de local:
set AI_API_URL=https://nymaraestilistas/api/ai-message
echo.

if "%AI_API_URL%"=="" (
    echo Usando servidor local: http://localhost:3456
    echo Asegurate de que sync-helper esta corriendo
    echo.
) else (
    echo Usando servidor: %AI_API_URL%
)

echo Escanea el QR con WhatsApp (Ajustes ^> Dispositivos vinculados)
echo Para cambiar de numero, borra la carpeta wa_auth/ y ejecuta de nuevo
echo.
echo ============================================
echo.

node wa-bridge.js

pause
