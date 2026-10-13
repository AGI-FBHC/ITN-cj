# 载入仓颉工具链与依赖环境（只作用于当前 PowerShell 会话）
# 用法： . .\scripts\env.ps1

if (-not $SdkRoot) {
    $SdkRoot = 'D:\cangjie-sdk\1.2.0'
}

. "$SdkRoot\cangjie\envsetup.ps1"

# stdx 静态库路径，供 core/cjpm.toml 的 bin-dependencies 使用
$env:CANGJIE_STDX_PATH = "$SdkRoot\stdx\windows_x86_64_cjnative\static\stdx"

# OpenSSL 3：链接期用 LIBRARY_PATH，运行期用 PATH
$env:LIBRARY_PATH = "$SdkRoot\openssl\mingw64\lib"
$env:PATH = "$SdkRoot\openssl\mingw64\bin;$env:PATH"
