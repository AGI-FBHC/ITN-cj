# 知识库导入自测：文件夹导入 / 单文件导入（连引用的图片一起）/ 自适应分章 /
# 点文件不再被当成"读不了的文件" / 向量服务没有 /embeddings 时错误文案要短。
# 临时目录沿用项目里其它 check 脚本的做法，留在 %TEMP% 便于失败后排查。
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
# 中文 JSON 要按 UTF-8 解：脚本被重定向到文件运行时，默认控制台编码会把中文解坏、连逗号都吃掉
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }
function FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $l.Start()
    $p = $l.LocalEndpoint.Port
    $l.Stop()
    return $p
}

$kbDir = Join-Path $env:TEMP ("itn-imp-kb-" + [guid]::NewGuid().ToString("N"))
$oneDir = Join-Path $env:TEMP ("itn-imp-one-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $env:TEMP ("itn-imp-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbDir, (Join-Path $kbDir "fig"), (Join-Path $oneDir "img"), $dataDir | Out-Null

$mdText = @"
# 提示词工程

## 基本概念

提示词是给模型的输入指令。![示意图](fig/shot.png)

## 常见手法

少样本示例、角色设定、分步推理都是常用手法。
"@
[IO.File]::WriteAllText((Join-Path $kbDir "01-提示词.md"), $mdText, [Text.UTF8Encoding]::new($false))

# 无标题的纯文本：只靠它自己的编号（第一章 / 一、/ 第二章）来分章
$txtText = @"
第一章 概览

这是第一章的正文，用来验证材料自己没有 Markdown 标题时能不能按它自己的编号分章。正文要够长，才不会被当成标题。

一、起点

起点这一节的正文，同样需要写到足够的长度，这样上面那行才会被认成节标题而不是普通句子。

二、做法

做法这一节的正文，说明把任务、约束与输出格式写清楚，产出会更稳定一些。

第二章 方法

这是第二章的正文，说明方法部分的组织方式，内容长度同样要超过二十个字符。
"@
[IO.File]::WriteAllText((Join-Path $kbDir "讲义.txt"), $txtText, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $kbDir ".nojekyll"), "", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $kbDir "旧稿.pdf"), "%PDF-1.4 fake", [Text.UTF8Encoding]::new($false))

# 1x1 PNG
$png = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9QJ4AAAAAElFTkSuQmCC")
[IO.File]::WriteAllBytes((Join-Path $kbDir "fig\shot.png"), $png)
[IO.File]::WriteAllBytes((Join-Path $oneDir "img\a.png"), $png)

# 单文件导入的素材：放在别处的独立文件，引用同目录 img/ 下的图片
$oneFile = Join-Path $oneDir "散落的一课.md"
$oneText = @"
# 散落的一课

这个是单独导入的文件，它引用了一张同目录的图片。![图](img/a.png)

正文用来确认单文件导入之后切片是正常的。
"@
[IO.File]::WriteAllText($oneFile, $oneText, [Text.UTF8Encoding]::new($false))
$pdfOnly = Join-Path $oneDir "只有一份.pdf"
[IO.File]::WriteAllText($pdfOnly, "%PDF-1.4 fake", [Text.UTF8Encoding]::new($false))

$portFile = Join-Path $env:TEMP ("itn-imp-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-imp-core.out") -RedirectStandardError (Join-Path $env:TEMP "itn-imp-core.err")
$port = $null
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $core; throw "内核没起来" }
$base = "http://127.0.0.1:$port"

function PostRaw($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 6
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $resp = Invoke-WebRequest -Uri ("$base" + $path) -Method Post -Body $bytes -ContentType "application/json" -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
    return $resp.Content
}
function Post($path, $bodyObj) { return (PostRaw $path $bodyObj | ConvertFrom-Json) }
function Get-KbList { return (Invoke-WebRequest -Uri ($base + '/api/settings') -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck).Content | ConvertFrom-Json | ForEach-Object { $_.data.knowledgeBases } }

$failed = 0
# 错误响应的字段是 message；成功是 code=0 + data。
function Err($r) { if ($r -and $r.message) { return [string]$r.message } else { return "" } }
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output ("  PASS  " + $name + "  " + $detail) }
    else { Write-Output ("  FAIL  " + $name + "  " + $detail); $script:failed++ }
}

