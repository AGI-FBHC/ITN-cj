# 构建并直接跑一遍 xbot 演示（开发时用）
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\..\scripts\env.ps1"

$proj = Resolve-Path "$PSScriptRoot\.."
Push-Location $proj
try {
    cjpm build
    if ($LASTEXITCODE -ne 0) { throw "cjpm build 失败" }
    & ".\target\release\bin\main.exe"
} finally {
    Pop-Location
}
