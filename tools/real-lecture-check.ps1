# 用真实模型跑完整讲义生成链路（检索 → 大纲 → 逐节写作 → 引用自检 → 落盘）
param(
    [string]$EnvFile = "D:\Desktop\ITN\ITN\src\agents\.env",
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)

$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'

$cfg = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $kv = $line.Split('=', 2)
        $cfg[$kv[0].Trim()] = $kv[1].Trim()
    }
}

$kbRoot = Join-Path $env:TEMP ("itn-lec-kb-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbRoot | Out-Null

$d1 = @"
# 提示词工程基础

## 什么是提示词

提示词是交给模型的输入指令。把任务、约束和输出格式写清楚，模型的产出会更稳定。

## 常用手法

少样本示例：先给几个输入输出样例，让模型照着格式做。
角色设定：先说明模型扮演的角色，再给任务。
分步推理：要求模型先列步骤再给结论，适合需要推理的任务。

## 常见问题

指令含糊会让模型自由发挥，结果不可控。约束过多也会让模型顾此失彼，应当只保留真正必要的约束。
"@
Set-Content -Path (Join-Path $kbRoot "01-基础.md") -Value $d1 -Encoding utf8

$d2 = @"
# 检索增强生成

## 基本流程

先把资料切片并向量化，提问时按相似度取回相关片段，再连同问题一起交给模型作答。

## 为什么能减少编造

模型只能依据取回的片段回答，且每个论断要标注出处编号。资料里没有的内容应当明确说明不知道，而不是补一个看起来合理的说法。
"@
Set-Content -Path (Join-Path $kbRoot "02-RAG.md") -Value $d2 -Encoding utf8

$dataDir = Join-Path $env:TEMP ("itn-lec-data-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-lec-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-lec.out") -RedirectStandardError (Join-Path $env:TEMP "itn-lec.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 600 -SkipHttpErrorCheck).Content
}

$mockPort = Get-Random -Minimum 20000 -Maximum 45000
$env:ITN_MOCK_EMBED_DIM = '1024'
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$mockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-lec-mock.log") -RedirectStandardError (Join-Path $env:TEMP "itn-lec-mock.err")
Start-Sleep -Milliseconds 800

Api "/api/models/save" (@{ id = "real"; name = "真实端点"; baseUrl = $cfg['LLM_API_BASE']; apiKey = $cfg['LLM_API_KEY']; model = $cfg['LLM_MODEL'] } | ConvertTo-Json -Compress) | Out-Null
Api "/api/models/save" (@{ id = "mock"; name = "本地向量"; baseUrl = "http://127.0.0.1:$mockPort/v1"; apiKey = "k"; model = "mock-chat"; embeddingModel = "mock-embed" } | ConvertTo-Json -Compress) | Out-Null
Api "/api/models/roles" '{ "chatModelId": "real", "embedModelId": "mock" }' | Out-Null
Api "/api/kb/save" (@{ id = "lec"; name = "讲义库"; rootDir = $kbRoot } | ConvertTo-Json -Compress) | Out-Null
Api "/api/kb/build" '{ "id": "lec" }' | Out-Null

Write-Output "正在用真实模型生成讲义（多次调用，请稍候）…"
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Api "/api/agent/lecture" '{ "kbId": "lec", "topic": "提示词工程" }'
$sw.Stop()
$parsed = $r | ConvertFrom-Json
Write-Output ("返回码 {0}，耗时 {1} 秒" -f $parsed.code, [math]::Round($sw.Elapsed.TotalSeconds, 1))

if ($parsed.code -eq 0) {
    $d = $parsed.data
    Write-Output ("小节数: {0}" -f $d.sections.Count)
    Write-Output ("引用自检: 段落 {0} / 带引用 {1} / 越界 {2}" -f $d.citationReport.paragraphs, $d.citationReport.citedParagraphs, $d.citationReport.outOfRange)
    Write-Output ("产物路径: {0}" -f $d.artifactPath)
    Write-Output "----- 讲义正文 -----"
    Write-Output $d.content
} else {
    Write-Output ("失败：" + $parsed.message)
}
$core.Kill(); $mock.Kill()
