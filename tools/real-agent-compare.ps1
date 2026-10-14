# 真实模型对照：同一批问题，分别走"lumin（pi 运行时，动态步骤）"与"旧的手写循环"，把结果摆在一起看。
#
# 为什么要它：mock 只能证明契约，证明不了"真模型认不认这套工具协议"。
# 用法：pwsh -File tools/real-agent-compare.ps1            # 默认拿你本机应用的模型配置
#       pwsh -File tools/real-agent-compare.ps1 -DataDir "D:\path\to\ITN-Desktop"
# 说明：脚本把你应用的数据目录**复制一份**到临时目录再跑，模型配置（含 Key）只用副本，绝不碰你的真库。
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA "ITN-Desktop"),
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }
if (-not (Test-Path (Join-Path $DataDir "itn.db"))) { Write-Output ("找不到 " + (Join-Path $DataDir "itn.db") + "：先在应用里配一个模型再来跑这个对照"); exit 2 }

$work = Join-Path $env:TEMP ("itn-real-cmp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item (Join-Path $DataDir "itn.db") (Join-Path $work "itn.db")
# 清掉可能残留的锁标记（复制过来的锁文件会让内核以为数据目录被占用）
Get-ChildItem $work -Filter "itn.db-cjflock*" | Remove-Item -Force -ErrorAction SilentlyContinue

# 造一份小知识库（两份 md）
$kbDir = Join-Path $work "src"
New-Item -ItemType Directory -Force -Path $kbDir | Out-Null
$md1 = "# 提示词工程" + [char]10 + [char]10 + "## 三要素" + [char]10 + [char]10 + "任务、约束、输出格式；把这三样写清楚，模型表现更稳定。" + [char]10
$md2 = "# 检索增强生成" + [char]10 + [char]10 + "## 流程" + [char]10 + [char]10 + "先切片并向量化，检索时按相似度取回片段，再连同问题交给模型作答。" + [char]10
[IO.File]::WriteAllText((Join-Path $kbDir "01.md"), $md1, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $kbDir "02.md"), $md2, [Text.UTF8Encoding]::new($false))

$portFile = Join-Path $env:TEMP ("itn-real-cmp-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$work", "--port-file=$portFile" -PassThru -WindowStyle Hidden
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
function AskBoth($route, $question) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Post $route @{ kbId = "cmp"; question = $question; web = "off"; perm = "ask" }
    $sw.Stop()
    $sid = [string]$r.data.sessionId
    $tools = @()
    $kinds = @()
    if ($sid) {
        $ev = Post "/api/sessions/events" @{ sessionId = $sid }
        $kinds = @($ev.data.events | ForEach-Object { [string]$_.type })
        $tools = @($ev.data.events | Where-Object { $_.type -eq "tool/call" } | ForEach-Object { [string]$_.payload.tool })
    }
    return [pscustomobject]@{
        ok = ($r.code -eq 0 -and $r.data.ok -eq $true)
        ms = [int]$sw.Elapsed.TotalMilliseconds
        len = ([string]$r.data.answer).Length
        cites = @($r.data.citations).Count
        tools = ($tools -join ",")
        kinds = ($kinds -join ",")
        answer = ([string]$r.data.answer)
    }
}

try {
    Post "/api/kb/save" @{ id = "cmp"; name = "对照库"; rootDir = $kbDir } | Out-Null
    $b = Post "/api/kb/build" @{ id = "cmp" }
    if ($b.code -ne 0) { throw ("建索引失败：" + [string]$b.message) }

    $questions = @(
        "资料里说提示词的三要素是什么？",
        "帮我算一下 (12+8)*3/4 是多少？",
        "用一句话说明检索增强生成的流程。"
    )

    $rows = @()
    foreach ($q in $questions) {
        Write-Output ("== " + $q)
        $lumin = AskBoth "/api/agent/ask-pi" $q
        Write-Output ("   lumin ：ok=" + $lumin.ok + " " + $lumin.ms + "ms 答" + $lumin.len + "字 出处" + $lumin.cites + " 工具[" + $lumin.tools + "]")
        $old = AskBoth "/api/agent/ask" $q
        Write-Output ("   旧链路：ok=" + $old.ok + " " + $old.ms + "ms 答" + $old.len + "字 出处" + $old.cites + " 工具[" + $old.tools + "]")
        $rows += [pscustomobject]@{ q = $q; lumin = $lumin; old = $old }
    }

    Write-Output ""
    Write-Output "== 对照结论 =="
    $bothOk = @($rows | Where-Object { $_.lumin.ok -and $_.old.ok }).Count
    Write-Output ("  两条链路都跑完的题数：" + $bothOk + " / " + $rows.Count)
    $luminTools = @($rows | Where-Object { $_.lumin.tools.Length -gt 0 }).Count
    Write-Output ("  lumin 自己决定调工具的题数：" + $luminTools + "（旧链路是内核写死顺序）")
    $citeQ = @($rows | Where-Object { $_.lumin.cites -gt 0 -or $_.old.cites -gt 0 }).Count
    Write-Output ("  带出处的题数：" + $citeQ)
    Write-Output ""
    Write-Output "== 回答原文（各取前 120 字）=="
    foreach ($row in $rows) {
        Write-Output ("  Q：" + $row.q)
        Write-Output ("    lumin：" + $row.lumin.answer.Replace([char]10, " ").Substring(0, [Math]::Min(120, $row.lumin.answer.Length)))
        Write-Output ("    旧链路：" + $row.old.answer.Replace([char]10, " ").Substring(0, [Math]::Min(120, $row.old.answer.Length)))
    }
} finally {
    Stop-Quiet $core
}

Write-Output ""
Write-Output ("数据目录副本：" + $work + "（模型配置只在副本里，没碰你的真库）")
