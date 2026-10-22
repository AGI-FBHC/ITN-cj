# 验证「只配对话模型、不配向量服务」也能正常用（关键词兜底检索）
param(
    [string]$EnvFile = "D:\Desktop\ITN\ITN\src\agents\.env",
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
$cfg = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $l = $_.Trim()
    if ($l -and -not $l.StartsWith('#') -and $l.Contains('=')) { $kv = $l.Split('=', 2); $cfg[$kv[0].Trim()] = $kv[1].Trim() }
}
$kbRoot = Join-Path $env:TEMP ("itn-kw-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbRoot | Out-Null
$d1 = @"
# 提示词工程

## 什么是提示词

提示词是交给模型的输入指令。把任务、约束和输出格式写清楚，模型的产出会更稳定。

## 常用手法

少样本示例：先给几个输入输出样例，让模型照着格式做。
角色设定：先说明模型扮演的角色，再给任务。
分步推理：要求模型先列步骤再给结论，适合需要推理的任务。
"@
Set-Content -Path (Join-Path $kbRoot "01-提示词.md") -Value $d1 -Encoding utf8
$d2 = @"
# 检索增强生成

## 基本流程

先把资料切片并向量化，提问时按相似度取回相关片段，再连同问题一起交给模型作答。

## 为什么能减少编造

模型只能依据取回的片段回答，且每个论断要标注出处编号。
"@
Set-Content -Path (Join-Path $kbRoot "02-RAG.md") -Value $d2 -Encoding utf8

$dataDir = Join-Path $env:TEMP ("itn-kw-data-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-kw-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-kw.out") -RedirectStandardError (Join-Path $env:TEMP "itn-kw.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 300 -SkipHttpErrorCheck).Content
}

# 只配对话模型，不绑定向量模型
Api "/api/models/save" (@{ id = "real"; name = "真实端点"; baseUrl = $cfg['LLM_API_BASE']; apiKey = $cfg['LLM_API_KEY']; model = $cfg['LLM_MODEL'] } | ConvertTo-Json -Compress) | Out-Null
Api "/api/models/roles" '{ "chatModelId": "real" }' | Out-Null
Api "/api/kb/save" (@{ id = "kw"; name = "无向量库"; rootDir = $kbRoot } | ConvertTo-Json -Compress) | Out-Null

Write-Output "未绑定向量模型，直接建立索引…"
$r = Api "/api/kb/build" '{ "id": "kw" }'
Write-Output ("建索引 -> " + $r)

Write-Output "直接检索…"
$r = Api "/api/kb/search" '{ "id": "kw", "query": "少样本示例", "topK": 3 }'
$j = $r | ConvertFrom-Json
if ($j.code -eq 0) {
    Write-Output ("命中 {0} 条" -f $j.data.hits.Count)
    foreach ($h in $j.data.hits) { Write-Output ("  [{0}] {1} > {2}  score={3}" -f $h.docTitle, $h.headingPath, $h.docPath, [math]::Round($h.score,3)) }
} else { Write-Output ("检索失败：" + $j.message) }

Write-Output "提问（走完整问答链路）…"
$r = Api "/api/agent/ask" '{ "kbId": "kw", "question": "提示词有哪些常用手法？" }'
$j = $r | ConvertFrom-Json
Write-Output ("返回码 {0}" -f $j.code)
if ($j.code -eq 0) {
    Write-Output ("回答前 200 字: " + $j.data.answer.Substring(0, [Math]::Min(200, $j.data.answer.Length)))
    Write-Output ("出处条数: {0}" -f $j.data.citations.Count)
} else { Write-Output ("失败：" + $j.message) }
$core.Kill()
