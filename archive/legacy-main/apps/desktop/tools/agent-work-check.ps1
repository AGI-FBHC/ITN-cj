# "让 lumin 动手"自测：工作区工具 + 权限档位 + 审批 + 插话（离线假模型会真的调 write）。
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

$workDir = Join-Path $env:TEMP ("itn-work-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $env:TEMP ("itn-work-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $workDir, $dataDir | Out-Null

$mockPort = FreePort
$mock = Start-Process -FilePath "python" -ArgumentList (Join-Path $PSScriptRoot "mock-toolcall\server.py"), "$mockPort" -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1000
$portFile = Join-Path $env:TEMP ("itn-work-" + [guid]::NewGuid().ToString("N") + ".port")
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
# 后台发一次请求（审批要等界面点，所以不能用同步调用卡住自己）。
function PostBackground($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 6
    $f = Join-Path $env:TEMP ("itn-work-body-" + [guid]::NewGuid().ToString("N") + ".json")
    [IO.File]::WriteAllText($f, $json, [Text.UTF8Encoding]::new($false))
    $out = Join-Path $env:TEMP ("itn-work-out-" + [guid]::NewGuid().ToString("N") + ".json")
    $p = Start-Process -FilePath "curl.exe" -ArgumentList "-s", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@$f", ("$base" + $path), "-o", $out -PassThru -WindowStyle Hidden
    return @{ proc = $p; out = $out }
}

try {
    Post '/api/models/save' @{ id = 'tc'; name = 'toolcall-mock'; baseUrl = ("http://127.0.0.1:" + $mockPort + "/v1"); apiKey = 'k'; model = 'mock-tool' } | Out-Null
    Post '/api/models/roles' @{ chatModelId = 'tc'; embedModelId = ''; chunkModelId = '' } | Out-Null
    Post '/api/kb/save' @{ id = 't'; name = '自测库'; rootDir = $workDir } | Out-Null
    Post '/api/kb/build' @{ id = 't' } | Out-Null

    Write-Output "== 默认：不给工作区，模型碰不到文件 =="
    $r0 = Post '/api/agent/ask-pi' @{ kbId = 't'; question = '我有什么资料？'; web = 'off' }
    Check '不带工作区时也能正常问答' ($r0.code -eq 0 -and $r0.data.ok -eq $true) ("turns=" + $r0.data.turns)
    Check '默认没写文件（工作区里还是空的）' (-not (Test-Path (Join-Path $workDir 'notes.md'))) 'notes.md 不存在'

    Write-Output "== 开工作区 + ask 档：写工作区内不问，写外面要批 =="
    Post '/api/prefs/save' @{ agentWorkDir = $workDir; agentPerm = 'ask'; agentExec = '0' } | Out-Null
    $r1 = Post '/api/agent/ask-pi' @{ kbId = 't'; question = '把结论写进 @@TARGET:notes.md@@ 里'; web = 'off' }
    Check '一轮跑完' ($r1.code -eq 0 -and $r1.data.ok -eq $true) ("turns=" + $r1.data.turns)
    Check '工作区内的文件真的落盘了' (Test-Path (Join-Path $workDir 'notes.md')) (Join-Path $workDir 'notes.md')

    $outside = (Join-Path (Split-Path $workDir -Parent) 'itn-outside-check')
    New-Item -ItemType Directory -Force -Path $outside | Out-Null
    $outsideFile = Join-Path $outside 'evil.md'
    if (Test-Path $outsideFile) { Remove-Item $outsideFile -Force }
    $rel = "../itn-outside-check/evil.md"
    $job = PostBackground '/api/agent/ask-pi' @{ kbId = 't'; question = ("把结论写进 @@TARGET:" + $rel + "@@ 里"); web = 'off' }
    # 审批是“工具线程阻塞等界面点”，所以要轮询一会儿，不能睡一觉就断言
    $ap = $null
    $req = $null
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 400
        $ap = Post '/api/agent/approvals' @{}
        $req = @($ap.data.requests | Where-Object { $_.decision -eq '' })[0]
        if ($null -ne $req) { break }
    }
    Check '写工作区外会挂起等批准' ([int]$ap.data.pending -ge 1) ("pending=" + $ap.data.pending)
    $req = @($ap.data.requests | Where-Object { $_.decision -eq '' })[0]
    Check '批准卡带上动作分类与路径' ($null -ne $req -and ([string]$req.kind) -eq 'path-outside' -and ([string]$req.value).Length -gt 0) (([string]$req.kind) + " · " + ([string]$req.value))
    Post '/api/agent/approvals/answer' @{ id = $req.id; decision = 'once' } | Out-Null
    Wait-Process -Id $job.proc.Id -Timeout 60 -ErrorAction SilentlyContinue
    Check '批准后文件真的落到工作区外' (Test-Path $outsideFile) $outsideFile

    Write-Output "== full 档：不问，直接放行 =="
    if (Test-Path $outsideFile) { Remove-Item $outsideFile -Force }
    Post '/api/prefs/save' @{ agentPerm = 'full' } | Out-Null
    $r3 = Post '/api/agent/ask-pi' @{ kbId = 't'; question = ("把结论写进 @@TARGET:" + $rel + "@@ 里"); web = 'off' }
    Check 'full 档一轮跑完' ($r3.code -eq 0 -and $r3.data.ok -eq $true) ("turns=" + $r3.data.turns)
    Check 'full 档不问就写了' (Test-Path $outsideFile) $outsideFile

    Write-Output "== 插话：跑着的时候还能塞一句 =="
    $s1 = Post '/api/agent/steer' @{ sessionId = 'probe-session'; text = '顺便看一下第二章' }
    Check '插话先落队列' ($s1.code -eq 0 -and $s1.data.queued -eq $true -and [int]$s1.data.pending -eq 1) ("pending=" + $s1.data.pending)
} finally {
    Stop-Quiet $core
    Stop-Quiet $mock
}

Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
