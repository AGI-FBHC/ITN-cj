# 用真实视觉模型验证「含图片的多模态切片」：图片描述必须由真实模型给出
param(
    [string]$EnvFile = "D:\Desktop\ITN\ITN\src\agents\.env",
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$Image = "$PSScriptRoot\..\docs\screenshots\ui-kb.png"
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

$kbRoot = Join-Path $env:TEMP ("itn-vision-kb-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $kbRoot "img") | Out-Null
Copy-Item -LiteralPath (Resolve-Path $Image) -Destination (Join-Path $kbRoot "img\shot.png") -Force
$imgKB = [math]::Round((Get-Item (Join-Path $kbRoot "img\shot.png")).Length / 1KB, 1)

$md = @"
# 界面说明

## 知识库页面

下面是应用界面的截图。

![界面截图](img/shot.png)

上图是本工具的知识库配置页面。
"@
Set-Content -Path (Join-Path $kbRoot "ui.md") -Value $md -Encoding utf8

$dataDir = Join-Path $env:TEMP ("itn-vision-data-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-vision-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-vision.out") -RedirectStandardError (Join-Path $env:TEMP "itn-vision.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 180 -SkipHttpErrorCheck).Content
}

# 向量模型仍用本地 mock（真实端点不提供 /embeddings），切片模型用真实视觉模型
$mockPort = Get-Random -Minimum 20000 -Maximum 45000
$env:ITN_MOCK_EMBED_DIM = '1024'
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$mockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-vision-mock.log") -RedirectStandardError (Join-Path $env:TEMP "itn-vision-mock.err")
Start-Sleep -Milliseconds 800

$real = @{ id = "real"; name = "真实端点"; baseUrl = $cfg['LLM_API_BASE']; apiKey = $cfg['LLM_API_KEY']; model = $cfg['LLM_MODEL']; visionModel = $cfg['LLM_MODEL'] } | ConvertTo-Json -Compress
Api "/api/models/save" $real | Out-Null
$mockModel = @{ id = "mock"; name = "本地向量"; baseUrl = "http://127.0.0.1:$mockPort/v1"; apiKey = "k"; model = "mock-chat"; embeddingModel = "mock-embed" } | ConvertTo-Json -Compress
Api "/api/models/save" $mockModel | Out-Null
Api "/api/models/roles" '{ "chunkModelId": "real", "embedModelId": "mock" }' | Out-Null
Api "/api/kb/save" (@{ id = "v"; name = "界面截图库"; rootDir = $kbRoot } | ConvertTo-Json -Compress) | Out-Null

Write-Output ("图片大小 {0} KB，正在调用真实视觉模型生成描述…" -f $imgKB)
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Api "/api/kb/build" '{ "id": "v" }'
$sw.Stop()
Write-Output ("建索引 -> {0}（耗时 {1} 秒）" -f $r, [math]::Round($sw.Elapsed.TotalSeconds, 1))

$idxPath = Join-Path $dataDir "kb\v\index.json"
if (Test-Path $idxPath) {
    $j = Get-Content $idxPath -Raw | ConvertFrom-Json
    foreach ($c in $j.chunks) {
        if ($c.images.Count -gt 0) {
            Write-Output ("图片切片 id={0}" -f $c.id)
            Write-Output ("  图片路径: {0}" -f ($c.images -join ','))
            Write-Output ("  模型生成的描述: {0}" -f $c.caption)
        }
    }
}
$core.Kill(); $mock.Kill()
