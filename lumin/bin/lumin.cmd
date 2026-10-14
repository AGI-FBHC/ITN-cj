@echo off
rem lumin 启动器：在任何目录敲 lumin 就进对话，**当前目录就是工作区**（Pi 的 cwd 语义）
rem 用法： lumin            进对话
rem        lumin demo       离线演示（不联网、不读写文件）
rem        lumin --trust / --workspace X / --mode agent --allow-exec … 参数原样传给 CLI
chcp 65001 > nul
set "LUMIN_HOME=%~dp0.."
if "%~1"=="demo" (
  "%LUMIN_HOME%\dist\lumin-demo\lumin-demo.exe" demo %2 %3 %4 %5
) else (
  "%LUMIN_HOME%\dist\lumin-demo\lumin-demo.exe" chat %*
)
