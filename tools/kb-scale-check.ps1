# 用接近真实规模的知识库验证建索引与检索的耗时
param(
    [int]$Docs = 100,
    [int]$LinesPerDoc = 60,
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)

$ErrorActionPreference = 'Stop'
# 仓颉运行时默认堆上限 256MB，真实规模的知识库索引会顶穿
$env:cjHeapSize = '2GB'
$kbRoot = Join-Path $env:TEMP ("itn-scale-kb-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $kbRoot "img") | Out-Null

$sentences = @(
    "检索增强生成把资料切片后按相似度取回，再交给模型作答。",
    "提示词写清楚任务、约束与输出格式，模型表现会更稳定。",
    "少样本示例和角色设定是两种常用的提示词手法。",
    "向量检索依赖嵌入模型把文本映射到同一语义空间。",
    "引用自检用于确认每条结论都能指回资料原文。"
)

for ($i = 1; $i -le $Docs; $i++) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("# 第 $i 章 主题$i")
    [void]$sb.AppendLine("")
    for ($s = 1; $s -le 5; $s++) {
        [void]$sb.AppendLine("## $i.$s 小节$s")
        [void]$sb.AppendLine("")
        for ($l = 1; $l -le $LinesPerDoc; $l++) {
            $pick = $sentences[($i + $s + $l) % $sentences.Count]
            [void]$sb.AppendLine("$pick 这是第 $i 章第 $s 节的第 $l 句，用于撑起切片长度。")
        }
        [void]$sb.AppendLine("")
    }
    Set-Content -Path (Join-Path $kbRoot ("doc-{0:d3}.md" -f $i)) -Value $sb.ToString() -Encoding utf8
}
$totalKB = [math]::Round((Get-ChildItem $kbRoot -Filter *.md | Measure-Object Length -Sum).Sum / 1KB, 1)
Write-Output "生成 $Docs 篇 Markdown，合计 $totalKB KB"

$mockPort = Get-Random -Minimum 20000 -Maximum 45000
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$mockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-scale-mock.log") -RedirectStandardError (Join-Path $env:TEMP "itn-scale-mock.err")

$dataDir = Join-Path $env:TEMP ("itn-scale-data-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-scale-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-scale.out") -RedirectStandardError (Join-Path $env:TEMP "itn-scale.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); $mock.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 600 -SkipHttpErrorCheck).Content
}

Api "/api/models/save" (@{ id = "m"; name = "mock"; baseUrl = "http://127.0.0.1:$mockPort/v1"; apiKey = "k"; model = "mock-chat"; embeddingModel = "mock-embed" } | ConvertTo-Json -Compress) | Out-Null
Api "/api/models/roles" '{ "chatModelId": "m", "embedModelId": "m" }' | Out-Null
Api "/api/kb/save" (@{ id = "big"; name = "大库"; rootDir = $kbRoot } | ConvertTo-Json -Compress) | Out-Null

$sw = [Diagnostics.Stopwatch]::StartNew()
$build = Api "/api/kb/build" '{ "id": "big" }'
$sw.Stop()
Write-Output ("建索引 {0} 秒 -> {1}" -f [math]::Round($sw.Elapsed.TotalSeconds, 1), $build)

$idxFile = Join-Path $dataDir "kb\big\index.json"
if (Test-Path $idxFile) { Write-Output ("索引文件 {0} MB" -f [math]::Round((Get-Item $idxFile).Length / 1MB, 2)) }

foreach ($n in 1, 2) {
    $sw2 = [Diagnostics.Stopwatch]::StartNew()
    $r = Api "/api/kb/search" '{ "id": "big", "query": "提示词", "topK": 5 }'
    $sw2.Stop()
    $hits = ($r | ConvertFrom-Json).data.hits.Count
    Write-Output ("第 {0} 次检索 {1} 秒，命中 {2} 条" -f $n, [math]::Round($sw2.Elapsed.TotalSeconds, 2), $hits)
}

$core.Kill(); $mock.Kill()
