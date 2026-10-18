@echo off
rem lumin desktop launcher. ASCII-only ON PURPOSE.
rem A .cmd with non-ASCII bytes plus chcp makes cmd.exe mis-track its own file
rem position and execute garbage. Keep this file pure ASCII + CRLF.
chcp 65001 > nul
cd /d "%~dp0"
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" goto lumin_electron_missing
start "" "%ELECTRON%" .
goto lumin_end
:lumin_electron_missing
echo [lumin] electron.exe not found under node_modules.
echo   Run:  npm install   in this folder first.
pause
:lumin_end
