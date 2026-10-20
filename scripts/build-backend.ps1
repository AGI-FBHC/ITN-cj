# Builds the native Cangjie learning service with the local SDK.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')
Push-Location (Join-Path $root 'services/learning')
try {
    & cjpm build -i -j1
    if ($LASTEXITCODE -ne 0) { throw 'Cangjie backend build failed' }
    Write-Output '后端构建完成'
} finally {
    Pop-Location
}
