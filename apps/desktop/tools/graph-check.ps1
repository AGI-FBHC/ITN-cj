# 学习网络图自测：/api/graph 的节点/连边/自适应/空态
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }

$kbDir = Join-Path $env:TEMP ("itn-graph-kb-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $env:TEMP ("itn-graph-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbDir, $dataDir | Out-Null

Set-Content -Path (Join-Path $kbDir "01-提示词.md") -Encoding utf8 -Value @'
# 提示词工程

## 基本概念

提示词是给模型的输入指令，把任务、约束和输出格式写清楚，模型的表现会更稳定。

## 常见手法

少样本示例、角色设定、分步推理都是常用手法。约束越明确，结果越可控。
'@
Set-Content -Path (Join-Path $kbDir "02-检索.md") -Encoding utf8 -Value @'
# 检索增强

## 基本流程

先把资料切片向量化，检索时按相似度取回相关片段，再交给模型作答，这样答案可以标注出处、减少编造。

## 与提示词的关系

检索到的片段最终还是要拼进提示词，所以提示词写得好不好，直接影响检索增强的效果。
'@

$portFile = Join-Path $env:TEMP ("itn-graph-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-graph-core.out") -RedirectStandardError (Join-Path $env:TEMP "itn-graph-core.err")
$port = $null
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $core; throw "内核没起来" }
$base = "http://127.0.0.1:$port"

