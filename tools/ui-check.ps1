# 验证内核托管界面：静态资源可访问，且非白名单文件名被拒绝
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$UiDir = "$PSScriptRoot\..\shell\renderer"
)

$ErrorActionPreference = 'Continue'
# 仓颉运行时默认堆上限 256MB，真实规模的知识库索引会顶穿
$env:cjHeapSize = '2GB'
$portFile = Join-Path $env:TEMP ("itn-ui-" + [guid]::NewGuid().ToString("N") + ".port")
$dataDir = Join-Path $env:TEMP ("itn-ui-data-" + [guid]::NewGuid().ToString("N"))

$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile", "--ui-dir=$UiDir" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP "ui.out") -RedirectStandardError (Join-Path $env:TEMP "ui.err")

$port = $null
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path $portFile) {
        $txt = (Get-Content $portFile -Raw).Trim()
        if ($txt) { $port = $txt; break }
    }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Write-Output "FAIL 端口文件未生成"; $core.Kill(); exit 1 }
Write-Output "内核端口: $port"

$base = "http://127.0.0.1:$port"
function Get-ResponseInfo([string]$url) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        return @{ Status = [int]$r.StatusCode; Length = $r.RawContentLength; Type = $r.Headers["Content-Type"] }
    } catch {
        $resp = $_.Exception.Response
        if (-not $resp) { throw }
        return @{ Status = [int]$resp.StatusCode; Length = 0; Type = $resp.Headers["Content-Type"] }
    }
}
foreach ($p in @("/", "/index.html", "/app.js", "/style.css")) {
    $r = Get-ResponseInfo "$base$p"
    Write-Output ("{0} -> {1} {2} bytes type={3}" -f $p, $r.Status, $r.Length, $r.Type)
}

# 不在白名单内的文件名必须被拒绝
$r = Get-ResponseInfo "$base/nope.js"
Write-Output ("/nope.js -> {0}（应为 404）" -f $r.Status)

$core.Kill()
