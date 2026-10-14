# 成长报告自测：六维实测参考 / 自评缺失的表示 / 最该补的一维
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }

$kbDir = Join-Path $env:TEMP ("itn-rep-kb-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $env:TEMP ("itn-rep-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbDir, $dataDir | Out-Null
Set-Content -Path (Join-Path $kbDir '01.md') -Encoding utf8 -Value @'
# 提示词工程

## 基本概念

提示词是给模型的输入指令，写清任务、约束与输出格式。

## 常见手法

少样本、角色设定、分步推理。
'@
Set-Content -Path (Join-Path $kbDir '02.md') -Encoding utf8 -Value @'
# 检索增强

## 基本流程

切片向量化后按相似度取回片段，再交给模型作答。
'@
$portFile = Join-Path $env:TEMP ("itn-rep-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-rep.out") -RedirectStandardError (Join-Path $env:TEMP "itn-rep.err")
$port = $null
for ($i = 0; $i -lt 60; $i++) { if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 250 }
if (-not $port) { Stop-Quiet $core; throw "内核没起来" }
$base = "http://127.0.0.1:$port"
function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 8
    $f = Join-Path $env:TEMP ('itn-rep-b-' + [guid]::NewGuid().ToString('N') + '.json')
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
    Post '/api/kb/save' @{ id = 'a'; name = '能力'; rootDir = $kbDir } | Out-Null
    Post '/api/kb/build' @{ id = 'a' } | Out-Null
    $ch = (Post '/api/study/tree' @{ kbId = 'a' }).data.chapters[0].name
    $chunks = (Post '/api/study/chapter' @{ kbId = 'a'; chapter = $ch }).data.chunks
    Post '/api/study/read' @{ kbId = 'a'; chunkId = $chunks[0].id; read = $true } | Out-Null
    Post '/api/study/notes/save' @{ kbId = 'a'; chapter = $ch; title = 'n'; text = 't' } | Out-Null
    for ($i = 0; $i -lt 5; $i++) { Post '/api/study/quiz/submit' @{ kbId = 'a'; chapter = $ch; question = ('q' + $i); myAnswer = 'x'; reference = 'y'; correct = ($i -lt 3) } | Out-Null }
    # 只填两个维度，其余留空：验证"没填"是 -1 而不是 0 分
    Post '/api/profile/save' @{ nickname = 'x'; goal = 'g'; weeklyHours = 8; selfScores = @{ '概念理解' = 70; '逻辑推理' = 55 } } | Out-Null

    Write-Output "== 六维：自评 + 实测参考（每一格都要有依据） =="
    $rep = (Post '/api/study/report' @{ kbId = 'a' }).data
    $abil = @($rep.abilities)
    Check '六维齐全' ($abil.Count -eq 6) (($abil | ForEach-Object { $_.key }) -join '/')
    $c1 = ($abil | Where-Object { $_.key -eq '概念理解' })[0]
    Check '自评填了的原样带回' ($c1.self -eq 70) ('self=' + $c1.self)
    Check '实测参考来自真实信号且写了依据' ($c1.evidence -ge 0 -and ([string]$c1.basis).Contains('已读切片')) ('ev=' + $c1.evidence + ' basis=' + $c1.basis)
    $c2 = ($abil | Where-Object { $_.key -eq '逻辑推理' })[0]
    Check '正确率口径：3/5 = 60' ($c2.evidence -eq 60) ('ev=' + $c2.evidence + ' basis=' + $c2.basis)
    $c3 = ($abil | Where-Object { $_.key -eq '系统设计' })[0]
    Check '没填自评用 -1 表示，不是 0 分' ($c3.self -eq -1) ('self=' + $c3.self)
    Check '每一维都有依据句' ((@($abil | Where-Object { ([string]$_.basis).Length -eq 0 }).Count) -eq 0) 'ok'
    Check '给出最该补的一维' (([string]$rep.weakest).Length -gt 0) ('weakest=' + $rep.weakest)
    Check '产物数也一并回给界面' ($null -ne $rep.artifactCount) ('artifactCount=' + $rep.artifactCount)
    Write-Output "== 最近两周：按天汇总，字段齐全 =="
    $trend = @($rep.trend)
    Check '趋势里有今天这一天' (($trend | Where-Object { $_.date -eq (Get-Date -Format 'yyyy-MM-dd') }).Count -eq 1) (($trend | ForEach-Object { $_.date }) -join ',')
    $today = ($trend | Where-Object { $_.date -eq (Get-Date -Format 'yyyy-MM-dd') })[0]
    Check '今天的读/做/记与总数对得上' ($today.read -eq 1 -and $today.quiz -eq 5 -and $today.notes -eq 1) ("read=" + $today.read + " quiz=" + $today.quiz + " notes=" + $today.notes)
    Check '每一天都带 read/quiz/notes/done/turns 五个字段' (($trend | Where-Object { $null -eq $_.read -or $null -eq $_.quiz -or $null -eq $_.notes -or $null -eq $_.done -or $null -eq $_.turns }).Count -eq 0) 'ok'

    Write-Output "== 报告能落成本地产物（成长页「存成产物」走的就是这条路） =="
    $saved = Post '/api/artifacts/save' @{ name = '成长报告-自测.md'; content = '# 学习报告 自测' }
    Check '保存成功并回文件名' ($saved.code -eq 0 -and ([string]$saved.data.name) -eq '成长报告-自测.md') (([string]$saved.data.name) + ' -> ' + ([string]$saved.data.path))
    $artFile = Join-Path $dataDir 'artifacts\成长报告-自测.md'
    Check '文件真的落在 artifacts 里' (Test-Path $artFile) $artFile
    Check '内容就是这个 Markdown' ((Get-Content $artFile -Raw -Encoding UTF8).Contains('学习报告')) 'ok'
    # 重名不覆盖：再存一次应该自动加序号
    $again = Post '/api/artifacts/save' @{ name = '成长报告-自测.md'; content = '第二次' }
    Check '重名自动加序号（不覆盖上一份）' ($again.code -eq 0 -and ([string]$again.data.name) -ne '成长报告-自测.md') ([string]$again.data.name)
    Check '缺参数会被拒' ((Post '/api/artifacts/save' @{ name = ''; content = '' }).code -ne 0) 'ok'

    Write-Output "== 不够就不给：练习不足 4 题时逻辑推理不给参考 =="
    $dataDir2 = Join-Path $env:TEMP ("itn-rep2-data-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $dataDir2 | Out-Null
    $portFile2 = Join-Path $env:TEMP ("itn-rep2-" + [guid]::NewGuid().ToString("N") + ".port")
    $core2 = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir2", "--port-file=$portFile2" -PassThru -WindowStyle Hidden
    $port2 = $null
    for ($i = 0; $i -lt 60; $i++) { if (Test-Path $portFile2) { $t2 = (Get-Content $portFile2 -Raw).Trim(); if ($t2) { $port2 = $t2; break } }; Start-Sleep -Milliseconds 250 }
    $base2 = "http://127.0.0.1:$port2"
    function Post2($path, $bodyObj) {
        $json = $bodyObj | ConvertTo-Json -Compress -Depth 8
        $f = Join-Path $env:TEMP ('itn-rep2-b-' + [guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllText($f, $json, [Text.UTF8Encoding]::new($false))
        $raw = curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@$f" "$base2$path"
        Remove-Item $f -Force -ErrorAction SilentlyContinue
        return $raw | ConvertFrom-Json
    }
    $r2 = (Post2 '/api/study/report' @{}).data
    $b2 = ($r2.abilities | Where-Object { $_.key -eq '逻辑推理' })[0]
    Check '没练习时不给参考分（-1）并说明原因' ($b2.evidence -eq -1 -and ([string]$b2.basis).Contains('不足')) ('ev=' + $b2.evidence + ' basis=' + $b2.basis)
    Stop-Quiet $core2
}
finally {
    Stop-Quiet $core
}
Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
