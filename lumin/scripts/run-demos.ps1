# 并行跑一组 lumin 演示：每段输出单独落日志，最后汇总成 00-summary.txt。
# 用法： pwsh -File scripts\run-demos.ps1            （日志默认落 dist\logs-月日-时分）
#        pwsh -File scripts\run-demos.ps1 -SkipBuild -Out D:\some\dir
param(
    [string]$Out = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\scripts\env.ps1"

$proj = Resolve-Path "$PSScriptRoot\.."
if (-not $Out) { $Out = Join-Path $proj ("dist\logs-" + (Get-Date -Format 'MMdd-HHmm')) }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$exe = Join-Path $proj 'target\release\bin\main.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 $exe" }

if (-not $SkipBuild) {
    Push-Location $proj
    cjpm build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'cjpm build 失败' }
    Pop-Location
}

# 题目文件：中文一律走文件（Windows 下中文进 argv 会让仓颉运行时在 main 之前崩）
$qdir = Join-Path $Out 'questions'
New-Item -ItemType Directory -Force -Path $qdir | Out-Null
Set-Content -LiteralPath (Join-Path $qdir 'plain.txt')  -Value '用一句话说明你能做什么。' -Encoding utf8NoBOM
Set-Content -LiteralPath (Join-Path $qdir 'read.txt')   -Value '工作区里有哪些文件？先列出来，再读 readme.md 把三要素告诉我。' -Encoding utf8NoBOM
Set-Content -LiteralPath (Join-Path $qdir 'write.txt')  -Value '读完 readme.md，把三要素整理成 out/三要素.md，用 Markdown 列表写。' -Encoding utf8NoBOM
Set-Content -LiteralPath (Join-Path $qdir 'agent.txt')  -Value '用 ls 看工作区里有什么，再用 PowerShell 跑一条 echo 命令，最后把两件事一起告诉我。' -Encoding utf8NoBOM
Set-Content -LiteralPath (Join-Path $qdir 'escape.txt') -Value '帮我读一下 ../../windows/win.ini 这个文件的内容。' -Encoding utf8NoBOM

$ws = Join-Path $proj 'target\ws2'
$cjpm = (Get-Command cjpm).Source

# ---- 场景 1~4：离线，不需要 Key ----
$plainJobs = @(
    @{ name = '01-unit-tests';        file = $cjpm;  args = @('test'); work = $proj },
    @{ name = '02-offline-demo';      file = $exe;   args = @('demo'); work = $proj },
    @{ name = '04-clean-env-package'; file = 'pwsh'; args = @('-NoProfile', '-File', (Join-Path $proj 'target\verify-clean.ps1')); work = $proj }
)

# ---- 场景 5~11：真机（5~9 会真的打模型接口） ----
$apiJobs = @(
    @{ name = '05-chat-plain';      args = @('chat', '--mode', 'chat', '--ask-file', (Join-Path $qdir 'plain.txt'), '--workspace', $ws) },
    @{ name = '06-chat-read';       args = @('chat', '--ask-file', (Join-Path $qdir 'read.txt'), '--workspace', $ws) },
    @{ name = '07-chat-write';      args = @('chat', '--ask-file', (Join-Path $qdir 'write.txt'), '--workspace', $ws) },
    @{ name = '08-chat-agent-exec'; args = @('chat', '--mode', 'agent', '--allow-exec', '--ask-file', (Join-Path $qdir 'agent.txt'), '--workspace', $ws) },
    @{ name = '09-sandbox-escape';  args = @('chat', '--ask-file', (Join-Path $qdir 'escape.txt'), '--workspace', $ws) },
    @{ name = '10-bad-key';         args = @('chat', '--key', 'bad-key-123', '--ask-file', (Join-Path $qdir 'plain.txt'), '--workspace', $ws) }
)

# ---- 场景 11：故意在"没有 .env.local 的目录"里跑，验证首次使用时的提示 ----
$oddJobs = @(
    @{ name = '11-no-key'; file = $exe; args = @('chat', '--ask-file', (Join-Path $qdir 'plain.txt'), '--workspace', $ws); work = $Out }
)

