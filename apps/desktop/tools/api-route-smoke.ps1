# 145 条已注册路由的入口烟雾：逐条发空 JSON / 坏 JSON，断言无 5xx、无未注册路由。
# 不读取真实数据；行为测试由 smoke / api-feature-check / 各专项脚本负责。
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$UiDir = "$PSScriptRoot\..\shell\renderer",
    [string]$SkillsDir = "$PSScriptRoot\..\shell\skills"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'
$data = Join-Path $env:TEMP ('itn-api-routes-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $data | Out-Null
$portFile = Join-Path $data 'port'
$core = $null
function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill(); $p.WaitForExit() } catch {} } }
try {
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\core\src\api\api.cj') -Raw
    $match = [regex]::Match($source, 'let routes = \[(?<body>[\s\S]*?)\]\s*for \(r in routes\)')
    if (-not $match.Success) { throw '无法从 api.cj 解析路由表' }
    $routes = @([regex]::Matches($match.Groups['body'].Value, '"(/[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    if ($routes.Count -ne 145) { throw ('路由数不是预期的 145：' + $routes.Count) }
    try { Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue } catch {}
    $core = Start-Process -FilePath $Exe -ArgumentList @("--data-dir=$data", "--port-file=$portFile", "--ui-dir=$UiDir", "--skills-dir=$SkillsDir") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'core.out') -RedirectStandardError (Join-Path $data 'core.err')
    for ($i = 0; $i -lt 120 -and -not (Test-Path $portFile); $i++) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $portFile)) { throw '内核没有启动' }
    $base = 'http://127.0.0.1:' + (Get-Content -LiteralPath $portFile -Raw).Trim()
    $rows = @()
    foreach ($route in $routes) {
        $method = if ($route -eq '/health' -or $route -eq '/api/settings') { 'GET' } else { 'POST' }
        $empty = Invoke-WebRequest -Uri ($base + $route) -Method $method -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
        $badStatus = $null
        if ($method -eq 'POST') {
            $bad = Invoke-WebRequest -Uri ($base + $route) -Method 'POST' -Body '{' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
            $badStatus = [int]$bad.StatusCode
        }
        $rows += [pscustomobject]@{ route = $route; method = $method; emptyStatus = [int]$empty.StatusCode; badStatus = $badStatus; emptyBytes = ([string]$empty.Content).Length }
    }
    $bad5xx = @($rows | Where-Object { $_.emptyStatus -ge 500 -or ($null -ne $_.badStatus -and $_.badStatus -ge 500) })
    $unknown = @($rows | Where-Object { $_.emptyStatus -eq 404 -and $_.route -notin @('/api/models/test','/api/models/diagnose','/api/kb/build','/api/kb/stats','/api/kb/document','/api/web/cache/delete','/api/skills/read','/api/knowledge/node','/api/personal/read','/api/learning/resource','/api/sessions/reveal','/api/study/tree') })
    $health = $rows | Where-Object { $_.route -eq '/health' }
    $settings = $rows | Where-Object { $_.route -eq '/api/settings' }
    $reportDir = Join-Path $PSScriptRoot '..\tmp\audit'
    New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    $rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDir 'api-route-smoke.json') -Encoding utf8
    if ($health.emptyStatus -ne 200 -or $settings.emptyStatus -ne 200) { throw 'health/settings 未返回 200' }
    if ($bad5xx.Count -gt 0) { $bad5xx | Format-Table route,emptyStatus,badStatus -AutoSize | Out-Host; throw ('出现 5xx：' + $bad5xx.Count + ' 条') }
    if ($unknown.Count -gt 0) { $unknown | Format-Table route,emptyStatus -AutoSize | Out-Host; throw ('出现未注册路由：' + $unknown.Count + ' 条') }
    Write-Host ('RESULT routes=' + $rows.Count + ' no5xx=yes noUnknownRoute=yes report=' + (Join-Path $reportDir 'api-route-smoke.json'))
} finally {
    Stop-Quiet $core
}
