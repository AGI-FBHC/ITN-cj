# 用真实端点验证向量化链路（知识库依赖它）
param(
    [string]$EnvFile = "D:\Desktop\ITN\ITN\src\agents\.env",
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)

$ErrorActionPreference = 'Continue'
$cfg = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $kv = $line.Split('=', 2)
        $cfg[$kv[0].Trim()] = $kv[1].Trim()
    }
}

$kbRoot = Join-Path $env:TEMP ("itn-real-kb-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbRoot | Out-Null
Set-Content -Path (Join-Path $kbRoot "a.md") -Value "# 测试文档`n`n这是用于验证向量化链路的一小段文字。" -Encoding utf8

$dataDir = Join-Path $env:TEMP ("itn-real-embed-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-real-embed-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-re.out") -RedirectStandardError (Join-Path $env:TEMP "itn-re.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 180 -SkipHttpErrorCheck).Content
}

$modelBody = @{ id = "real"; name = "真实端点"; baseUrl = $cfg['LLM_API_BASE']; apiKey = $cfg['LLM_API_KEY']; model = $cfg['LLM_MODEL']; embeddingModel = $cfg['LLM_MODEL'] } | ConvertTo-Json -Compress
Api "/api/models/save" $modelBody | Out-Null
Api "/api/models/roles" '{ "embedModelId": "real" }' | Out-Null
Api "/api/kb/save" (@{ id = "r"; name = "真实库"; rootDir = $kbRoot } | ConvertTo-Json -Compress) | Out-Null

Write-Output "正在用真实端点向量化…"
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Api "/api/kb/build" '{ "id": "r" }'
$sw.Stop()
Write-Output ("建索引 -> {0}（耗时 {1} 秒）" -f $r, [math]::Round($sw.Elapsed.TotalSeconds, 2))

if ($r -match '"code":0') {
    Write-Output "正在用真实端点做一次检索…"
    $s = Api "/api/kb/search" '{ "id": "r", "query": "向量化", "topK": 2 }'
    Write-Output ("检索 -> " + $s)
}
$core.Kill()
