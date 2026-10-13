# 内核端到端冒烟测试：mock 模型 + 配置读写 + 对话链路
param(
    [string]$CoreExe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$DataDir = "$env:TEMP\itn-desktop-smoke",
    [int]$MockPort = 0
)

$ErrorActionPreference = 'Stop'
if ($MockPort -le 0) {
    # 用随机高位端口，避免与残留的旧 mock 进程抢端口
    $MockPort = Get-Random -Minimum 20000 -Maximum 45000
}
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
    
# ---------- 知识库链路 ----------
$fence = ([string][char]96) * 3
$kbRoot = Join-Path $env:TEMP ("itn-kb-sample-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $kbRoot "img") | Out-Null
# 1x1 PNG，仅用于触发多模态描述链路
[IO.File]::WriteAllBytes((Join-Path $kbRoot "img\arch.png"), [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))

$md1 = @"
# 第一章 概述

## 1.1 背景

这是第一段正文，用于测试分块是否按标题层级切分。

### 代码示例

FENCEpython
print("hello")
# 这一行看起来像标题但不是标题
print("world")
FENCE

## 1.2 图示

![架构图](img/arch.png)

这段文字跟在图片后面，应当与图片落在同一个切片里。
"@
Set-Content -Path (Join-Path $kbRoot "01-概述.md") -Value ($md1 -replace "FENCE", $fence) -Encoding utf8
Set-Content -Path (Join-Path $kbRoot "02-进阶.md") -Value "# 第二章 进阶`n`n内容续写，用于验证多文档场景。" -Encoding utf8
Set-Content -Path (Join-Path $kbRoot "notes.txt") -Value "纯文本笔记，无标题结构。" -Encoding utf8

$r = Api $base "/api/kb/save" "POST" (@{ id = "demo"; name = "示例库"; rootDir = $kbRoot } | ConvertTo-Json -Compress)
Write-Output ("kb/save -> {0}" -f $r.status)

$r = Api $base "/api/kb/build" "POST" '{ "id": "demo" }'
Write-Output ("kb/build -> {0} {1}" -f $r.status, $r.body)

$r = Api $base "/api/kb/stats" "POST" '{ "id": "demo" }'
Write-Output ("kb/stats -> {0} {1}" -f $r.status, $r.body)

$r = Api $base "/api/kb/search" "POST" '{ "id": "demo", "query": "分块测试", "topK": 3 }'
$short = if ($r.body.Length -gt 600) { $r.body.Substring(0, 600) } else { $r.body }
Write-Output ("kb/search -> {0} {1}" -f $r.status, $short)

$r = Api $base "/api/kb/stats" "POST" '{ "id": "demo" }'
Write-Output ("图片描述是否进入索引: " + ($(if ($r.body -match "MOCK_VISION_CAPTION") { "是（stats）" } else { "需查搜索命中" })))
$hitBody = $r.body


$core.Kill(); $mock.Kill(); exit 1
}
$base = "http://127.0.0.1:$port"
Write-Output "内核端口文件握手成功: port=$port"

$r = Api $base "/health"
Write-Output ("health -> {0} {1}" -f $r.status, $r.body)

$model = @{ id = "mock"; name = "本地 mock"; baseUrl = "http://127.0.0.1:$MockPort/v1"; apiKey = "test-key"; model = "mock-chat"; visionModel = "mock-vision"; embeddingModel = "mock-embed" } | ConvertTo-Json -Compress
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


# ---------- 知识库链路 ----------
$fence = ([string][char]96) * 3
$kbRoot = Join-Path $env:TEMP ("itn-kb-sample-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $kbRoot "img") | Out-Null
# 1x1 PNG，仅用于触发多模态描述链路
[IO.File]::WriteAllBytes((Join-Path $kbRoot "img\arch.png"), [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))

$md1 = @"
# 第一章 概述

## 1.1 背景

这是第一段正文，用于测试分块是否按标题层级切分。

### 代码示例

FENCEpython
print("hello")
# 这一行看起来像标题但不是标题
print("world")
FENCE

## 1.2 图示

![架构图](img/arch.png)

这段文字跟在图片后面，应当与图片落在同一个切片里。
"@
Set-Content -Path (Join-Path $kbRoot "01-概述.md") -Value ($md1 -replace "FENCE", $fence) -Encoding utf8
Set-Content -Path (Join-Path $kbRoot "02-进阶.md") -Value "# 第二章 进阶`n`n内容续写，用于验证多文档场景。" -Encoding utf8
Set-Content -Path (Join-Path $kbRoot "notes.txt") -Value "纯文本笔记，无标题结构。" -Encoding utf8

$r = Api $base "/api/kb/save" "POST" (@{ id = "demo"; name = "示例库"; rootDir = $kbRoot } | ConvertTo-Json -Compress)
Write-Output ("kb/save -> {0}" -f $r.status)

$r = Api $base "/api/kb/build" "POST" '{ "id": "demo" }'
Write-Output ("kb/build -> {0} {1}" -f $r.status, $r.body)

$r = Api $base "/api/kb/stats" "POST" '{ "id": "demo" }'
Write-Output ("kb/stats -> {0} {1}" -f $r.status, $r.body)

$r = Api $base "/api/kb/search" "POST" '{ "id": "demo", "query": "分块测试", "topK": 3 }'
$short = if ($r.body.Length -gt 600) { $r.body.Substring(0, 600) } else { $r.body }
Write-Output ("kb/search -> {0} {1}" -f $r.status, $short)

$r = Api $base "/api/kb/stats" "POST" '{ "id": "demo" }'
Write-Output ("图片描述是否进入索引: " + ($(if ($r.body -match "MOCK_VISION_CAPTION") { "是（stats）" } else { "需查搜索命中" })))
$hitBody = $r.body


$core.Kill(); $mock.Kill()
Remove-Item $portFile -ErrorAction SilentlyContinue
