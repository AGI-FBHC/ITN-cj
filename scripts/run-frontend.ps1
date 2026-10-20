$ErrorActionPreference = 'Stop'
$zhixunRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $zhixunRoot 'apps/web')
try {
    & npm.cmd run dev
} finally {
    Pop-Location
}
