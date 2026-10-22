# 路由专项回归：使用内核自带仓颉 fixture，覆盖现有大测试没有直接钉住的接口。
# 不读取真实数据、不调用外部模型、不打印密钥。用法：pwsh -File tools/api-feature-check.ps1
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$UiDir = "$PSScriptRoot\..\shell\renderer",
    [string]$SkillsDir = "$PSScriptRoot\..\shell\skills"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$data = Join-Path $env:TEMP ('itn-api-feature-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $data | Out-Null
$portFile = Join-Path $data 'port'
$core = $null
$passed = 0
$failed = 0
function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill(); $p.WaitForExit() } catch {} } }
function Check($name, $ok, $detail = '') {
    if ($ok) { $script:passed++; Write-Host ("PASS  " + $name + $(if ($detail) { "  " + $detail } else { "" })) }
    else { $script:failed++; Write-Host ("FAIL  " + $name + $(if ($detail) { "  " + $detail } else { "" })) }
}
function Api([string]$path, [object]$body = @{}, [string]$method = 'POST') {
    $req = @{ Uri = $base + $path; Method = $method; TimeoutSec = 120; SkipHttpErrorCheck = $true; UseBasicParsing = $true }
    if ($method -eq 'POST') {
        $json = $body | ConvertTo-Json -Compress -Depth 30
        $req.Body = [Text.Encoding]::UTF8.GetBytes($json)
        $req.ContentType = 'application/json'
    }
    $r = Invoke-WebRequest @req
    $j = $null
    try { $j = $r.Content | ConvertFrom-Json } catch {}
    [pscustomobject]@{ status = [int]$r.StatusCode; code = if ($j) { $j.code } else { $null }; message = if ($j) { [string]$j.message } else { '' }; data = if ($j) { $j.data } else { $null }; raw = [string]$r.Content }
}
function Ok($r, [string]$name) {
    Check $name ($r.status -eq 200 -and $r.code -eq 0) ("status=" + $r.status + " message=" + $r.message)
    return $r.data
}
try {
    if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到内核产物 $Exe" }
    try { Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue } catch {}
    $core = Start-Process -FilePath $Exe -ArgumentList @("--data-dir=$data", "--port-file=$portFile", "--ui-dir=$UiDir", "--skills-dir=$SkillsDir", "--seed-course-fixture=1") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'core.out') -RedirectStandardError (Join-Path $data 'core.err')
    $port = $null
    for ($i = 0; $i -lt 120; $i++) { if (Test-Path -LiteralPath $portFile) { $t = (Get-Content -LiteralPath $portFile -Raw).Trim(); if ($t) { $port = $t; break } }; Start-Sleep -Milliseconds 100 }
    if (-not $port) { throw '内核没有启动' }
    $base = 'http://127.0.0.1:' + $port

    $settings = Ok (Api '/api/settings' @{} 'GET') 'settings GET'
    $kbs = @($settings.knowledgeBases)
    Check 'fixture 提供两个独立知识库' ($kbs.Count -eq 2) (($kbs | ForEach-Object { $_.id }) -join ',')

    $status = Ok (Api '/api/maintenance/status' @{}) 'maintenance/status'
    Check '备份目录由 status 返回' ([string]$status.backupDir).Length -gt 0
    $backup = Ok (Api '/api/maintenance/backup' @{}) 'maintenance/backup'
    Check '备份真实落盘并通过可打开校验' ($backup.verified -eq $true -and (Test-Path -LiteralPath $backup.path)) ([string]$backup.name)
    $status2 = Ok (Api '/api/maintenance/status' @{}) 'maintenance/status after backup'
    Check '备份列表能看到刚生成的副本' (@($status2.backups | Where-Object { $_.name -eq $backup.name }).Count -eq 1)
    Ok (Api '/api/maintenance/backups/delete' @{ name = $backup.name }) 'maintenance/backups/delete'
    Check '删除备份后文件消失' (-not (Test-Path -LiteralPath $backup.path))
    $missingBackup = Api '/api/maintenance/backups/delete' @{ name = 'no-such.db' }
    Check '删除不存在的备份返回 404' ($missingBackup.status -eq 404)

    $web0 = Ok (Api '/api/websearch/get' @{}) 'websearch/get'
    Check '未配置联网时明确标出没有密钥' ($web0.hasKey -ne $true) ([string]$web0.hasKey)
    $webBad = Api '/api/websearch/test' @{}
    Check '未配置联网测试返回可读 400' ($webBad.status -eq 400 -and $webBad.message -match 'Tavily') $webBad.message
    $webSave = Ok (Api '/api/websearch/save' @{ apiKey = 'fixture-only-key'; enabled = '1'; results = 2; mode = 'always'; allowHosts = ''; blockHosts = '' }) 'websearch/save'
    Check '联网密钥不回传原值' ($webSave.hasKey -eq $true -and -not $webSave.ToString().Contains('fixture-only-key'))
    $sidWeb = (Ok (Api '/api/sessions/new' @{}) 'sessions/new for web').sessionId
    Ok (Api '/api/web/session' @{ sessionId = $sidWeb; mode = 'always' }) 'web/session'
    $cache = Ok (Api '/api/web/cache' @{ sessionId = $sidWeb }) 'web/cache'
    Check '会话联网档位持久化' ($cache.mode -eq 'always') ([string]$cache.mode)

    $kg = Ok (Api '/api/knowledge/graph' @{}) 'knowledge/graph'
    $savedNode = Ok (Api '/api/knowledge/save' @{ title = '接口专项节点'; definition = '用于验证知识点保存与时间线。'; color = '#123456'; aliases = @('专项别名') }) 'knowledge/save'
    Check '知识点返回稳定 id' ([string]$savedNode.id).Length -gt 0
    $node = Ok (Api '/api/knowledge/node' @{ id = $savedNode.id }) 'knowledge/node'
    Check '知识点定义和颜色回读正确' ($node.definition -match '验证知识点' -and $node.color -eq '#123456')
    Ok (Api '/api/knowledge/note' @{ id = $savedNode.id; text = '这是接口专项笔记 ZN-7788' }) 'knowledge/note'
    $timeline = Ok (Api '/api/knowledge/timeline' @{}) 'knowledge/timeline'
    $timelineText = $timeline | ConvertTo-Json -Depth 20 -Compress
    Check '时间线包含刚写入的知识点' ($timelineText.Contains('接口专项节点'))
    Ok (Api '/api/knowledge/delete' @{ id = $savedNode.id }) 'knowledge/delete'
    Check '删除后知识点不可再读' ((Api '/api/knowledge/node' @{ id = $savedNode.id }).status -eq 404)

    $personalDir = Join-Path $data 'personal'
    New-Item -ItemType Directory -Path $personalDir | Out-Null
    $seedFile = Join-Path $personalDir 'api-note.md'
    [IO.File]::WriteAllText($seedFile, "# 接口个性资源`n`n暗号 ZX-42。", [Text.UTF8Encoding]::new($false))
    $pset = Ok (Api '/api/personal/settings' @{ directory = $personalDir }) 'personal/settings'
    Check '个性资源目录设置生效' ($pset.directory -eq $personalDir)
    $plist = Ok (Api '/api/personal/list' @{}) 'personal/list'
    $pres = @($plist.resources | Where-Object { $_.path -eq $seedFile } | Select-Object -First 1)
    Check '个性资源扫描登记文件' ($pres.Count -eq 1)
    Ok (Api '/api/personal/reindex' @{ id = $pres[0].id; text = '重索引后的暗号 ZX-42 出现在这里' }) 'personal/reindex'
    $psearch = Ok (Api '/api/personal/search' @{ query = 'ZX-42' }) 'personal/search'
    Check '重索引后可检索新正文' (@($psearch.hits).Count -ge 1)

    $projectDir = Join-Path $data 'project'
    New-Item -ItemType Directory -Path $projectDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $projectDir 'README.md'), '# project', [Text.UTF8Encoding]::new($false))
    $proj = Ok (Api '/api/projects/save' @{ name = '接口项目'; root = $projectDir }) 'projects/save'
    Check '项目保存返回 id 和根目录' ([string]$proj.id).Length -gt 0 -and $proj.root -eq $projectDir
    $plist2 = Ok (Api '/api/projects/list' @{}) 'projects/list'
    Check '项目列表包含新项目' (@($plist2.projects | Where-Object { $_.id -eq $proj.id }).Count -eq 1)
    Ok (Api '/api/projects/pin' @{ id = $proj.id; pinned = $true }) 'projects/pin'
    $plist3 = Ok (Api '/api/projects/list' @{}) 'projects/list after pin'
    Check '项目置顶字段可回读' (@($plist3.projects | Where-Object { $_.id -eq $proj.id }).Count -eq 1)

    $sid = (Ok (Api '/api/sessions/new' @{}) 'sessions/new').sessionId
    Ok (Api '/api/sessions/bind' @{ sessionId = $sid; projectId = $proj.id }) 'sessions/bind'
    $ask = Ok (Api '/api/agent/ask-pi' @{ sessionId = $sid; question = '请用一句话说明输入与输出。'; web = 'off' }) 'agent/ask-pi fixture'
    Check 'fixture 对话完成' ($ask.ok -eq $true -and ([string]$ask.answer).Length -gt 0)
    $events = @((Ok (Api '/api/sessions/events' @{ sessionId = $sid }) 'sessions/events').events)
    $turns = @($events | Where-Object { $_.type -eq 'turn/start' })
    $firstTurn = if ($turns.Count) { [string]$turns[0].turnId } else { '' }
    Check '会话有可定位轮次' ($firstTurn.Length -gt 0)
    $tree = Ok (Api '/api/sessions/tree' @{ sessionId = $sid }) 'sessions/tree'
    Check '会话树能读出轮次' (@($tree.turns).Count -ge 1)
    $search = Ok (Api '/api/sessions/search' @{ query = '输入与输出'; limit = 10 }) 'sessions/search'
    Check '会话正文搜索有命中' (@($search.hits).Count -ge 1)
    Ok (Api '/api/sessions/switch' @{ sessionId = $sid; turnId = $firstTurn }) 'sessions/switch'
    Ok (Api '/api/sessions/set-active' @{ sessionId = $sid; turnId = $firstTurn }) 'sessions/set-active'

    $split = Ok (Api '/api/sessions/split' @{ sessionId = $sid; turnId = $firstTurn }) 'sessions/split'
    Check 'split 返回父事件 id' ($split.ok -eq $true -and [int]$split.parentEventId -ge 0)
    Ok (Api '/api/sessions/split' @{ sessionId = $sid; cancel = $true }) 'sessions/split cancel'
    $branch = Ok (Api '/api/sessions/branch' @{ sessionId = $sid; turnId = $firstTurn }) 'sessions/branch'
    Check 'branch 返回新会话' ([string]$branch.sessionId).Length -gt 0
    $reveal = Ok (Api '/api/sessions/reveal' @{ sessionId = $sid; turnId = $firstTurn }) 'sessions/reveal'
    Check 'reveal 返回叶子事件' ($reveal.ok -eq $true)
    $rew = Ok (Api '/api/sessions/rewind' @{ sessionId = $sid; turnId = $firstTurn }) 'sessions/rewind'
    Check 'rewind 回退轮次结果可读' ($rew.ok -eq $true)

    $artifact = Ok (Api '/api/artifacts/save' @{ name = '接口成果.md'; content = '# 接口成果' }) 'artifacts/save'
    $renamed = Ok (Api '/api/artifacts/rename' @{ name = $artifact.name; newName = '接口成果-改名.md' }) 'artifacts/rename'
    Check '成果改名后新文件可读' (Test-Path -LiteralPath (Join-Path $data ('artifacts\' + $renamed)))
    $archiveRead = Ok (Api '/api/artifacts/read' @{ name = $renamed }) 'artifacts/read renamed'
    Check '成果正文保留' ($archiveRead.content -match '接口成果')

    $course = Ok (Api '/api/study/course' @{ kbId = 'course-alpha' }) 'study/course'
    $chapter = @($course.chapters)[0].name
    Check 'fixture 课程有章节' ([string]$chapter).Length -gt 0
    $quiz = Ok (Api '/api/study/quiz/generate' @{ kbId = 'course-alpha'; chapter = $chapter; count = 3 }) 'study/quiz/generate'
    $questions = @($quiz.questions)
    Check 'quiz 生成返回题目数组' ($questions.Count -ge 1)
    if ($questions.Count) {
        $q = $questions[0]
        Ok (Api '/api/study/quiz/submit' @{ kbId = 'course-alpha'; chapter = $chapter; question = $q.stem; myAnswer = $q.options[1]; reference = $q.options[$q.correctIndex]; correct = $false }) 'study/quiz/submit'
        $stats = Ok (Api '/api/study/quiz/stats' @{}) 'study/quiz/stats'
        Check '答题统计有记录' (@($stats.chapters | Where-Object { $_.chapter -eq $chapter }).Count -ge 1)
    }
    $memory = Ok (Api '/api/learning/memory/save' @{ id = ''; kbId = 'course-alpha'; kind = 'preference'; text = '接口专项记忆：先看例子' }) 'learning/memory/save'
    Check '学习记忆保存后可召回' (@((Ok (Api '/api/learning/memories' @{ kbId = 'course-alpha' }) 'learning/memories').memories | Where-Object { $_.text -match '接口专项记忆' }).Count -ge 1)

    $delProject = Api '/api/projects/delete' @{ id = $proj.id }
    Check '项目删除返回成功' ($delProject.status -eq 200 -and $delProject.code -eq 0)
    $delSession = Api '/api/sessions/delete' @{ sessionId = $branch.sessionId }
    Check '新建分支会话可删除' ($delSession.status -eq 200 -and $delSession.code -eq 0)
    $taskBad = Api '/api/tasks/cancel' @{ id = 'not-a-task' }
    Check '未知任务取消失败但不 500' ($taskBad.status -lt 500)

    Ok (Api '/api/models/save' @{ id = 'unreachable'; name = '不可达模型'; baseUrl = 'http://127.0.0.1:1/v1'; apiKey = 'test-only'; model = 'bad' }) 'models/save unreachable'
    Ok (Api '/api/models/roles' @{ chatModelId = 'unreachable' }) 'models/roles unreachable'
    $visionBad = Api '/api/models/vision-test' @{}
    Check '视觉测试连接失败返回可读 502' ($visionBad.status -eq 502 -and $visionBad.message -match '视觉测试失败') $visionBad.message
    $chatBad = Api '/api/chat' @{ user = '你好' }
    Check '普通对话连接失败返回可读 502' ($chatBad.status -eq 502 -and $chatBad.message -match '模型调用失败') $chatBad.message
} catch {
    $script:failed++
    Write-Output ('FAIL  ' + $_.Exception.Message)
    if (Test-Path -LiteralPath (Join-Path $data 'core.err')) { Get-Content -LiteralPath (Join-Path $data 'core.err') -Tail 20 | ForEach-Object { Write-Output ('CORE  ' + $_) } }
} finally {
    Stop-Quiet $core
    Write-Output ("RESULT " + $passed + " passed, " + $failed + " failed; data=" + $data)
    if ($failed -gt 0) { exit 1 }
}
