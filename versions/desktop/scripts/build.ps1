# 构建仓颉内核
. "$PSScriptRoot\env.ps1"
Push-Location "$PSScriptRoot\..\core"
try {
    cjpm build
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
