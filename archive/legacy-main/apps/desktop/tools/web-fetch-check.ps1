# web_fetch 端到端自测：本地迷你网站 + 内核
#
# 覆盖：
#  - 抓中文 > 8KB 的页面（验证响应体不是按 8KB 分片各自解码 —— 那样中文会被切断）
#  - 跟 302 跳转
#  - 二进制响应如实报"读不了"
#  - 落到 <数据目录>/webcache 且带 frontmatter；缓存能列、能删
param(
    [string]$Exe = "$PSScriptRoot\..\dist\core\itn-desktop-core.exe",
    [string]$MockDir = "$PSScriptRoot\mock-web"
)
$ErrorActionPreference = 'Stop'
$env:cjHeapSize = '2GB'

function Stop-Quiet($p) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} } }

$dataDir = Join-Path $env:TEMP ("itn-web-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$portFile = Join-Path $env:TEMP ("itn-web-" + [guid]::NewGuid().ToString("N") + ".port")

# 1) 本地"网站"
$mockLog = Join-Path $env:TEMP "itn-web-mock.log"
$mock = Start-Process -FilePath "python" -ArgumentList "$MockDir\server.py", "0" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"
$mockPort = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Path $mockLog) {
        $t = (Get-Content $mockLog -Raw).Trim()
        if ($t) { $mockPort = $t; break }
    }
}
if (-not $mockPort) { Stop-Quiet $mock; throw "迷你网站没起来" }

# 2) 内核
$core = Start-Process -FilePath $Exe -ArgumentList "--data-dir=$dataDir", "--port-file=$portFile" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP "itn-web-core.out") -RedirectStandardError (Join-Path $env:TEMP "itn-web-core.err")
$port = $null
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $portFile) { $t = (Get-Content $portFile -Raw).Trim(); if ($t) { $port = $t; break } }
    Start-Sleep -Milliseconds 250
}
if (-not $port) { Stop-Quiet $mock; Stop-Quiet $core; throw "内核没起来" }
$base = "http://127.0.0.1:$port"
$web = "http://127.0.0.1:$mockPort"

