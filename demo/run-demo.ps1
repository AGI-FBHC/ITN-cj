# 启动一场隔离的 Agent 演示。
#
#   .\demo\run-demo.ps1                 # 开发态（dist\core 已更新），独立 profile
#   .\demo\run-demo.ps1 -Packaged       # 用 dist\Lumin-0.9.4\Lumin.exe
#   .\demo\run-demo.ps1 -Record         # 把这一场的模型响应录下来
#   .\demo\run-demo.ps1 -Replay .\demo\recordings\xxx.jsonl
#
# 演示 profile 与日常使用的数据完全隔离；删除 demo\profile 即可当没发生过。
param(
    [switch]$Packaged,
    [switch]$Record,
    [string]$Replay = "",
    [string]$Profile = ""
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path "$PSScriptRoot\.."
if (-not $Profile) { $Profile = Join-Path $repo 'demo\profile' }
if (-not (Test-Path -LiteralPath $Profile)) { New-Item -ItemType Directory -Force -Path $Profile | Out-Null }

$env:LOCALAPPDATA = $Profile
$env:LUMIN_DEMO = '1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if ($Record) {
    $dir = Join-Path $repo 'demo\recordings'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $env:LUMIN_AGENT_RECORD = $dir
    Write-Host "录制目录：$dir"
}
if ($Replay) {
    $resolved = (Resolve-Path -LiteralPath $Replay).Path
    $env:LUMIN_AGENT_REPLAY = $resolved
    Write-Host "回放素材：$resolved"
}

Write-Host "演示数据目录：$Profile"
Write-Host "提示：启动后在「设置 → 智能体 → 演示模式」点“准备演示环境”。"

$packaged = Join-Path $repo 'dist\Lumin-0.9.4\Lumin.exe'
if ($Packaged -and (Test-Path -LiteralPath $packaged)) {
    & $packaged "--user-data-dir=$Profile"
    exit $LASTEXITCODE
}

Push-Location (Join-Path $repo 'shell')
try {
    & .\node_modules\.bin\electron.cmd . "--user-data-dir=$Profile"
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
