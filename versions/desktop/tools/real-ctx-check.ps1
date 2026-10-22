# 真模型抽查：① 界面上下文让"这一章"有落点（不再反问哪一章）② 闲聊不调工具 ③ 算数只调 calc。
# 数据目录会先复制到临时目录再跑，模型配置（含 Key）只用副本，不碰真库。
# 用法：pwsh -File tools/real-ctx-check.ps1
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA "ITN-Desktop"),
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }
if (-not (Test-Path (Join-Path $DataDir "itn.db"))) { Write-Output ("找不到 " + (Join-Path $DataDir "itn.db") + "：先在应用里配一个模型"); exit 2 }

$work = Join-Path $env:TEMP ("itn-ctx-check-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item (Join-Path $DataDir "itn.db") (Join-Path $work "itn.db")
if (Test-Path (Join-Path $DataDir "settings.json")) { Copy-Item (Join-Path $DataDir "settings.json") (Join-Path $work "settings.json") }
Get-ChildItem $work -Filter "itn.db-cjflock*" | Remove-Item -Force -ErrorAction SilentlyContinue

$kbDir = Join-Path $work "src"
New-Item -ItemType Directory -Force -Path $kbDir | Out-Null
$md1 = "# 提示词工程" + [char]10 + [char]10 + "## 三要素" + [char]10 + [char]10 + "任务、约束、输出格式：把这三样写清楚，模型的输出更稳定。" + [char]10
$md2 = "# 检索增强生成" + [char]10 + [char]10 + "## 流程" + [char]10 + [char]10 + "先切片并向量化，检索时按相似度取回片段，再连同问题交给模型作答。" + [char]10
[IO.File]::WriteAllText((Join-Path $kbDir "01.md"), $md1, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $kbDir "02.md"), $md2, [Text.UTF8Encoding]::new($false))

$portFile = Join-Path $work "core.port"
$core = Start-Process -FilePath $Exe -ArgumentList @("--data-dir=$work", "--port-file=$portFile") -PassThru -WindowStyle Hidden
$port = $null
for ($i = 0; $i -lt 80; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $core; throw "内核没起来" }
$base = "http://127.0.0.1:$port"
function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 8
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    return (Invoke-WebRequest -Uri ("$base" + $path) -Method Post -Body $bytes -ContentType "application/json" -UseBasicParsing -TimeoutSec 300 -SkipHttpErrorCheck).Content | ConvertFrom-Json
}
function AskWithCtx($question, $ctx) {
    $body = @{ kbId = "ctx"; question = $question; web = "off"; perm = "ask" }
    if ($ctx) { $body["ctxChapter"] = $ctx }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Post "/api/agent/ask-pi" $body
    $sw.Stop()
    $sid = [string]$r.data.sessionId
    $tools = @(); $kinds = @()
    if ($sid) {
        $ev = Post "/api/sessions/events" @{ sessionId = $sid }
        $kinds = @($ev.data.events | ForEach-Object { [string]$_.type })
        $tools = @($ev.data.events | Where-Object { $_.type -eq "tool/call" } | ForEach-Object { [string]$_.payload.tool })
    }
    return [pscustomobject]@{
        ok = ($r.code -eq 0 -and $r.data.ok -eq $true -and ([string]$r.data.answer).Length -gt 0)
        ms = [int]$sw.Elapsed.TotalMilliseconds
        answer = [string]$r.data.answer
        tools = $tools
        kinds = $kinds
    }
}

try {
    Post "/api/kb/save" @{ id = "ctx"; name = "上下文自测库"; rootDir = $kbDir } | Out-Null
    $b = Post "/api/kb/build" @{ id = "ctx" }
    if ($b.code -ne 0) { throw ("建索引失败：" + [string]$b.message) }

    $exit = 0

    $r1 = AskWithCtx "这一章的核心结论是什么？" "提示词工程"
    $askedBack = ($r1.answer -match "哪一章|是哪章|哪份|哪一节")
    $hitChapter = ($r1.answer -match "提示词|三要素|任务")
    Write-Output ("[1] 带上下文提问：ok=" + $r1.ok + " " + $r1.ms + "ms 工具[" + ($r1.tools -join ",") + "]")
    Write-Output ("    反问哪一章=" + $askedBack + " · 答到这一章=" + $hitChapter + " · 思考事件=" + (@($r1.kinds | Where-Object { $_ -eq "assistant/thinking" }).Count))
    Write-Output ("    答：" + $r1.answer.Substring(0, [Math]::Min(160, $r1.answer.Length)).Replace([char]10, " "))
    if (-not ($r1.ok -and (-not $askedBack) -and $hitChapter)) { $exit = 1; Write-Output "    FAIL: 上下文没有让""这一章""落地" }

    $r2 = AskWithCtx "你好，随便聊一句就行" ""
    Write-Output ("[2] 闲聊：ok=" + $r2.ok + " " + $r2.ms + "ms 工具[" + ($r2.tools -join ",") + "]")
    if ($r2.tools.Count -ne 0) { $exit = 1; Write-Output "    FAIL: 闲聊不该调工具（说明还是写死先检索）" }

    $r3 = AskWithCtx "帮我算一下 (12+8)*3/4 是多少？" ""
    $onlyCalc = ($r3.tools.Count -eq 1 -and $r3.tools[0] -eq "calc")
    Write-Output ("[3] 算数：ok=" + $r3.ok + " " + $r3.ms + "ms 工具[" + ($r3.tools -join ",") + "]")
    if (-not $onlyCalc) { $exit = 1; Write-Output "    FAIL: 算数应当只调 calc" }

    Write-Output ("数据目录副本：" + $work)
    exit $exit
} finally {
    Stop-Quiet $core
}