function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 6
    $f = Join-Path $env:TEMP ("itn-graph-body-" + [guid]::NewGuid().ToString("N") + ".json")
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
    Write-Output "== 空态：没索引就不画图 =="
    $e = Post '/api/graph' @{ kbId = 'nope' }
    Check '没有索引时 empty=true 且给出原因' ($e.code -eq 0 -and $e.data.empty -eq $true -and ([string]$e.data.reason).Length -gt 0) ([string]$e.data.reason)
    Check '空态不给节点' (@($e.data.nodes).Count -eq 0) ('nodes=' + @($e.data.nodes).Count)

    Write-Output "== 建索引后：节点=章节 =="
    Post '/api/kb/save' @{ id = 'g'; name = '图测试'; rootDir = $kbDir } | Out-Null
    $b = Post '/api/kb/build' @{ id = 'g' }
    Check "索引建好" ($b.code -eq 0) ("chunks=" + $b.data.chunkCount + " docs=" + $b.data.docCount)
    $g = Post '/api/graph' @{ kbId = 'g' }
    Check "empty=false" ($g.data.empty -eq $false) ("nodes=" + @($g.data.nodes).Count)
    Check '节点数 = 章节数' (@($g.data.nodes).Count -eq 2) (($g.data.nodes | ForEach-Object { $_.name }) -join ' / ')
    $n1 = $g.data.nodes[0]
    Check '节点带真实度量（切片/小节/状态）' ($n1.chunkCount -ge 1 -and $n1.sectionCount -ge 1 -and ([string]$n1.status).Length -gt 0) ($n1.name + ' chunk=' + $n1.chunkCount + ' section=' + $n1.sectionCount + ' status=' + $n1.status)
    Check '两章之间连了边' (@($g.data.edges).Count -ge 1) ('edges=' + @($g.data.edges).Count + ' weight=' + (@($g.data.edges)[0].weight))

    Write-Output "== 自适应：记一条、错一题、落一份产物，图跟着变 =="
    $ch = $n1.name
    Post '/api/study/notes/save' @{ kbId = 'g'; chapter = $ch; title = '图测试笔记'; text = '这条笔记应该挂到章节上' } | Out-Null
    Post '/api/study/quiz/submit' @{ kbId = 'g'; chapter = $ch; question = '提示词三要素？'; myAnswer = '错的'; reference = '任务/约束/输出格式'; correct = $false } | Out-Null
    $artDir = Join-Path $dataDir 'artifacts'
    New-Item -ItemType Directory -Force -Path $artDir | Out-Null
    Set-Content -Path (Join-Path $artDir ("讲义-" + $ch + ".md")) -Value "# 讲义" -Encoding utf8
    $g2 = Post '/api/graph' @{ kbId = 'g' }
    $n2 = ($g2.data.nodes | Where-Object { $_.name -eq $ch })[0]
    Check '笔记挂到了章节上' ($n2.notes -ge 1) ('notes=' + $n2.notes)
    Check '错题挂上了，且算出了今天该复习' ($n2.wrong -ge 1 -and $n2.wrongDue -ge 1) ('wrong=' + $n2.wrong + ' due=' + $n2.wrongDue)
    Check '产物挂到了对应章节' (@($n2.artifacts).Count -ge 1) ((@($n2.artifacts) | ForEach-Object { $_.name + '(' + $_.kind + ')' }) -join ', ')
    Check '概览统计同步' ($g2.data.stats.chapters -eq 2 -and $g2.data.stats.notes -ge 1) ('chapters=' + $g2.data.stats.chapters + ' notes=' + $g2.data.stats.notes)

    Write-Output "== 星云图：所有库一屏看完 =="
    # 先注册一个建不了索引的库：它不该画星云，而应进 unformed（界面画未成形模糊团 + 建立索引）
    $emptyDir = Join-Path $env:TEMP ("itn-graph-empty-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
    Set-Content -Path (Join-Path $emptyDir "a.md") -Value "# 还没建索引" -Encoding utf8
    Post '/api/kb/save' @{ id = 'gempty'; name = '没建索引的库'; rootDir = $emptyDir } | Out-Null

    $nb = Post '/api/nebula' @{}
    Check '星云接口可用' ($nb.code -eq 0) ([string]$nb.msg)
    $c1 = (@($nb.data.clusters) | Where-Object { $_.id -eq 'g' })[0]
    Check '有索引的库是一团星云' ($null -ne $c1) ("clusters=" + @($nb.data.clusters).Count)
    Check '章节点 = 章节数，且带 docKey（前端按文档分子团）' (@($c1.chapters).Count -eq 2 -and ([string]@($c1.chapters)[0].docKey).Length -gt 0) ((@($c1.chapters) | ForEach-Object { $_.name }) -join ' / ')
    Check '团内有连边' (@($c1.edges).Count -ge 1) ("edges=" + @($c1.edges).Count)
    Check 'hue 来自 8 色调色板' ($c1.hue -in @(152, 196, 240, 284, 328, 8, 40, 96)) ("hue=" + $c1.hue)
    $u1 = (@($nb.data.unformed) | Where-Object { $_.id -eq 'gempty' })[0]
    Check '没索引的库进 unformed 并给出原因' ($null -ne $u1 -and ([string]$u1.reason).Length -gt 0) ([string]$u1.reason)
    Check '中心核给出总览' ([int]$nb.data.core.clusters -ge 1 -and [int]$nb.data.core.chapters -ge 2) ("clusters=" + $nb.data.core.clusters + " chapters=" + $nb.data.core.chapters + " wrongDue=" + $nb.data.core.wrongDue)

    $nb2 = Post '/api/nebula' @{}
    $c2 = (@($nb2.data.clusters) | Where-Object { $_.id -eq 'g' })[0]
    Check '同一个库每次都是同一个颜色（加库不重排/不换色）' ($c1.hue -eq $c2.hue) ("hue=" + $c1.hue + " -> " + $c2.hue)

    Write-Output "== 上限：库数超过 8 只画最近活跃的 8 个 =="
    for ($i = 1; $i -le 9; $i++) {
        $d = Join-Path $env:TEMP ("itn-graph-many-" + $i + "-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        Set-Content -Path (Join-Path $d "a.md") -Value ("# 第 " + $i + " 门课" + [char]10 + [char]10 + "这一门课的资料，用来把库数顶过上限。") -Encoding utf8
        Post '/api/kb/save' @{ id = ("m" + $i); name = ("第 " + $i + " 门课"); rootDir = $d } | Out-Null
        Post '/api/kb/build' @{ id = ("m" + $i) } | Out-Null
    }
    $nb3 = Post '/api/nebula' @{}
    Check '只画 8 个团' (@($nb3.data.clusters).Count -eq 8) ("drawn=" + @($nb3.data.clusters).Count)
    Check '其余折成计数（foldedClusters）' ([int]$nb3.data.foldedClusters -ge 1) ("folded=" + $nb3.data.foldedClusters)
    Check '点数不超过全局上限' ([int]$nb3.data.stats.points -le [int]$nb3.data.stats.pointCap) ("points=" + $nb3.data.stats.points + " cap=" + $nb3.data.stats.pointCap)

    Write-Output "== 只读：取图不改学习数据 =="
    $before = (Post '/api/study/report' @{}).data.quizTotal
    Post '/api/graph' @{ kbId = 'g' } | Out-Null
    $after = (Post '/api/study/report' @{}).data.quizTotal
    Check '取图不改数据' ($before -eq $after) ('quizTotal=' + $before + ' -> ' + $after)
}
finally {
    Stop-Quiet $core
}

Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
