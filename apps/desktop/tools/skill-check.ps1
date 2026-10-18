# 技能（Skill）自测：清单 / 读正文 / 会话绑定 / 工具边界 / 授权门
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$SkillsDir = "$PSScriptRoot\..\shell\skills",
    [int]$MockPort = 0
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
if ($MockPort -le 0) { $MockPort = Get-Random -Minimum 20000 -Maximum 45000 }

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }

$dataDir = Join-Path $env:TEMP ('itn-skill-data-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$portFile = Join-Path $env:TEMP ('itn-skill-' + [guid]::NewGuid().ToString('N') + '.port')
$mockLog = Join-Path $env:TEMP 'itn-skill-mock.log'
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$MockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"
Start-Sleep -Milliseconds 800
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile", "--skills-dir=$SkillsDir" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-skill-core.out") -RedirectStandardError (Join-Path $env:TEMP "itn-skill-core.err")
$port = $null
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $core; Stop-Quiet $mock; throw "内核没起来" }
$base = "http://127.0.0.1:$port"

function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 8
    $f = Join-Path $env:TEMP ('itn-skill-b-' + [guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($f, $json, [Text.UTF8Encoding]::new($false))
    try {
        $raw = curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@$f" "$base$path"
        return $raw | ConvertFrom-Json
    } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

$failed = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output ("  PASS  " + $name + "  " + $detail) }
    else { Write-Output ("  FAIL  " + $name + "  " + $detail); $script:failed++ }
}

try {
    # 先把 mock 模型配上：不然后面的 ask 会直接以"没有可用的对话模型"收场
    Post '/api/models/save' @{ id = 'mock'; name = '本地 mock'; baseUrl = "http://127.0.0.1:$MockPort/v1"; apiKey = 'test-key'; model = 'mock-chat' } | Out-Null
    Post '/api/models/roles' @{ chatModelId = 'mock'; embedModelId = ''; chunkModelId = '' } | Out-Null

    Write-Output "== 清单：内置技能能列出来，frontmatter 解析对 =="
    $l = Post '/api/skills/list' @{}
    $ids = @($l.data.skills | ForEach-Object { $_.id })
    Check '内置 web-research 在清单里' ($ids -contains 'web-research') ($ids -join ', ')
    $web = ($l.data.skills | Where-Object { $_.id -eq 'web-research' })[0]
    Check 'frontmatter 解析出 title/tools/requires_consent' ($web.title -eq '联网专题研究' -and @($web.tools).Count -ge 4 -and $web.requiresConsent -eq 'web') ($web.title + ' tools=' + (@($web.tools) -join '/'))
    Check '来源标成内置（只读）' ($web.source -eq 'bundled') $web.source

    Write-Output "== 用户技能：写个 Markdown 就多一种 =="
    $dir = Join-Path $dataDir 'skills\kb-only'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $md = @'
---
name: kb-only
title: 只用本机资料
description: 只用知识库回答，不碰别的工具
when_to_use: 用户要求不要联网、只依据本机资料回答时
tools: [kb_search]
requires_consent:
---

# 只用本机资料

1. 用 kb_search 检索。
2. 只依据命中切片回答，标 [编号]。
'@
    [IO.File]::WriteAllText((Join-Path $dir 'SKILL.md'), $md, [Text.UTF8Encoding]::new($false))
    $l2 = Post '/api/skills/list' @{}
    $mine = ($l2.data.skills | Where-Object { $_.id -eq 'kb-only' })[0]
    $mineSource = if ($mine) { $mine.source } else { '缺失' }
    Check '用户技能被列出来且标成 user' ($mine -and $mine.source -eq 'user') $mineSource
    Check '用户目录路径回给了界面' (([string]$l2.data.userDir).Length -gt 0) ([string]$l2.data.userDir)
    $r = Post '/api/skills/read' @{ id = 'kb-only' }
    Check '能读正文（渐进披露第二步）' ($r.code -eq 0 -and ([string]$r.data.body).Contains('kb_search')) ('body ' + ([string]$r.data.body).Length + ' 字')
    Check '模板技能能生成' ((Post '/api/skills/template' @{}).code -eq 0) '写进用户目录'

    Write-Output "== 工具边界：技能没声明的工具，调了就被拒 =="
    $sid = (Post '/api/sessions/new' @{}).data.sessionId
    $bind = Post '/api/skills/bind' @{ sessionId = $sid; skill = 'kb-only' }
    Check '会话绑定技能' ($bind.data.bound -eq 'kb-only') $bind.data.bound
    # mock 模型会把"帮我算一下"变成 calc 工具调用；这个技能只声明了 kb_search，应当被拒
    $ask = Post '/api/agent/ask' @{ kbId = ''; question = '帮我算一下 (12+8)*3/4 是多少？'; sessionId = $sid; skill = 'kb-only' }
    $ev = Post '/api/sessions/events' @{ sessionId = $sid }
    $types = @($ev.data.events | ForEach-Object { $_.type })
    $denied = @($ev.data.events | Where-Object { $_.type -eq 'tool/denied' })
    $read = @($ev.data.events | Where-Object { $_.type -eq 'skill/read' })
    Check '用技能时留下 skill/read 事件' ($read.Count -ge 1) ('events=' + ($types -join ','))
    Check '越权工具被拒并留 tool/denied' ($denied.Count -ge 1) ('denied=' + $denied.Count)
    Check '返回里带上这次用的技能' ($ask.data.skill -eq 'kb-only') ([string]$ask.data.skill)

    Write-Output "== 对照：不绑技能时同一个问题照常算 =="
    $sid2 = (Post '/api/sessions/new' @{}).data.sessionId
    $ask2 = Post '/api/agent/ask' @{ kbId = ''; question = '帮我算一下 (12+8)*3/4 是多少？'; sessionId = $sid2 }
    $ev2 = Post '/api/sessions/events' @{ sessionId = $sid2 }
    $denied2 = @($ev2.data.events | Where-Object { $_.type -eq 'tool/denied' })
    Check '不绑技能时没有越权拒绝' ($denied2.Count -eq 0) ('denied=' + $denied2.Count)
    Check '不绑技能时工具正常跑' ($ask2.data.toolCalls -ge 1) ('toolCalls=' + $ask2.data.toolCalls)

    Write-Output "== 授权门：不联网档位下，要联网的技能直接标不可用 =="
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'off' } | Out-Null
    $l3 = Post '/api/skills/list' @{}
    $web3 = ($l3.data.skills | Where-Object { $_.id -eq 'web-research' })[0]
    Check 'web-research 标成不可用并给原因' ($web3.available -eq $false -and ([string]$web3.reason).Length -gt 0) ([string]$web3.reason)
    $sid3 = (Post '/api/sessions/new' @{}).data.sessionId
    Post '/api/agent/ask' @{ kbId = ''; question = '联网查一下'; sessionId = $sid3; skill = 'web-research' } | Out-Null
    $ev3 = Post '/api/sessions/events' @{ sessionId = $sid3 }
    $un = @($ev3.data.events | Where-Object { $_.type -eq 'skill/unavailable' })
    Check '不联网时用它会记一条 skill/unavailable' ($un.Count -ge 1) ('events=' + (@($ev3.data.events | ForEach-Object { $_.type }) -join ','))
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'auto' } | Out-Null
}
finally {
    Stop-Quiet $core
    Stop-Quiet $mock
}

Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
