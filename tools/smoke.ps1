# 内核端到端冒烟测试：mock 模型 + 配置读写 + 对话链路
param(
    [string]$CoreExe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$DataDir = "$env:TEMP\itn-desktop-smoke",
    [int]$MockPort = 9999
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $CoreExe)) { throw "找不到内核产物：$CoreExe；请先运行 scripts/package.ps1" }
$portFile = Join-Path $env:TEMP ("itn-desktop-port-" + [guid]::NewGuid().ToString("N") + ".txt")
$mockLog = Join-Path $env:TEMP "itn-mock.log"
$coreOut = Join-Path $env:TEMP "itn-core-smoke.out"
$coreErr = Join-Path $env:TEMP "itn-core-smoke.err"

function Api([string]$base, [string]$path, [string]$method = "GET", [string]$body = "") {
    $req = @{ Uri = "$base$path"; Method = $method; TimeoutSec = 60; SkipHttpErrorCheck = $true }
    if ($body) { $req.Body = $body; $req.ContentType = "application/json" }
    $r = Invoke-WebRequest @req -UseBasicParsing
    return @{ status = $r.StatusCode; body = $r.Content }
}

$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$MockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"
Start-Sleep -Milliseconds 800

$core = Start-Process -FilePath $CoreExe -ArgumentList "--data-dir=$DataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput $coreOut -RedirectStandardError $coreErr

$port = $null
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path $portFile) {
        $txt = (Get-Content $portFile -Raw).Trim()
        if ($txt) { $port = $txt; break }
    }
    Start-Sleep -Milliseconds 250
}
if (-not $port) {
    Write-Output "FAIL: 端口文件未生成"
    Write-Output (Get-Content $coreErr -ErrorAction SilentlyContinue | Select-Object -First 10)
    $core.Kill(); $mock.Kill(); exit 1
}
$base = "http://127.0.0.1:$port"
Write-Output "内核端口文件握手成功: port=$port"

$r = Api $base "/health"
Write-Output ("health -> {0} {1}" -f $r.status, $r.body)

$model = @{ id = "mock"; name = "本地 mock"; baseUrl = "http://127.0.0.1:$MockPort/v1"; apiKey = "test-key"; model = "mock-chat"; embeddingModel = "mock-embed" } | ConvertTo-Json -Compress
$r = Api $base "/api/models/save" "POST" $model
Write-Output ("models/save -> {0}" -f $r.status)

$roles = '{ "chatModelId": "mock", "embedModelId": "mock", "chunkModelId": "mock" }'
$r = Api $base "/api/models/roles" "POST" $roles
Write-Output ("models/roles -> {0}" -f $r.status)

$r = Api $base "/api/models/test" "POST" '{ "id": "mock" }'
Write-Output ("models/test -> {0} {1}" -f $r.status, $r.body)

$r = Api $base "/api/chat" "POST" '{ "system": "你是助手", "user": "你好，请回复" }'
Write-Output ("chat -> {0} {1}" -f $r.status, $r.body)

$r = Api $base "/api/settings"
Write-Output ("settings 中密钥是否泄漏: " + ($(if ($r.body -match "test-key") { "是" } else { "否" })))

$r = Api $base "/api/chat" "POST" '{ "modelId": "not-exist", "user": "hi" }'
Write-Output ("chat 用未知模型 -> {0} {1}" -f $r.status, $r.body)

$core.Kill(); $mock.Kill()
Remove-Item $portFile -ErrorAction SilentlyContinue
