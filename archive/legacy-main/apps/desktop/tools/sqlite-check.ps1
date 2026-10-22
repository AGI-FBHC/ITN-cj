# SQLite 数据层回归检查：建表/中文读写/事务/BLOB 向量/中文 SQL 词法
# 依赖 third_party/probe（内置驱动的探针工程），它是驱动在本项目里的回归用例集。
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\scripts\env.ps1"

Push-Location "$PSScriptRoot\..\third_party\probe"
try {
    cjpm build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "探针编译失败" }
    $out = & ".\target\release\bin\main.exe"
    $out | Write-Output
    $summary = ($out | Select-String -Pattern 'PASS=(\d+) FAIL=(\d+)').Matches
    if (-not $summary) { throw "没有拿到 PASS/FAIL 汇总" }
    $passed = [int]$summary[0].Groups[1].Value
    $failed = [int]$summary[0].Groups[2].Value
    if ($failed -ne 0) { throw "SQLite 数据层检查未通过：FAIL=$failed" }
    Write-Output "SQLite 数据层检查通过：PASS=$passed"
} finally {
    Pop-Location
}