$ErrorActionPreference = 'Stop'
$ZhixunSdkRoot = if ($env:ZHIXUN_SDK_ROOT) { $env:ZHIXUN_SDK_ROOT } else { 'D:\cangjie-sdk\1.2.0' }
. (Join-Path $ZhixunSdkRoot 'cangjie/envsetup.ps1')
$env:CANGJIE_STDX_PATH = Join-Path $ZhixunSdkRoot 'stdx/windows_x86_64_cjnative/static/stdx'
$env:LIBRARY_PATH = (Join-Path $ZhixunSdkRoot 'openssl/mingw64/lib')
$env:PATH = (Join-Path $ZhixunSdkRoot 'openssl/mingw64/bin') + ';' + $env:PATH
