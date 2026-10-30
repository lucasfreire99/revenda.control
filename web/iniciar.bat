@echo off
cd /d "%~dp0"
start "Servidor HTTP" python -m http.server 8001
timeout /t 1 >nul
start "" http://localhost:8001