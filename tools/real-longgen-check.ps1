# 验证真实模型上的长生成请求（单次调用，用于定位超时/断连）
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
$dataDir = Join-Path $env:TEMP ("itn-lg-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-lg-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-lg.out") -RedirectStandardError (Join-Path $env:TEMP "itn-lg.err")
$port = $null
for ($i = 0; $i -lt 40; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"
function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 600 -SkipHttpErrorCheck).Content
}
Api "/api/models/save" (@{ id = "real"; name = "真实端点"; baseUrl = $cfg['LLM_API_BASE']; apiKey = $cfg['LLM_API_KEY']; model = $cfg['LLM_MODEL'] } | ConvertTo-Json -Compress) | Out-Null
Api "/api/models/roles" '{ "chatModelId": "real" }' | Out-Null
Write-Output "正在请求一次长生成（预计 40 秒以上）…"
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Api "/api/chat" '{ "system": "你是教培内容作者，输出 Markdown。", "user": "写一份 1500 字以上的讲义，主题是提示词工程，包含学习目标、核心概念、常见问题三个部分。" }'
$sw.Stop()
Write-Output ("耗时 {0} 秒" -f [math]::Round($sw.Elapsed.TotalSeconds,1))
Write-Output ("响应字节长度 {0}" -f $r.Length)
Write-Output "响应前 300 字:"
Write-Output ($r.Substring(0, [Math]::Min(300, $r.Length)))
Write-Output "响应后 200 字:"
Write-Output ($r.Substring([Math]::Max(0, $r.Length - 200)))
$core.Kill()
