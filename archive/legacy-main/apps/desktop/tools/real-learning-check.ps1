param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'ITN-Desktop'),
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe"
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:cjHeapSize = '2GB'
$work = Join-Path $env:TEMP ('itn-real-learning-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
# Only a disposable copy is used. Credentials stay inside that local database and never enter logs.
Copy-Item -LiteralPath (Join-Path $DataDir 'itn.db') -Destination (Join-Path $work 'itn.db')
$kb = Join-Path $work 'sources'
New-Item -ItemType Directory -Path $kb | Out-Null
[IO.File]::WriteAllText((Join-Path $kb 'input.md'), @'
# 输入与输出的约定
## 最小样例
每次任务先写输入、处理规则、期望输出和验收标准。例子：输入整数 2 和 3，规则是相加，期望输出 5；记录实际输出并与期望比较。一次正确结果不等于所有输入都正确。
## 证据
记录输入、参数、中间状态、输出与耗时。失败时先定位第一处偏差，再修改并重新执行。让另一人照着记录重做，可以检验流程是否能复现。
'@, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $kb 'validation.md'), @'
# 输入与输出的验收
## 边界与异常
正常、最小、最大、异常输入要分别验证。例子：整数相加程序对 0 和负数应保持规则，对非数字输入应明确拒绝并说明原因，不能静默返回 0。先预测输出，再执行，对照差异。
## 验收与复盘
验收标准应能客观判断：输入与输出都有记录、至少一个边界和一个异常样例有预期与实际结果、另一人可复现。每个未通过项记录证据和修复动作。总结适用条件、已知限制与下次验证点。
'@, [Text.UTF8Encoding]::new($false))
$portFile = Join-Path $work 'core.port'
$core = Start-Process -FilePath $Exe -ArgumentList @("--data-dir=$work", "--port-file=$portFile") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'core.out') -RedirectStandardError (Join-Path $work 'core.err')
try {
    for ($i=0; $i -lt 100 -and -not (Test-Path -LiteralPath $portFile); $i++) { Start-Sleep -Milliseconds 100 }
    $base = 'http://127.0.0.1:' + (Get-Content -LiteralPath $portFile -Raw).Trim()
    function Post($path, $body) {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress -Depth 30))
        $r = Invoke-RestMethod -Uri ($base + $path) -Method Post -Body $bytes -ContentType 'application/json' -TimeoutSec 420
        if ($r.code -ne 0) { throw ($path + ': ' + $r.message) }
        return $r.data
    }
    function Check($name, $pass) { if (-not $pass) { throw ('FAIL ' + $name) }; Write-Output ('PASS ' + $name) }
    Post '/api/kb/save' @{id='learning-real';name='个人学习闭环验证';rootDir=$kb} | Out-Null
    Post '/api/kb/build' @{id='learning-real'} | Out-Null
    $sid = (Post '/api/sessions/new' @{}).sessionId
    function Ask($text) {
        Write-Output ('RUN ' + $text)
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $r = Post '/api/agent/ask-pi' @{sessionId=$sid;kbId='learning-real';question=$text;web='off'}
        Write-Output ('TURN ok=' + $r.ok + ' elapsed=' + [int]$watch.Elapsed.TotalSeconds + 's')
        if (-not $r.ok) { throw ('Agent 未完成：' + $r.message) }
        return $r
    }
    Ask '请记住我的长期学习偏好：我喜欢先看具体输入输出的例子，再解释概念。' | Out-Host
    $mem = (Post '/api/learning/memories' @{kbId='learning-real'}).memories
    Check '真实模型记录有原话依据的学习偏好' (@($mem).Count -gt 0)
    $made = @{}
    foreach ($kind in @('quiz','practice','ppt','lecture')) {
        $label = @{quiz='4 道题的分阶测试';practice='实操指南';ppt='4 页在线演示课件';lecture='简洁但完整的定制讲义'}[$kind]
        $text = '请用 generate_learning_resource 工具，仅生成一份' + $label + '，kind=' + $kind + '，主题「输入、输出与验收」，detail=concise，count=4。依据当前知识库及我的学习偏好，生成后通过质检再交付。'
        Ask $text | Out-Host
        $list = @((Post '/api/learning/resources' @{kbId='learning-real'}).resources | Where-Object kind -eq $kind)
        Check ($kind + ' 真实资源落库') ($list.Count -gt 0)
        $resource = Post '/api/learning/resource' @{id=$list[0].id}
        $made[$kind] = $resource
        Check ($kind + ' 质检通过且有真实来源') (@($resource.quality.issues).Count -eq 0 -and @($resource.citations).Count -gt 0 -and (Test-Path -LiteralPath $resource.artifactPath))
        if ($kind -eq 'quiz') {
            Check '题量严格保持 4 题' (@($resource.content.questions).Count -eq 4)
            $q = $resource.content.questions[0]
            $answer = Post '/api/learning/answer' @{id=$resource.id;version=$resource.version;questionId=$q.id;choice=(([int]$q.correctIndex+1)%4);attemptId='real-first-answer'}
            Check '真实作答由服务端核验为错误' (-not $answer.correct)
        }
        if ($kind -eq 'practice') {
            Check '后续生成采用真实作答画像快照' ($resource.profileSnapshot.quizAttempts -ge 1 -and $resource.profileSnapshot.quizCorrect -eq 0)
        }
    }
    $practice = $made['practice']
    Ask ('请用 revise_learning_resource 修改资源 ' + $practice.id + '，baseVersion=1。补充非数字输入被明确拒绝时应如何记录和验收，保留其他有效内容与来源。') | Out-Host
    $revised = Post '/api/learning/resource' @{id=$practice.id}
    Check '真实模型修改生成第二版并保留旧版' ($revised.version -eq 2 -and @($revised.versions).Count -eq 2)
    Post '/api/learning/memory/forget' @{id=$mem[0].id} | Out-Null
    Check '遗忘后不再召回偏好' (-not (@((Post '/api/learning/memories' @{kbId='learning-real'}).memories).id -contains $mem[0].id))
    Write-Output ('RESULT real learning loop passed; disposable data=' + $work)
} finally {
    if ($core -and -not $core.HasExited) { $core.Kill(); $core.WaitForExit() }
}
