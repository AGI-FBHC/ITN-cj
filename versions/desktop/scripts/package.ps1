# 产出可独立分发的内核目录（目标机器无需安装仓颉）
# 注意：目标文件被占用时 Copy-Item 会失败。这里强制出错即停，
# 并在拷贝后校验哈希，避免出现「打包成功但其实是旧产物」的静默失败。
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\env.ps1"

$repo = Resolve-Path "$PSScriptRoot\.."
$dist = Join-Path $repo "dist\core"

# 先确认要打包的内核确实是当前源码编出来的：
# 构建失败（或忘了 build）时 dist 里会留着上一次的产物，静默打进去就是"验证跑的是旧二进制"。
$built = Join-Path $repo "core\target\release\bin\main.exe"
if (-not (Test-Path -LiteralPath $built)) {
    throw "找不到构建产物 $built，请先运行 scripts/build.ps1"
}
$builtTime = (Get-Item -LiteralPath $built).LastWriteTimeUtc
$newest = Get-ChildItem -Path (Join-Path $repo "core\src"), (Join-Path $repo "third_party") -Recurse -File -Include *.cj,*.toml -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($newest -and $newest.LastWriteTimeUtc -gt $builtTime) {
    throw "构建产物比源码旧（最新源码：$($newest.FullName) @ $($newest.LastWriteTimeUtc)），请先运行 scripts/build.ps1 再打包"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null

$runtimeLib = "$SdkRoot\cangjie\runtime\lib\windows_x86_64_cjnative"
$opensslBin = "$SdkRoot\openssl\mingw64\bin"

$artifacts = @(
    @{ from = "$repo\core\target\release\bin\main.exe"; to = "itn-desktop-core.exe" },
    @{ from = "$runtimeLib\libcangjie-runtime.dll"; to = "libcangjie-runtime.dll" },
    @{ from = "$runtimeLib\libboundscheck.dll"; to = "libboundscheck.dll" },
    @{ from = "$opensslBin\libssl-3-x64.dll"; to = "libssl-3-x64.dll" },
    @{ from = "$opensslBin\libcrypto-3-x64.dll"; to = "libcrypto-3-x64.dll" }
)

foreach ($a in $artifacts) {
    if (-not (Test-Path -LiteralPath $a.from)) { throw "missing artifact: $($a.from)" }
    $dest = Join-Path $dist $a.to
    try {
        Copy-Item -LiteralPath $a.from -Destination $dest -Force
    } catch {
        throw "无法写入 $dest —— 目标文件可能被正在运行的内核或桌面应用占用，请先关闭它们。原始错误：$($_.Exception.Message)"
    }
    $srcHash = (Get-FileHash -LiteralPath $a.from -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw "拷贝后哈希不一致：$dest" }
}

# Cangjie's Windows CRT argv uses the process ANSI code page. Make it UTF-8 so
# Chinese user/install/data paths reach main() intact, without changing OS settings.
$manifest=Join-Path $repo 'core/windows-runtime.manifest'
$mt=Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\mt.exe' -File | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if(!$mt){throw 'Windows SDK Manifest Tool (mt.exe) is required to package the UTF-8 kernel'}
$kernelExe=Join-Path $dist 'itn-desktop-core.exe'
& $mt -nologo -manifest $manifest ('-outputresource:'+$kernelExe+';#1')
if($LASTEXITCODE -ne 0){throw 'Failed to embed the UTF-8 application manifest'}
$verification=Join-Path $dist 'kernel-manifest.xml'
& $mt -nologo ('-inputresource:'+$kernelExe+';#1') ('-out:'+$verification)
if($LASTEXITCODE -ne 0 -or (Get-Content -LiteralPath $verification -Raw) -notmatch 'activeCodePage[^>]*>UTF-8'){throw 'Packaged kernel UTF-8 manifest validation failed'}

Write-Output "packaged to $dist"
Get-ChildItem $dist -File | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
