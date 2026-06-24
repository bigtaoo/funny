@echo off
chcp 65001 >nul
REM Double-click to install the "Export Layers (Cropped to Content)" GIMP 3.x plugin.
REM Calls install.ps1 in the same folder (bypassing execution policy), then waits for a key.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
pause
