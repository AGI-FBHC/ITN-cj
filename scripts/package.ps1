# 产出可独立分发的内核目录（目标机器无需安装仓颉）
. "$PSScriptRoot\env.ps1"

$repo = Resolve-Path "$PSScriptRoot\.."
$dist = Join-Path $repo "dist\core"
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
    Copy-Item -LiteralPath $a.from -Destination (Join-Path $dist $a.to) -Force
}

Write-Output "packaged to $dist"
Get-ChildItem $dist -File | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
