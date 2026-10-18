# lumin 自己的环境加载（独立仓库版，不依赖任何父项目）
# 用法： . .\scripts\env.ps1
#
# 需要：仓颉 SDK 1.2.0（含 stdx）与 OpenSSL 3（TLS 用）。
# SDK 位置按这个顺序找： $env:CANGJIE_SDK_ROOT → $env:SDK_ROOT → D:\cangjie-sdk\1.2.0

if (-not $SdkRoot) {
    $SdkRoot = $env:CANGJIE_SDK_ROOT
}
if (-not $SdkRoot) {
    $SdkRoot = $env:SDK_ROOT
}
if (-not $SdkRoot) {
    $SdkRoot = 'D:\cangjie-sdk\1.2.0'
}

if (-not (Test-Path -LiteralPath "$SdkRoot\cangjie\envsetup.ps1")) {
    throw "找不到仓颉 SDK：$SdkRoot（可以设 CANGJIE_SDK_ROOT 或 SDK_ROOT 指到 SDK 根目录，例如 D:\cangjie-sdk\1.2.0）"
}

. "$SdkRoot\cangjie\envsetup.ps1"

# stdx 静态库（cjpm.toml 的 bin-dependencies 用）
$env:CANGJIE_STDX_PATH = "$SdkRoot\stdx\windows_x86_64_cjnative\static\stdx"

# OpenSSL 3：链接期 LIBRARY_PATH、运行期 PATH
if (Test-Path -LiteralPath "$SdkRoot\openssl\mingw64\bin") {
    $env:LIBRARY_PATH = "$SdkRoot\openssl\mingw64\lib"
    $env:PATH = "$SdkRoot\openssl\mingw64\bin;$env:PATH"
}

# 仓颉运行时默认堆上限 256MB，长期会话容易顶穿；放宽到 2GB（上限而非预分配）
$env:cjHeapSize = '2GB'
