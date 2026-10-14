@echo off
rem lumin launcher. ASCII-only ON PURPOSE.
rem A .cmd with non-ASCII bytes plus chcp makes cmd.exe mis-track its own file
rem position and execute garbage (symptom: repeated "'m' is not recognized").
rem Put the chcp first, keep the file ASCII, and keep the docs in README instead.
chcp 65001 > nul
set "LUMIN_HOME=%~dp0.."
set "LUMIN_EXE=%LUMIN_HOME%\dist\lumin-demo\lumin-demo.exe"
if not exist "%LUMIN_EXE%" goto lumin_missing
if "%~1"=="demo" goto lumin_demo
"%LUMIN_EXE%" chat %*
goto lumin_end
:lumin_demo
"%LUMIN_EXE%" demo %2 %3 %4 %5
goto lumin_end
:lumin_missing
echo [lumin] launcher: green bundle not found:
echo   %LUMIN_EXE%
echo [lumin] build it first:  pwsh -File "%LUMIN_HOME%\scripts\package-demo.ps1"
goto lumin_end
:lumin_end
