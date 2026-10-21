$ErrorActionPreference = 'Stop'
$zhixunRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')
$env:ZHIXUN_PROJECT_ROOT = $zhixunRoot

$zhixunEnv = Join-Path $zhixunRoot '.env.local'
if (-not (Test-Path -LiteralPath $zhixunEnv)) {
    throw "Missing $zhixunEnv. Create it from the documented development configuration first."
}
Get-Content -LiteralPath $zhixunEnv | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
    }
}

$zhixunService = Join-Path $zhixunRoot 'services/learning'
Push-Location $zhixunService
try {
    & cjpm build -i -j1
    if ($LASTEXITCODE -ne 0) { throw 'Cangjie backend build failed' }
} finally {
    Pop-Location
}

# Runtime data and PPT artifacts are rooted at the project directory.
Push-Location $zhixunRoot
try {
    & (Join-Path $zhixunService 'target/release/bin/main.exe')
} finally {
    Pop-Location
}
