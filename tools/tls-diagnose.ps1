# 对配置在外部 .env 里的真实 OpenAI 兼容端点做 TLS 协商诊断
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

$dataDir = Join-Path $env:TEMP ("itn-diag-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-diag-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-diag.out") -RedirectStandardError (Join-Path $env:TEMP "itn-diag.err")

$port = $null
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { $core.Kill(); throw "内核未启动" }
$base = "http://127.0.0.1:$port"

function Api([string]$path, [string]$body) {
    (Invoke-WebRequest -Uri "$base$path" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 120 -SkipHttpErrorCheck).Content
}

$modelBody = @{ id = "real"; name = "真实端点"; baseUrl = $cfg['LLM_API_BASE']; apiKey = $cfg['LLM_API_KEY']; model = $cfg['LLM_MODEL'] } | ConvertTo-Json -Compress
Api "/api/models/save" $modelBody | Out-Null

Write-Output ("端点: " + $cfg['LLM_API_BASE'])
$diag = Api "/api/models/diagnose" '{ "id": "real" }'
$parsed = $diag | ConvertFrom-Json
foreach ($a in $parsed.data.attempts) {
    Write-Output ("{0,-18} -> {1}" -f $a.mode, $a.result)
}

$core.Kill()
