# 跑 xbot 的单元测试（开发时用）
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\..\scripts\env.ps1"

$proj = Resolve-Path "$PSScriptRoot\.."
Push-Location $proj
try {
    cjpm test
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
