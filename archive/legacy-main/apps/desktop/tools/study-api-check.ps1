# 学习闭环接口自测：档案、知识网络、章节、进度、笔记、错题、报告
param([string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe")
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'

$kbRoot = Join-Path $env:TEMP ("itn-study-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbRoot | Out-Null
$doc = @"
# 第一章 提示词

## 1.1 定义

提示词是交给模型的输入指令。把任务、约束和输出格式写清楚，模型的产出会更稳定。

## 1.2 常用手法

少样本示例：先给几个输入输出样例，让模型照着格式做。角色设定：先说明模型扮演的角色。分步推理：要求模型先列步骤再给结论。
"@
Set-Content -Path (Join-Path $kbRoot "01.md") -Value $doc -Encoding utf8
$doc2 = @"
# 第二章 检索增强

## 2.1 流程

先把资料切片并向量化，提问时按相似度取回相关片段，再连同问题一起交给模型作答。
"@
Set-Content -Path (Join-Path $kbRoot "02.md") -Value $doc2 -Encoding utf8

$mockPort = Get-Random -Minimum 20000 -Maximum 45000
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$mockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-study-mock.log") -RedirectStandardError (Join-Path $env:TEMP "itn-study-mock.err")
Start-Sleep -Milliseconds 800

$dataDir = Join-Path $env:TEMP ("itn-study-data-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-study-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-study.out") -RedirectStandardError (Join-Path $env:TEMP "itn-study.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); $mock.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 120 -SkipHttpErrorCheck).Content
}

Api "/api/models/save" (@{ id = "m"; name = "mock"; baseUrl = "http://127.0.0.1:$mockPort/v1"; apiKey = "k"; model = "mock-chat"; embeddingModel = "mock-embed" } | ConvertTo-Json -Compress) | Out-Null
Api "/api/models/roles" '{ "chatModelId": "m", "embedModelId": "m" }' | Out-Null
Api "/api/kb/save" (@{ id = "s"; name = "学习库"; rootDir = $kbRoot } | ConvertTo-Json -Compress) | Out-Null
$r = Api "/api/kb/build" '{ "id": "s" }'
Write-Output ("建索引 -> " + $r)

Write-Output ("档案保存 -> " + (Api "/api/profile/save" '{ "nickname": "小明", "goal": "掌握提示词工程", "weeklyHours": 6, "preferredFormats": ["讲义","练习"], "selfScores": { "概念理解": 70, "工程实践": 55 } }'))
Write-Output ("档案读取 -> " + (Api "/api/profile/get" '{}'))

$tree = (Api "/api/study/tree" '{ "kbId": "s" }') | ConvertFrom-Json
Write-Output ("知识网络章节数 -> " + $tree.data.chapters.Count)
foreach ($c in $tree.data.chapters) { Write-Output ("  {0}  切片 {1} 小节 {2} 已读 {3}" -f $c.name, $c.chunkCount, $c.sectionCount, $c.readCount) }

$first = $tree.data.chapters[0].name
$chap = (Api "/api/study/chapter" (@{ kbId = "s"; chapter = $first } | ConvertTo-Json -Compress)) | ConvertFrom-Json
Write-Output ("章节目录「{0}」切片数 -> {1}" -f $first, $chap.data.chunks.Count)
$cid = $chap.data.chunks[0].id
Write-Output ("标记已读 -> " + (Api "/api/study/read" (@{ kbId = "s"; chunkId = $cid } | ConvertTo-Json -Compress)))
$tree2 = (Api "/api/study/tree" '{ "kbId": "s" }') | ConvertFrom-Json
$c0 = $tree2.data.chapters | Where-Object { $_.name -eq $first }
Write-Output ("标记后已读数 -> " + $c0.readCount)

Write-Output ("笔记保存 -> " + (Api "/api/study/notes/save" (@{ kbId = "s"; chapter = $first; title = "我的笔记"; text = "提示词三要素要记牢。" } | ConvertTo-Json -Compress)))
$notes = (Api "/api/study/notes/list" '{}') | ConvertFrom-Json
Write-Output ("笔记条数 -> " + $notes.data.notes.Count)

Write-Output ("答题记录 -> " + (Api "/api/study/quiz/submit" '{ "kbId": "s", "chapter": "第一章 提示词", "question": "提示词三要素？", "myAnswer": "任务/约束/输出格式", "reference": "任务、约束、输出格式", "correct": false }'))
$wrong = (Api "/api/study/wrong" '{}') | ConvertFrom-Json
Write-Output ("错题数 -> " + $wrong.data.records.Count)

Write-Output ("学习报告 -> " + (Api "/api/study/report" '{}'))
$core.Kill(); $mock.Kill()
