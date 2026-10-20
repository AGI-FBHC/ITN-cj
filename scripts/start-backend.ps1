# Starts the already-built Cangjie service in the background with the local env file.
# Use run-backend.ps1 when you want a foreground process that rebuilds first.
param(
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'
$exe = Join-Path $root 'services/learning/target/release/bin/main.exe'

if ($Stop) {
    Get-Process -Name main -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
    Write-Output '后端已停止'
    return
}

if (-not (Test-Path -LiteralPath $exe)) { throw "Missing $exe. Run scripts/run-backend.ps1 once to build it." }
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing $envFile" }

. (Join-Path $PSScriptRoot 'env.ps1')

Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
    }
}

$log = Join-Path $root 'backend.log'
$err = Join-Path $root 'backend.err.log'
$process = Start-Process -FilePath $exe -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
if ($process.HasExited) {
    Write-Output "后端启动失败，错误日志: $err"
    Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}
Write-Output "后端已启动 (pid $($process.Id)): http://127.0.0.1:8312"
Write-Output "日志: $log"
