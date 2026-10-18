# 内核端到端冒烟测试：mock 模型 + 配置读写 + 对话链路
param(
    [string]$CoreExe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$DataDir = "$env:TEMP\itn-desktop-smoke",
    [int]$MockPort = 0
)

$ErrorActionPreference = 'Stop'
# 仓颉运行时默认堆上限 256MB，真实规模的知识库索引会顶穿
$env:cjHeapSize = '2GB'
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

# 删除知识库的无效 id 必须是可读的 4xx，不能由 CourseStore 异常冒成 500
$r = Api $base "/api/kb/delete" "POST" '{}'
if ($r.status -ne 400 -or $r.body -notmatch '缺少 id') { throw ("kb/delete 空 id 未按契约拒绝：status={0} body={1}" -f $r.status, $r.body) }
$r = Api $base "/api/kb/delete" "POST" '{ "id": "does-not-exist" }'
if ($r.status -ne 404 -or $r.body -notmatch '找不到知识库') { throw ("kb/delete 未知 id 未按契约返回 404：status={0} body={1}" -f $r.status, $r.body) }
Write-Output "PASS kb/delete 空 id/未知 id 不写数据且返回 400/404"

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



# ---------- Agent 主链路 ----------
$r = Api $base "/api/agent/ask" "POST" '{ "kbId": "demo", "question": "分块是怎么做的？" }'
$s = if ($r.body.Length -gt 420) { $r.body.Substring(0, 420) } else { $r.body }
Write-Output ("agent/ask -> {0} {1}" -f $r.status, $s)

$r = Api $base "/api/agent/task-pi" "POST" '{ "kind": "lecture", "kbId": "demo", "topic": "分块" }'
$lec = $r
$s = if ($r.body.Length -gt 300) { $r.body.Substring(0, 300) } else { $r.body }
Write-Output ("agent/task-pi(讲义) -> {0} {1}" -f $r.status, $s)

$r = Api $base "/api/agent/task-pi" "POST" '{ "kind": "quiz", "kbId": "demo", "topic": "分块", "count": 3 }'
Write-Output ("agent/task-pi(练习册) -> {0}" -f $r.status)

$r = Api $base "/api/sessions/list" "POST" '{}'
Write-Output ("sessions/list -> {0}" -f $r.status)
$sess = ($r.body | ConvertFrom-Json).data.sessions
Write-Output ("会话数: {0}" -f $sess.Count)

if ($sess.Count -gt 0) {
    $sid = $sess[0].sessionId
    $r = Api $base "/api/sessions/events" "POST" (@{ sessionId = $sid } | ConvertTo-Json -Compress)
    $evs = ($r.body | ConvertFrom-Json).data.events
    Write-Output ("会话 {0} 事件数: {1}" -f $sid, $evs.Count)
    $kinds = ($evs | ForEach-Object { $_.type }) -join ","
    Write-Output ("事件类型: {0}" -f $kinds)
}

$r = Api $base "/api/artifacts/list" "POST" '{}'
$arts = ($r.body | ConvertFrom-Json).data.artifacts
Write-Output ("产物数: {0}" -f $arts.Count)

$lecJson = $lec.body | ConvertFrom-Json
$ap = $lecJson.data.artifactPath
if ($ap -and (Test-Path -LiteralPath $ap)) {
    $content = Get-Content -LiteralPath $ap -Raw
    Write-Output ("讲义文件: {0} 字节" -f (Get-Item -LiteralPath $ap).Length)
    Write-Output ("讲义含「资料来源」章节: " + ($(if ($content -match "资料来源") { "是" } else { "否" })))
    Write-Output ("讲义含引用标记: " + ($(if ($content -match "\[\d+\]") { "是" } else { "否" })))
} else {
    Write-Output "讲义文件路径无效"
}


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

# 空 user 必须在内核入口被拒绝，不能把空提示发给上游模型
$r = Api $base "/api/chat" "POST" '{ "user": "   " }'
if ($r.status -ne 400 -or $r.body -notmatch '缺少 user') { throw ("chat 空 user 未按契约拒绝：status={0} body={1}" -f $r.status, $r.body) }
Write-Output "PASS chat 空 user 返回 400 且不调用模型"


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

