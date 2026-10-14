# 连真实模型聊天（开发用）。配置优先取环境变量，其次 lumin\.env.local。
param(
    [string]$Model = '',
    [string]$Mode = '',
    [string]$Workspace = '',
    [string]$AskFile = '',
    [switch]$AllowExec
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"

$proj = Resolve-Path "$PSScriptRoot\.."
Push-Location $proj
try {
    cjpm build
    if ($LASTEXITCODE -ne 0) { throw "cjpm build 失败" }
    $cliArgs = @('chat')
    if ($Model) { $cliArgs += @('--model', $Model) }
    if ($Mode) { $cliArgs += @('--mode', $Mode) }
    if ($Workspace) { $cliArgs += @('--workspace', $Workspace) }
    if ($AskFile) { $cliArgs += @('--ask-file', $AskFile) }
    if ($AllowExec) { $cliArgs += '--allow-exec' }
    & ".\target\release\bin\main.exe" @cliArgs
} finally {
    Pop-Location
}
