# Agent 演示预检：只检查“这场演示能不能开”，不改任何业务状态。
# 用法：
#   .\tools\agent-demo-preflight.ps1
#   .\tools\agent-demo-preflight.ps1 -BaseUrl http://127.0.0.1:12345
#   .\tools\agent-demo-preflight.ps1 -CheckVision
#
# 退出码：0 = 全部通过（允许 WARN）；1 = 有 FAIL。
param(
    [string]$BaseUrl = "",
    [switch]$CheckVision
)

$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) {
    $pf = Get-ChildItem $env:TEMP -Filter 'lumin-*.port' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $pf) {
        Write-Host "找不到运行中的 Lumin 端口文件。先启动应用，或用 -BaseUrl 指定地址。" -ForegroundColor Red
        exit 1
    }
    $port = (Get-Content -LiteralPath $pf.FullName -Raw).Trim()
    if (-not $port) { Write-Host "端口文件为空：$($pf.FullName)" -ForegroundColor Red; exit 1 }
    $BaseUrl = "http://127.0.0.1:$port"
}
$BaseUrl = $BaseUrl.TrimEnd('/')

$script:rows = @()
function Add-Row([string]$Name, [string]$State, [string]$Detail) {
    $script:rows += [pscustomobject]@{ Check = $Name; State = $State; Detail = $Detail }
}
function Invoke-Api([string]$Path, $Body = @{}) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    $res = Invoke-RestMethod -Uri ($BaseUrl + $Path) -Method Post -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
    if ($res.code -ne 0) { throw $res.message }
    return $res.data
}
function Invoke-ApiGet([string]$Path) {
    $res = Invoke-RestMethod -Uri ($BaseUrl + $Path) -Method Get -TimeoutSec 60
    if ($res.code -ne 0) { throw $res.message }
    return $res.data
}

Write-Host "Lumin Agent 演示预检：$BaseUrl" -ForegroundColor Cyan

$prefs = $null
try {
    $prefs = Invoke-Api '/api/prefs/get'
    Add-Row '内核可达' 'PASS' $BaseUrl
} catch {
    Add-Row '内核可达' 'FAIL' $_.Exception.Message
}

$settings = $null
$modelId = ''
if ($prefs) {
    try {
        $settings = Invoke-ApiGet '/api/settings'
        $modelId = [string]$settings.chatModelId
        if ($modelId) { Add-Row '对话模型' 'PASS' $modelId }
        else { Add-Row '对话模型' 'FAIL' '没有绑定对话模型' }
    } catch {
        Add-Row '对话模型' 'FAIL' $_.Exception.Message
    }
}

if ($modelId) {
    try {
        Invoke-Api '/api/models/test' @{ id = $modelId } | Out-Null
        Add-Row '模型连通' 'PASS' '能完成一次对话请求'
    } catch {
        Add-Row '模型连通' 'FAIL' $_.Exception.Message
    }
    try {
        $probe = Invoke-Api '/api/models/tool-test' @{ id = $modelId }
        if ($probe.ok) {
            $streaming = if ($probe.streamingToolCalls) { '，流式参数' } else { '' }
            Add-Row '工具调用' 'PASS' ("原生 function calling$streaming，$($probe.latencyMs)ms")
        } else {
            Add-Row '工具调用' 'FAIL' ([string]$probe.reason)
        }
    } catch {
        Add-Row '工具调用' 'FAIL' $_.Exception.Message
    }
}

$status = $null
try {
    $status = Invoke-Api '/api/demo/status'
    if ($status.demo) { Add-Row '演示模式' 'PASS' 'LUMIN_DEMO=1' }
    else { Add-Row '演示模式' 'FAIL' '接口可达但 demo=false' }
} catch {
    Add-Row '演示模式' 'FAIL' '演示接口不可用；请用 LUMIN_DEMO=1 启动（demo\run-demo.ps1）'
}

if ($status) {
    if ([int]$status.kbCount -gt 0 -and [int]$status.kbChunkCount -gt 0) {
        Add-Row '知识库' 'PASS' ("$($status.kbCount) 个库，$($status.kbChunkCount) 个切片")
    } else {
        Add-Row '知识库' 'WARN' '没有资料或还没切片；检索演示会空'
    }
    if ($status.demoWorkDirExists -and $status.workDirIsDemo) {
        Add-Row '演示工作区' 'PASS' ([string]$status.demoWorkDir)
    } elseif ($status.demoWorkDirExists) {
        Add-Row '演示工作区' 'WARN' '目录已创建，但当前工作目录不是它；点“准备演示环境”'
    } else {
        Add-Row '演示工作区' 'FAIL' '目录不存在；点“准备演示环境”'
    }
    if ([string]$status.agentExec -eq '1') { Add-Row '命令执行' 'PASS' '已允许' }
    else { Add-Row '命令执行' 'FAIL' '命令审批演示需要打开“允许运行命令”' }
    if ([int64]$status.approvalRules -gt 0) {
        Add-Row '审批规则' 'WARN' "$($status.approvalRules) 条已记住的规则；演示可能不弹卡，点“准备演示环境”重置"
    } else {
        Add-Row '审批规则' 'PASS' '没有历史放行规则'
    }
}

if ($CheckVision -and $modelId) {
    try {
        $v = Invoke-Api '/api/models/vision-test'
        if ($v.supported) { Add-Row '图片理解' 'PASS' $v.reason }
        else { Add-Row '图片理解' 'WARN' $v.reason }
    } catch {
        Add-Row '图片理解' 'WARN' $_.Exception.Message
    }
}

Write-Host ''
$script:rows | Format-Table -AutoSize Check, State, Detail | Out-String -Width 160 | Write-Host
$fails = @($script:rows | Where-Object { $_.State -eq 'FAIL' }).Count
$warns = @($script:rows | Where-Object { $_.State -eq 'WARN' }).Count
if ($fails -gt 0) {
    Write-Host "结果：FAIL $fails 项，WARN $warns 项" -ForegroundColor Red
    exit 1
}
Write-Host "结果：通过（WARN $warns 项）" -ForegroundColor Green
exit 0
