# 干净环境自检：把 lumin 打成绿色包，然后**在没有任何仓颉/OpenSSL 环境变量的 PATH 里**跑一遍离线演示。
# 目的：证明"目标机器不装仓颉也能跑"这句话是真的，而不是靠本机 SDK 的 PATH 蒙混过关。
# 通过时最后一行打印 CLEAN-ENV-OK。
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\env.ps1"

$proj = Resolve-Path "$PSScriptRoot\.."
$dist = Join-Path $proj 'dist\lumin-demo'
$exe  = Join-Path $dist 'lumin-demo.exe'

# 这个文件被占用 = 还有一份 lumin 在跑（打不了包，覆盖不了 exe）
function Test-Locked([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    try { $s = [IO.File]::Open($path, 'Open', 'ReadWrite', 'None'); $s.Close(); return $false }
    catch { return $true }
}

# 1) 刷新绿色包（package-demo 自己会校验"产物比源码新"和拷贝后哈希一致）
if (Test-Locked $exe) {
    Write-Output '[注意] 绿色包正被别的 lumin 进程占用，跳过重新打包，直接对现有产物做干净环境自检。'
} else {
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'package-demo.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'package-demo.ps1 失败' }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 $exe（先跑 scripts\package-demo.ps1）" }

# 2) 把 PATH 收窄到"系统 + 绿色包目录"，再跑 demo —— 此时 SDK 的 bin 已经不在 PATH 上了，
#    能不能起来全靠 exe 旁边那几个 DLL。
$log = Join-Path $proj 'target\verify-clean.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
$cleanPath = "$env:SystemRoot\System32;$env:SystemRoot;$dist"
$savedPath = $env:PATH
$code = 1
try {
    $env:PATH = $cleanPath
    & $exe demo *> $log
    $code = $LASTEXITCODE
} finally {
    $env:PATH = $savedPath
}

if ($code -ne 0) { throw "干净环境里 demo 退出码 $code，日志：$log" }
$text = Get-Content -LiteralPath $log -Raw -Encoding UTF8
if ($text -notmatch '走路演示') { throw "干净环境里的输出不像 demo，日志：$log" }
if ($text -match 'error while loading shared libraries|找不到指定的模块|不是有效的 Win32') { throw "干净环境里报 DLL/加载错误，日志：$log" }

Write-Output ("绿色包目录：" + $dist)
Write-Output ("干净环境日志：" + $log)
Write-Output 'CLEAN-ENV-OK'
