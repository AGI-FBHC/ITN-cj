# 改名迁移自检：老数据目录（ITN-Desktop）必须被完整搬到 Lumin，而且老目录一条都不许动。
# 用真实的 %LOCALAPPDATA%\ITN-Desktop 做只读来源，全程只读它。
param([string]$Exe = "$PSScriptRoot\..\dist\Lumin-0.3.0\Lumin.exe")

$ErrorActionPreference = 'Stop'
$real = Join-Path $env:LOCALAPPDATA 'ITN-Desktop'
$realDb = Join-Path $real 'itn.db'
if (-not (Test-Path -LiteralPath $realDb)) {
    Write-Output "SKIP 本机没有老数据目录 $real（没东西可迁移）"
    exit 0
}
$realHash = (Get-FileHash -LiteralPath $realDb -Algorithm SHA256).Hash
$realSize = (Get-Item -LiteralPath $realDb).Length

$root = Join-Path $env:TEMP ('lumin-migrate-' + [guid]::NewGuid().ToString('N'))
$oldDir = Join-Path $root 'ITN-Desktop'
New-Item -ItemType Directory -Force -Path $oldDir | Out-Null
Copy-Item -LiteralPath $realDb -Destination (Join-Path $oldDir 'itn.db') -Force
# 假锁标记：迁移后必须被清掉，否则内核会以为有人持锁
Set-Content -LiteralPath (Join-Path $oldDir 'itn.db-cjflock') -Value 'stale' -Encoding ascii
$before = (& python (Join-Path $PSScriptRoot 'db-row-counts.py') (Join-Path $oldDir 'itn.db')) | ConvertFrom-Json

$resultPath = Join-Path $root 'lumin-smoke-result.txt'
$proc = $null
try {
    $proc = Start-Process -FilePath (Resolve-Path -LiteralPath $Exe) -ArgumentList '--smoke' `
        -Environment @{ LOCALAPPDATA = $root; APPDATA = $root; TEMP = $root; TMP = $root } `
        -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (!(Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (!(Test-Path -LiteralPath $resultPath)) { throw '迁移后的启动没有产出结果文件' }
    $result = Get-Content -LiteralPath $resultPath -Raw
    if ($proc -and !$proc.HasExited) { $proc.WaitForExit(20000) | Out-Null }

    $newDb = Join-Path $root 'Lumin/itn.db'
    if (!(Test-Path -LiteralPath $newDb)) { throw '新目录 Lumin/itn.db 没有生成 —— 迁移失败' }
    if (Test-Path -LiteralPath (Join-Path $root 'Lumin/itn.db-cjflock')) { throw '迁移后没清掉老锁标记' }
    if ($result -notmatch 'RESULT=OK') { throw ('迁移后启动异常：' + ($result -replace '\s+', ' ')) }

    $after = (& python (Join-Path $PSScriptRoot 'db-row-counts.py') $newDb) | ConvertFrom-Json
    $bad = @()
    foreach ($t in 'sessions', 'session_events', 'notes', 'quiz_records', 'learning_resources', 'learning_memories') {
        if ($before.$t -gt $after.$t) { $bad += ("$t 老库 $($before.$t) → 新库 $($after.$t)") }
    }
    if ($bad.Count) { throw ('迁移后数据变少：' + ($bad -join '；')) }

    $oldNowHash = (Get-FileHash -LiteralPath (Join-Path $oldDir 'itn.db') -Algorithm SHA256).Hash
    if ($oldNowHash -ne $realHash) { throw '老目录里的库被改动了（迁移必须是"复制"，不是"搬走"）' }
    $realNowHash = (Get-FileHash -LiteralPath $realDb -Algorithm SHA256).Hash
    if ($realNowHash -ne $realHash) { throw '真实数据目录被写过了 —— 自检本身越界了' }

    Write-Output ('PASS 老库 {0:N0} 字节：会话 {1} 段 / 事件 {2} 条 全部搬到 Lumin；旧目录一字未动；锁标记已清；启动 RESULT=OK' -f `
        $realSize, $after.sessions, $after.session_events)
    Write-Output ('临时根目录：' + $root)
} finally {
    if ($proc -and !$proc.HasExited) { $proc.WaitForExit(2000) | Out-Null; if (!$proc.HasExited) { $proc.Kill() } }
}