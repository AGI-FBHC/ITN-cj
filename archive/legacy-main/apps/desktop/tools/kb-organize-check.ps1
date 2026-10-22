# 知识库"整理"自测：让模型给出一份教学目录 → 建索引按它组织 → 能清除。
# 用 tools/mock-organize 当模型（离线，固定就回两章，其中一条路径是编造的）。
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }
function FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}

$kbDir = Join-Path $env:TEMP ("itn-org-kb-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $env:TEMP ("itn-org-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbDir, $dataDir | Out-Null
# 两份没有标题的纯文本：默认分章是"按文件名各一章"，整理后应变成模型给的章名
$t1 = "开场先讲这门课要解决的问题。" + [char]10 + "这里再补一句背景，够长以便切片。" + [char]10
$t2 = "收尾讲怎么把学到的东西用起来。" + [char]10 + "再补一句练习建议，够长以便切片。" + [char]10
[IO.File]::WriteAllText((Join-Path $kbDir "01.md"), $t1, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $kbDir "02.md"), $t2, [Text.UTF8Encoding]::new($false))

$mockPort = FreePort
$mock = Start-Process -FilePath "python" -ArgumentList (Join-Path $PSScriptRoot "mock-organize\server.py"), "$mockPort" -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1000
$portFile = Join-Path $env:TEMP ("itn-org-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden
$port = $null
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $core; Stop-Quiet $mock; throw "内核没起来" }
$base = "http://127.0.0.1:$port"
function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 6
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    return (Invoke-WebRequest -Uri ("$base" + $path) -Method Post -Body $bytes -ContentType "application/json" -UseBasicParsing -TimeoutSec 120 -SkipHttpErrorCheck).Content | ConvertFrom-Json
}
$failed = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output ("  PASS  " + $name + "  " + $detail) }
    else { Write-Output ("  FAIL  " + $name + "  " + $detail); $script:failed++ }
}
function Chapters($kbId) {
    return @((Post '/api/study/tree' @{ kbId = $kbId }).data.chapters | ForEach-Object { [string]$_.name })
}

try {
    Post '/api/models/save' @{ id = 'org'; name = 'org-mock'; baseUrl = ("http://127.0.0.1:" + $mockPort + "/v1"); apiKey = 'k'; model = 'mock-organize' } | Out-Null
    Post '/api/models/roles' @{ chatModelId = 'org'; embedModelId = ''; chunkModelId = '' } | Out-Null
    Post '/api/kb/save' @{ id = 'o'; name = '待整理的课'; rootDir = $kbDir } | Out-Null
    Post '/api/kb/build' @{ id = 'o' } | Out-Null
    $before = Chapters 'o'
    Check '整理前：按材料自己分章（两份文件各一章）' ($before.Count -eq 2) ($before -join ' / ')

    Write-Output "== 让 lumin 整理 =="
    $r = Post '/api/kb/organize' @{ id = 'o' }
    $note = [string]$r.data.note
    Check '整理成功' ($r.code -eq 0 -and $r.data.ok -eq $true) ('chapters=' + $r.data.chapters + ' docs=' + $r.data.docs + ' note=' + $note.Substring(0, [Math]::Min(16, $note.Length)))
    Check '模型编造的路径被丢掉（dropped=1）' ([int]$r.data.dropped -eq 1) ('dropped=' + $r.data.dropped)
    $outlinePath = Join-Path (Join-Path (Join-Path $dataDir 'kb') 'o') 'outline.json'
    Check 'outline.json 真的落盘了' (Test-Path $outlinePath) 'kb/o/outline.json'

    Post '/api/kb/build' @{ id = 'o' } | Out-Null
    $after = Chapters 'o'
    Check '重建索引后章节名来自模型给的目录' (($after -join '|') -eq '第一章 入场|第二章 出场') ($after -join ' / ')
    $st = Post '/api/kb/stats' @{ id = 'o' }
    Check '统计里带上谁整理的与章数' (([string]$st.data.organizedBy) -eq 'lumin' -and [int]$st.data.outlineChapters -eq 2) ('by=' + $st.data.organizedBy + ' chapters=' + $st.data.outlineChapters)

    Write-Output "== 清除整理 =="
    Post '/api/kb/organize' @{ id = 'o'; clear = $true } | Out-Null
    Post '/api/kb/build' @{ id = 'o' } | Out-Null
    $back = Chapters 'o'
    Check '清除后回到材料自己的分章' (($back -join '|') -eq ($before -join '|')) ($back -join ' / ')
} finally {
    Stop-Quiet $core
    Stop-Quiet $mock
}

Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
