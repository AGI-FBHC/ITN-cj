# 用真实 OpenAI 兼容端点验证内核的出网调用链路。
# 只发送最小请求；密钥从外部配置文件读取，全程不回显。

param(
    [string]$EnvFile = "D:\Desktop\ITN\ITN\src\agents\.env",
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)

$ErrorActionPreference = 'Stop'

$cfg = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $kv = $line.Split('=', 2)
        $cfg[$kv[0].Trim()] = $kv[1].Trim()
    }
}

$baseUrl = $cfg['LLM_API_BASE']
$apiKey = $cfg['LLM_API_KEY']
$model = $cfg['LLM_MODEL']

if (-not $baseUrl -or -not $apiKey -or -not $model) { throw "配置文件缺少 LLM_API_BASE / LLM_API_KEY / LLM_MODEL" }

$dataDir = Join-Path $env:TEMP ("itn-real-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-real-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-real.out") -RedirectStandardError (Join-Path $env:TEMP "itn-real.err")

$port = $null
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"

function Api([string]$path, [string]$body) {
    $r = Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 90 -SkipHttpErrorCheck
    return $r.Content
}

Write-Output "端点: $baseUrl"
Write-Output "模型: $model"
Write-Output "密钥: 已读取（不回显）"
Write-Output ""

$modelBody = @{ id = "real"; name = "真实端点"; baseUrl = $baseUrl; apiKey = $apiKey; model = $model } | ConvertTo-Json -Compress
Write-Output ("保存模型 -> " + (Api "/api/models/save" $modelBody))

Write-Output ("绑定用途 -> " + (Api "/api/models/roles" '{ "chatModelId": "real" }'))

Write-Output "正在发起一次真实对话请求…"
$sw = [Diagnostics.Stopwatch]::StartNew()
$testResult = Api "/api/models/test" '{ "id": "real" }'
$sw.Stop()
Write-Output ("真实调用 -> {0}（耗时 {1} 秒）" -f $testResult, [math]::Round($sw.Elapsed.TotalSeconds, 2))

Write-Output "正在发起一次真实对话（带提问）…"
$chatResult = Api "/api/chat" '{ "system": "你是助手，回答尽量简短。", "user": "用一句话说明什么是提示词。" }'
Write-Output ("真实问答 -> " + $chatResult)

$core.Kill()
