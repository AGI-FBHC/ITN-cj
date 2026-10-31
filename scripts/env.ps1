# 载入仓颉工具链与依赖环境（只作用于当前 PowerShell 会话）
# 用法： . .\scripts\env.ps1

if (-not $SdkRoot) {
    if ($env:CANGJIE_SDK_ROOT -and (Test-Path -LiteralPath $env:CANGJIE_SDK_ROOT)) {
        $SdkRoot = $env:CANGJIE_SDK_ROOT
    } else {
        $SdkRoot = 'D:\cangjie-sdk\1.2.0'
    }
}

if (-not (Test-Path -LiteralPath "$SdkRoot\cangjie\envsetup.ps1")) {
    throw "找不到仓颉 SDK：$SdkRoot（需要包含 cangjie\envsetup.ps1）"
}
$env:CANGJIE_SDK_ROOT = $SdkRoot

. "$SdkRoot\cangjie\envsetup.ps1"

# stdx 静态库路径，供 core/cjpm.toml 的 bin-dependencies 使用
$env:CANGJIE_STDX_PATH = "$SdkRoot\stdx\windows_x86_64_cjnative\static\stdx"

# OpenSSL 3：链接期用 LIBRARY_PATH，运行期用 PATH
$env:LIBRARY_PATH = "$SdkRoot\openssl\mingw64\lib"
$env:PATH = "$SdkRoot\openssl\mingw64\bin;$env:PATH"

# 仓颉运行时默认堆上限只有 256MB，向量索引在真实规模下会顶穿。
# 这里放宽到 2GB；这是上限而非预分配，按需增长。
$env:cjHeapSize = '2GB'