function Post($path, $bodyObj) {
    $json = $bodyObj | ConvertTo-Json -Compress -Depth 5
    $f = Join-Path $env:TEMP ("itn-web-body-" + [guid]::NewGuid().ToString("N") + ".json")
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
    Write-Output "== 抓中文大页面（> 8KB，验证 UTF-8 不被分片切断） =="
    $r = Post '/api/web/fetch' @{ url = "$web/big.html" }
    Check '抓取成功' ($r.code -eq 0) ("code=" + $r.code + " " + $r.message)
    $text = [string]$r.data.text
    Check '标题解析' ($r.data.title -eq '提示词工程讲义') ("title=" + $r.data.title)
    Check '进提示词的正文是完整的开头' ($text.Contains('中文开头哨兵')) ("正文 " + $text.Length + " 字")
    Check 'script 内容被剥掉' (-not $text.Contains('这段脚本不该进正文')) "ok"
    Check 'markdown 标题保留' ($text.Contains('# 提示词工程')) "ok"

    Write-Output "== 落本机 + 可审计 =="
    $cache = Post '/api/web/cache' @{}
    Check '缓存里有这一页' ($cache.data.pages.Count -ge 1) ("页数 " + $cache.data.pages.Count)
    $page = $cache.data.pages[0]
    # 注意：ConvertFrom-Json 会把 ISO 时间串转成 DateTime，比较前先转回字符串
    $pageUrl = [string]$page.url
    $pageAt = [string]$page.fetchedAt
    Check '列表里的 url / fetchedAt 可读' (($pageUrl -like '*big.html') -and ($pageAt.Length -gt 10)) ($pageUrl + " @ " + $pageAt)
    $f = Join-Path $dataDir 'webcache'
    $file = Join-Path $f $page.name
    Check '文件真的在磁盘上' (Test-Path $file) $page.name
    $full = Get-Content $file -Raw -Encoding UTF8
    Check '落盘的是全文（含结尾哨兵，> 8KB 的中文没被切断）' ($full.Contains('中文分片边界哨兵') -and $full.Length -gt 8000) ("文件 " + $full.Length + " 字")
    Check 'frontmatter 里有 url / fetchedAt' ($full.StartsWith('---') -and $full.Contains('fetchedAt:') -and $full.Contains('big.html')) "ok"

    Write-Output "== 跟 302 跳转 =="
    $r2 = Post '/api/web/fetch' @{ url = "$web/redirect" }
    Check '跳转后拿到的是目标页正文' ($r2.code -eq 0 -and ([string]$r2.data.title) -eq '提示词工程讲义') ("title=" + $r2.data.title)
    Check '出处记的是用户给的那个链接' (([string]$r2.data.url) -like '*/redirect') ([string]$r2.data.url)

    Write-Output "== 读不了就如实说 =="
    $r3 = Post '/api/web/fetch' @{ url = "$web/binary.bin" }
    Check '二进制被拒且说明原因' ($r3.code -ne 0 -and ([string]$r3.message).Contains('读不了')) ([string]$r3.message)
    $r4 = Post '/api/web/fetch' @{ url = "ftp://example.com/a" }
    Check '非 http/https 被拒' ($r4.code -ne 0) ([string]$r4.message)

    Write-Output "== 域名黑白名单：黑名单优先、允许名单留空=不限制 =="
    # 取域名（去掉 scheme、路径与端口：名单说的是域名）
    $allowHost = ([string]$r.data.url) -replace '^https?://', '' -replace '/.*$', '' -replace ':\d+$', ''
    # 默认（两张名单都空）能抓
    Check '默认不限制域名' ((Post '/api/web/fetch' @{ url = "$web/big.html" }).code -eq 0) 'ok'
    # 禁止名单里加上它 → 拒绝，且原因说人话
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'auto'; allowHosts = ''; blockHosts = $allowHost } | Out-Null
    $blocked = Post '/api/web/fetch' @{ url = "$web/big.html" }
    Check '禁止名单命中时拒绝' ($blocked.code -ne 0 -and ([string]$blocked.message).Contains('禁止名单')) ([string]$blocked.message)
    # 同时在允许名单里也照样拒绝：黑名单优先
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'auto'; allowHosts = $allowHost; blockHosts = $allowHost } | Out-Null
    $both = Post '/api/web/fetch' @{ url = "$web/big.html" }
    Check '两张名单都在时黑名单优先' ($both.code -ne 0 -and ([string]$both.message).Contains('禁止名单')) ([string]$both.message)
    # 只填允许名单、且不含它 → 拒绝
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'auto'; allowHosts = 'example.com'; blockHosts = '' } | Out-Null
    $notAllowed = Post '/api/web/fetch' @{ url = "$web/big.html" }
    Check '不在允许名单里时拒绝' ($notAllowed.code -ne 0 -and ([string]$notAllowed.message).Contains('允许名单')) ([string]$notAllowed.message)
    # 允许名单里有通配 → 放行
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'auto'; allowHosts = '*.test, ' + $allowHost; blockHosts = '' } | Out-Null
    Check '允许名单命中时可以抓' ((Post '/api/web/fetch' @{ url = "$web/big.html" }).code -eq 0) 'ok'
    # 清空，别影响后面的用例
    Post '/api/websearch/save' @{ apiKey = ''; enabled = '0'; mode = 'auto'; allowHosts = ''; blockHosts = '' } | Out-Null

    Write-Output "== 缓存可删 =="
    $d = Post '/api/web/cache/delete' @{ name = $page.name }
    Check '删除成功' ($d.code -eq 0) ("code=" + $d.code)
    Check '文件真的没了' (-not (Test-Path (Join-Path $f $page.name))) $page.name
    $d2 = Post '/api/web/cache/delete' @{ name = "../../itn.db" }
    Check '路径穿越被拒' ($d2.code -ne 0) ([string]$d2.message)
}
finally {
    Stop-Quiet $core
    Stop-Quiet $mock
}

Write-Output ""
if ($failed -gt 0) { Write-Output ("结果：" + $failed + " 项失败"); exit 1 } else { Write-Output "结果：全部通过" }
