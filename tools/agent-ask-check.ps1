# lumin（pi 运行时）问答链路自测：/api/agent/ask-pi 的 HTTP 形状、事件落库、与手写链路同形。
# 用 tools/mock-openai 当模型（离线）；工具调用那一段由 core 的单测覆盖（ScriptedProvider）。
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }
function FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}

$kbDir = Join-Path $env:TEMP ("itn-pi-kb-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $env:TEMP ("itn-pi-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbDir, $dataDir | Out-Null
$docText = "# 提示词工程" + [char]10 + [char]10 + "## 基本概念" + [char]10 + [char]10 + "提示词是交给模型的输入指令，把任务、约束与输出格式写清楚。" + [char]10
[IO.File]::WriteAllText((Join-Path $kbDir "01.md"), $docText, [Text.UTF8Encoding]::new($false))

$mockPort = FreePort
$mock = Start-Process -FilePath "python" -ArgumentList (Join-Path $PSScriptRoot "mock-openai\server.py"), "$mockPort" -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1200

$portFile = Join-Path $env:TEMP ("itn-pi-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden
$port = $null
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $core; Stop-Quiet $mock; throw "内核没起来" }
$base = "http://127.0.0.1:$port"

function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 6
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    return (Invoke-WebRequest -Uri ("$base" + $path) -Method Post -Body $bytes -ContentType "application/json" -UseBasicParsing -TimeoutSec 120 -SkipHttpErrorCheck).Content | ConvertFrom-Json
}

$failed = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output ("  PASS  " + $name + "  " + $detail) }
    else { Write-Output ("  FAIL  " + $name + "  " + $detail); $script:failed++ }
}

try {
    Post '/api/models/save' @{ id = 'mock'; name = 'mock'; baseUrl = ("http://127.0.0.1:" + $mockPort + "/v1"); apiKey = 'k'; model = 'mock-model' } | Out-Null
    Post '/api/models/roles' @{ chatModelId = 'mock'; embedModelId = ''; chunkModelId = '' } | Out-Null
    Post '/api/kb/save' @{ id = 't'; name = '自测库'; rootDir = $kbDir } | Out-Null
    Post '/api/kb/build' @{ id = 't' } | Out-Null

    Write-Output "== lumin 跑一轮问答（/api/agent/ask-pi）=="
    $r = Post '/api/agent/ask-pi' @{ kbId = 't'; question = '提示词是什么？'; web = 'off' }
    Check '接口可用且这一轮跑完' ($r.code -eq 0 -and $r.data.ok -eq $true) ("turns=" + $r.data.turns + " stop=" + $r.data.stopReason)
    Check '返回形状与手写链路一致' (([string]$r.data.sessionId).Length -gt 0 -and ([string]$r.data.answer).Length -gt 0 -and $null -ne $r.data.citations -and $null -ne $r.data.citationReport -and ([string]$r.data.webMode) -eq 'off') ("answerLen=" + ([string]$r.data.answer).Length)
    Check '模型不认识工具时也不炸（turns>=1）' ([int]$r.data.turns -ge 1) ("turns=" + $r.data.turns)

    $ev = Post '/api/sessions/events' @{ sessionId = $r.data.sessionId }
    $kinds = @($ev.data.events | ForEach-Object { [string]$_.type })
    Check '事件用的是界面认的那几个名字' (($kinds -contains 'turn/start') -and ($kinds -contains 'user/message') -and ($kinds -contains 'assistant/message') -and ($kinds -contains 'turn/end')) ($kinds -join ',')
    Check '联网策略也留了痕（web/policy）' ($kinds -contains 'web/policy') ($kinds -join ',')
    Check '引用自检照旧跑（validation）' ($kinds -contains 'validation') ($kinds -join ',')

    Write-Output "== 通用模式：一个请求搜遍本机所有知识库 =="
    # 再建第二个库，然后 kbId 传空（通用）检索：两边都该有命中，出处的标题带上库名
    $kb2 = Join-Path $env:TEMP ("itn-pi-kb2-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $kb2 | Out-Null
    [IO.File]::WriteAllText((Join-Path $kb2 "02.md"), "# 第二门课" + [char]10 + [char]10 + "提示词在这里是另一种说法，用来验证跨库检索。" + [char]10, [Text.UTF8Encoding]::new($false))
    Post '/api/kb/save' @{ id = 't2'; name = '第二门课'; rootDir = $kb2 } | Out-Null
    Post '/api/kb/build' @{ id = 't2' } | Out-Null
    $all = Post '/api/kb/search' @{ id = ''; query = '提示词'; topK = 6 }
    $titles = @($all.data.hits | ForEach-Object { [string]$_.docTitle })
    Check '通用检索同时命中两个库' ($all.code -eq 0 -and $titles.Count -ge 2 -and (($titles -join '|') -match '自测库') -and (($titles -join '|') -match '第二门课')) (($titles | Select-Object -First 3) -join ' / ')
    Check '通用检索的出处带上库名（引用才看得出出处）' (($titles -join '|') -match '《') ([string]$all.data.summary)
    Check '指定某一个库时仍然只搜它' (@((Post '/api/kb/search' @{ id = 't2'; query = '提示词'; topK = 6 }).data.hits).Count -ge 1) 't2 命中 >=1'

    Write-Output "== 同题对照：手写链路仍然在 =="
    $r2 = Post '/api/agent/ask' @{ kbId = 't'; question = '提示词是什么？'; web = 'off' }
    Check '旧链路没被这次改动弄坏' ($r2.code -eq 0 -and $r2.data.ok -eq $true) ("answerLen=" + ([string]$r2.data.answer).Length)
} finally {
    Stop-Quiet $core
    Stop-Quiet $mock
}

Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
