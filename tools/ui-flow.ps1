# 为界面全流程验证准备环境：本地 mock 模型 + 示例知识库 + 带界面的内核
# 只负责拉起进程并打印地址，交互由外部驱动

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path "$PSScriptRoot\.."

$mockPort = Get-Random -Minimum 20000 -Maximum 45000
$mockLog = Join-Path $env:TEMP "itn-flow-mock.log"
$mock = Start-Process -FilePath "python" -ArgumentList "$PSScriptRoot\mock-openai\server.py", "$mockPort" -PassThru -WindowStyle Hidden -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"

$kbRoot = Join-Path $env:TEMP ("itn-flow-kb-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $kbRoot "img") | Out-Null

$md = @"
# 提示词工程入门

## 什么是提示词

提示词是给模型的输入指令。写清楚任务、约束和输出格式，模型的表现会更稳定。

## 常见手法

少样本示例、角色设定、分步推理都是常用手法。约束越明确，结果越可控。

![示意图](img/demo.png)

上图展示了提示词与输出的对应关系。
"@
Set-Content -Path (Join-Path $kbRoot "01-提示词.md") -Value $md -Encoding utf8

$md2 = @"
# 检索增强生成

## 基本流程

先把资料切片并向量化，检索时按相似度取回相关片段，再交给模型作答。
这样答案可以标注出处，减少凭空编造。
"@
Set-Content -Path (Join-Path $kbRoot "02-RAG.md") -Value $md2 -Encoding utf8
[IO.File]::WriteAllBytes((Join-Path $kbRoot "img\demo.png"), [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))

$dataDir = Join-Path $env:TEMP ("itn-flow-data-" + [guid]::NewGuid().ToString("N"))
$portFile = Join-Path $env:TEMP ("itn-flow-" + [guid]::NewGuid().ToString("N") + ".port")
$core = Start-Process -FilePath "$repo\dist\core\itn-desktop-core.exe" -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile", "--ui-dir=$repo\shell\renderer" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "itn-flow-core.out") -RedirectStandardError (Join-Path $env:TEMP "itn-flow-core.err")

$port = $null
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path $portFile) {
        $t = (Get-Content $portFile -Raw).Trim()
        if ($t) { $port = $t; break }
    }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { throw "内核未启动" }

Write-Output "UI_URL=http://127.0.0.1:$port/"
Write-Output "MOCK_BASE=http://127.0.0.1:$mockPort/v1"
Write-Output "KB_DIR=$kbRoot"
Write-Output "CORE_PID=$($core.Id)"
Write-Output "MOCK_PID=$($mock.Id)"
