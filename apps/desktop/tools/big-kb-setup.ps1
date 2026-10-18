# 准备大规模知识库与 mock 模型，供打包后的应用做容量验证
param([int]$Docs = 100)

$env:cjHeapSize = '2GB'
$kbRoot = Join-Path $env:TEMP ("itn-bigkb-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $kbRoot | Out-Null

$sentences = @(
    "检索增强生成把资料切片后按相似度取回，再交给模型作答。",
    "提示词写清楚任务、约束与输出格式，模型表现会更稳定。",
    "少样本示例和角色设定是两种常用的提示词手法。",
    "向量检索依赖嵌入模型把文本映射到同一语义空间。",
    "引用自检用于确认每条结论都能指回资料原文。"
)
for ($i = 1; $i -le $Docs; $i++) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("# 第 $i 章 主题$i")
    [void]$sb.AppendLine("")
    for ($s = 1; $s -le 5; $s++) {
        [void]$sb.AppendLine("## $i.$s 小节$s")
        [void]$sb.AppendLine("")
        for ($l = 1; $l -le 60; $l++) {
            $pick = $sentences[($i + $s + $l) % $sentences.Count]
            [void]$sb.AppendLine("$pick 这是第 $i 章第 $s 节的第 $l 句，用于撑起切片长度。")
        }
        [void]$sb.AppendLine("")
    }
    Set-Content -Path (Join-Path $kbRoot ("doc-{0:d3}.md" -f $i)) -Value $sb.ToString() -Encoding utf8
}

$mockPort = Get-Random -Minimum 20000 -Maximum 45000
$env:ITN_MOCK_EMBED_DIM = '1024'
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$mockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-bigkb-mock.log") -RedirectStandardError (Join-Path $env:TEMP "itn-bigkb-mock.err")
Start-Sleep -Milliseconds 800

$totalKB = [math]::Round((Get-ChildItem $kbRoot -Filter *.md | Measure-Object Length -Sum).Sum / 1KB, 1)
Write-Output "KB_DIR=$kbRoot"
Write-Output "MOCK_BASE=http://127.0.0.1:$mockPort/v1"
Write-Output "DOCS=$Docs  TOTAL_KB=$totalKB"
Write-Output "MOCK_PID=$($mock.Id)"