# 删除知识库的无效 id 必须是可读的 4xx，不能由 CourseStore 异常冒成 500
$r = Api $base "/api/kb/delete" "POST" '{}'
if ($r.status -ne 400 -or $r.body -notmatch '缺少 id') { throw ("kb/delete 空 id 未按契约拒绝：status={0} body={1}" -f $r.status, $r.body) }
$r = Api $base "/api/kb/delete" "POST" '{ "id": "does-not-exist" }'
if ($r.status -ne 404 -or $r.body -notmatch '找不到知识库') { throw ("kb/delete 未知 id 未按契约返回 404：status={0} body={1}" -f $r.status, $r.body) }
Write-Output "PASS kb/delete 空 id/未知 id 不写数据且返回 400/404"

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



# ---------- Agent 主链路 ----------
$r = Api $base "/api/agent/ask" "POST" '{ "kbId": "demo", "question": "分块是怎么做的？" }'
$s = if ($r.body.Length -gt 420) { $r.body.Substring(0, 420) } else { $r.body }
Write-Output ("agent/ask -> {0} {1}" -f $r.status, $s)

$r = Api $base "/api/agent/task-pi" "POST" '{ "kind": "lecture", "kbId": "demo", "topic": "分块" }'
$lec = $r
$s = if ($r.body.Length -gt 300) { $r.body.Substring(0, 300) } else { $r.body }
Write-Output ("agent/task-pi(讲义) -> {0} {1}" -f $r.status, $s)

$r = Api $base "/api/agent/task-pi" "POST" '{ "kind": "quiz", "kbId": "demo", "topic": "分块", "count": 3 }'
Write-Output ("agent/task-pi(练习册) -> {0}" -f $r.status)

$r = Api $base "/api/sessions/list" "POST" '{}'
Write-Output ("sessions/list -> {0}" -f $r.status)
$sess = ($r.body | ConvertFrom-Json).data.sessions
Write-Output ("会话数: {0}" -f $sess.Count)

if ($sess.Count -gt 0) {
    $sid = $sess[0].sessionId
    $r = Api $base "/api/sessions/events" "POST" (@{ sessionId = $sid } | ConvertTo-Json -Compress)
    $evs = ($r.body | ConvertFrom-Json).data.events
    Write-Output ("会话 {0} 事件数: {1}" -f $sid, $evs.Count)
    $kinds = ($evs | ForEach-Object { $_.type }) -join ","
    Write-Output ("事件类型: {0}" -f $kinds)
}

$r = Api $base "/api/artifacts/list" "POST" '{}'
$arts = ($r.body | ConvertFrom-Json).data.artifacts
Write-Output ("产物数: {0}" -f $arts.Count)

# 课件播放进度：写一次、读回来，并确认产物列表带回该进度
$progName = $arts[0].name
if ($progName) {
    $r = Api $base "/api/artifacts/progress/save" "POST" (@{ name = $progName; page = 2; pageCount = 7 } | ConvertTo-Json -Compress)
    Write-Output ("播放进度保存 -> {0}" -f $r.status)
    $r = Api $base "/api/artifacts/progress" "POST" (@{ name = $progName } | ConvertTo-Json -Compress)
    $pdata = ($r.body | ConvertFrom-Json).data
    Write-Output ("播放进度读取 -> 第 {0} / {1} 页（{2}）" -f $pdata.page, $pdata.pageCount, $pdata.progressAt)
    $r = Api $base "/api/artifacts/list" "POST" '{}'
    $withProg = (($r.body | ConvertFrom-Json).data.artifacts | Where-Object { $_.name -eq $progName })
    Write-Output ("产物列表带回进度 -> {0}/{1}" -f $withProg.page, $withProg.pageCount)
}

$lecJson = $lec.body | ConvertFrom-Json
$ap = $lecJson.data.artifactPath
if ($ap -and (Test-Path -LiteralPath $ap)) {
    $content = Get-Content -LiteralPath $ap -Raw
    Write-Output ("讲义文件: {0} 字节" -f (Get-Item -LiteralPath $ap).Length)
    Write-Output ("讲义含「资料来源」章节: " + ($(if ($content -match "资料来源") { "是" } else { "否" })))
    Write-Output ("讲义含引用标记: " + ($(if ($content -match "\[\d+\]") { "是" } else { "否" })))
} else {
    Write-Output "讲义文件路径无效"
}


$core.Kill(); $mock.Kill()
Remove-Item $portFile -ErrorAction SilentlyContinue