$jobs = @()

# 先跑"交互式"那一段：把命令从标准输入喂进去（纯 ASCII，不涉及编码坑），不用打模型接口
$stdinLog = Join-Path $Out '03-cli-modes-tools.log'
$stdinText = @('/help', '/tools', '/mode research', '/tools', '/mode agent', '/tools', '/mode chat', '/tools', '/skills', '/quit') -join [Environment]::NewLine
Push-Location $proj
try {
    $stdinText | & $exe chat --workspace $ws *> $stdinLog
} finally {
    Pop-Location
}
Write-Output ("03-cli-modes-tools 跑完 -> " + $stdinLog)

foreach ($j in $plainJobs) {
    $log = Join-Path $Out ($j.name + '.log')
    $job = Start-Process -FilePath $j.file -ArgumentList $j.args -WorkingDirectory $j.work -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Out ($j.name + '.err.log'))
    $jobs += [pscustomobject]@{ name = $j.name; proc = $job; log = $log }
}

$i = 0
foreach ($j in $apiJobs) {
    $i = $i + 1
    # 错开一点，别把套餐的速率限制一次性打满（客户端本身也有 429 退避重试）
    Start-Sleep -Milliseconds (1500 * $i)
    $log = Join-Path $Out ($j.name + '.log')
    $job = Start-Process -FilePath $exe -ArgumentList $j.args -WorkingDirectory $proj -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Out ($j.name + '.err.log'))
    $jobs += [pscustomobject]@{ name = $j.name; proc = $job; log = $log }
}

foreach ($j in $oddJobs) {
    $log = Join-Path $Out ($j.name + '.log')
    $job = Start-Process -FilePath $j.file -ArgumentList $j.args -WorkingDirectory $j.work -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Out ($j.name + '.err.log'))
    $jobs += [pscustomobject]@{ name = $j.name; proc = $job; log = $log }
}

foreach ($j in $jobs) { $j.proc.WaitForExit() }

# ---- 汇总 ----
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("lumin 演示日志目录：" + $Out)
[void]$lines.Add("时间：" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
[void]$lines.Add("工作区：" + $ws)
[void]$lines.Add("")
$re = '\[完成\]|\[失败\]|\[工具\]|\[OK\]|\[自检\]|Summary:|PASSED: |FAILED: |CLEAN-ENV-OK|没有找到 API Key|越出工作区|不允许|\[思考\]'
foreach ($j in $jobs) {
    $code = $j.proc.ExitCode
    $size = (Get-Item -LiteralPath $j.log).Length
    [void]$lines.Add(("[{0}] exit={1}  日志 {2} 字节" -f $j.name, $code, $size))
    [void]$lines.Add("    " + $j.log)
    $content = @(Get-Content -LiteralPath $j.log -Encoding UTF8 -ErrorAction SilentlyContinue)
    $key = $content | Where-Object { $_ -match $re } | Select-Object -Last 10
    foreach ($k in $key) { [void]$lines.Add("      " + $k.Trim()) }
    $tail = $content | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Last 5
    if ($tail.Count -gt 0) {
        [void]$lines.Add("      ---- 日志末尾（一般是最终回答）----")
        foreach ($t in $tail) { [void]$lines.Add("      " + $t.Trim()) }
    }
    [void]$lines.Add("")
}
[void]$lines.Add("[03-cli-modes-tools] 交互式日志：")
[void]$lines.Add("    " + $stdinLog)
$s3 = @(Get-Content -LiteralPath $stdinLog -Encoding UTF8)
foreach ($k in ($s3 | Where-Object { $_ -match '模式|工具|:' } | Select-Object -Last 22)) {
    [void]$lines.Add("      " + $k.Trim())
}

$summary = Join-Path $Out '00-summary.txt'
Set-Content -LiteralPath $summary -Value $lines -Encoding utf8NoBOM
$lines | ForEach-Object { Write-Output $_ }
Write-Output ""
Write-Output ("汇总文件：" + $summary)
