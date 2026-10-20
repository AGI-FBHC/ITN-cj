# Starts the Vite dev server in the background. Both the learner app and /admin use it.
param(
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Stop) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like '*vite*' -and $_.CommandLine -like '*zhixun-yunshu-28801-20261020*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Output '前端已停止'
    return
}

$log = Join-Path $root 'frontend.log'
$err = Join-Path $root 'frontend.err.log'
$process = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory (Join-Path $root 'apps/web') `
    -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 6
if ($process.HasExited) {
    Write-Output "前端启动失败，错误日志: $err"
    Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}
Write-Output "前端已启动 (pid $($process.Id)): http://127.0.0.1:3006/"
Write-Output '管理端: http://127.0.0.1:3006/admin'
Write-Output "日志: $log"