$mock404 = $null
try {
    Write-Output "== 导入文件夹 =="
    $r = Post '/api/kb/import' @{ path = $kbDir; kind = 'dir' }
    Check '文件夹导入成功' ($r.code -eq 0) (Err $r)
    $imp = $r.data.imported
    $id = [string]$imp.id
    Check '识别成文件夹、原地登记（不复制）' ($imp.kind -eq 'dir' -and $imp.copied -eq 0 -and $imp.rootDir -eq $kbDir) ("kind=" + $imp.kind + " copied=" + $imp.copied)
    Check '登记到设置里且 rootDir 是原目录' ((@($r.data.knowledgeBases) | Where-Object { $_.id -eq $id -and $_.rootDir -eq $kbDir }).Count -eq 1) ("id=" + $id)
    Check '能读到的资料篇数 = 2（md + txt）' ($imp.docs -eq 2) ("docs=" + $imp.docs)

    Write-Output "== 建索引：分章自适应 + 点文件不进报告 =="
    $b = Post '/api/kb/build' @{ id = $id }
    Check '建索引成功' ($b.code -eq 0) (Err $b)
    Check '.nojekyll 不再被算成读不了的资料' (([string]$b.data.skippedSummary) -notmatch 'nojekyll') ([string]$b.data.skippedSummary)
    Check '真读不了的 PDF 仍然如实报出来' (([string]$b.data.skippedSummary) -match 'pdf') ([string]$b.data.skippedSummary)
    $tree = Post '/api/study/tree' @{ kbId = $id }
    $chapters = @($tree.data.chapters | ForEach-Object { [string]$_.name })
    Check '无标题的 txt 按它自己的编号分章' (($chapters -join '|') -match '第一章' -and ($chapters -join '|') -match '第二章') ($chapters -join ' / ')
    Check 'Markdown 的标题仍然按标题分章' (($chapters -join '|') -match '提示词工程') ($chapters -join ' / ')

    Write-Output "== 导入单个文件 =="
    $r2 = Post '/api/kb/import' @{ path = $oneFile; kind = 'file' }
    Check '单文件导入成功' ($r2.code -eq 0) (Err $r2)
    $imp2 = $r2.data.imported
    $id2 = [string]$imp2.id
    $destDir = Join-Path (Join-Path $dataDir "kb") (Join-Path $id2 "source")
    Check '复制进受管资料目录' ($imp2.kind -eq 'file' -and $imp2.rootDir -eq $destDir) ([string]$imp2.rootDir)
    Check '连它引用的图片一起复制（2 个文件）' ($imp2.copied -eq 2) ("copied=" + $imp2.copied)
    Check '资料文件真的落在资料目录里' (Test-Path (Join-Path $destDir "散落的一课.md")) "散落的一课.md"
    Check '图片保持了相对路径 img/a.png' (Test-Path (Join-Path $destDir "img\a.png")) "img\a.png"
    $b2 = Post '/api/kb/build' @{ id = $id2 }
    Check '单文件也能建成索引' ($b2.code -eq 0 -and $b2.data.chunkCount -gt 0) ("chunks=" + $b2.data.chunkCount)
    Check '图片被识别到（>=1 张）' ($b2.data.imageCount -ge 1) ("images=" + $b2.data.imageCount)

    Write-Output "== 同一处资料再导入一次：复用同一个库 =="
    $kbBefore = @(Get-KbList).Count
    $r2b = Post '/api/kb/import' @{ path = $oneFile; kind = 'file' }
    Check '再次导入认出同一处资料（id 不变）' ($r2b.code -eq 0 -and ([string]$r2b.data.imported.id) -eq $id2) ('id=' + $r2b.data.imported.id)
    Check '不会又建一个知识库' ((@(Get-KbList).Count) -eq $kbBefore) ('前 ' + $kbBefore + ' 后 ' + @(Get-KbList).Count)
    Write-Output "== 读不了的格式要说清楚，而不是静默失败 =="
    $r3 = Post '/api/kb/import' @{ path = $pdfOnly; kind = 'file' }
    Check 'PDF 单文件被拒且给出可操作的建议' ($r3.code -ne 0 -and (Err $r3) -match 'Markdown') (Err $r3)

    Write-Output "== 向量服务没有 /embeddings：错误文案要短 =="
    $p404 = FreePort
    $mock404 = Start-Process -FilePath "python" -ArgumentList (Join-Path $PSScriptRoot "mock-404\server.py"), "$p404" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-imp-404.out") -RedirectStandardError (Join-Path $env:TEMP "itn-imp-404.err")
    Start-Sleep -Milliseconds 800
    Post '/api/models/save' @{ id = 'bad'; name = '假端点'; baseUrl = ("http://127.0.0.1:" + $p404 + "/v1"); apiKey = 'k'; model = 'm'; embeddingModel = 'm' } | Out-Null
    Post '/api/models/roles' @{ embedModelId = 'bad' } | Out-Null
    $b3 = Post '/api/kb/build' @{ id = $id }
    $err = [string]$b3.data.embedError
    Check '建索引照样成功（只是没有向量）' ($b3.code -eq 0 -and $b3.data.embedded -eq 0) ("embedded=" + $b3.data.embedded)
    Check '错误里不再夹带上游 HTML' ($err.Length -gt 0 -and $err -notmatch 'html' -and $err -notmatch 'openresty') $err
    Check '错误文案短（<=120 字符）' ($err.Length -le 120) ("len=" + $err.Length)
} finally {
    Stop-Quiet $mock404
    Stop-Quiet $core
}

Write-Output ""
if ($failed -eq 0) { Write-Output "KB-IMPORT-OK（全部通过）" } else { Write-Output ("KB-IMPORT-FAILED：" + $failed + " 项失败"); exit 1 }
