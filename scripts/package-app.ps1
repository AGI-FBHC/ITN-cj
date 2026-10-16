# 组装可独立分发的桌面应用（绿色压缩包，目标机器无需安装仓颉或 Node）
param(
    [string]$OutDir = "$PSScriptRoot\..\dist\Lumin",
    [string]$ZipPath = "$PSScriptRoot\..\dist\Lumin-win-x64.zip",
    # 包内 release.json 的构建标识（版本号取 shell/package.json）
    [string]$Build = 'lumin-rebrand-20261015'
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path "$PSScriptRoot\.."

# 1) 先确保内核产物是最新的
& "$PSScriptRoot\package.ps1" | Out-Host

$electronDist = Join-Path $repo "shell\node_modules\electron\dist"
if (-not (Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
    throw "找不到 Electron 运行时，请先在 shell 目录执行 npm install"
}

# 2) 复制 Electron 运行时
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Path (Join-Path $electronDist "*") -Destination $OutDir -Recurse -Force

# 3) 应用代码放进 resources/app，内核放进 resources/kernel
$appDir = Join-Path $OutDir "resources\app"
$kernelDir = Join-Path $OutDir "resources\kernel"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path $kernelDir | Out-Null

Copy-Item -LiteralPath (Join-Path $repo "shell\main.js") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $repo "shell\preload.js") -Destination $appDir -Force
# pptx / docx 文字预览、以及 Markdown → Office 导出，都是同目录里 require 进来的模块，
# 必须一起进包（漏了包里的 main.js 会 require 失败）
Copy-Item -LiteralPath (Join-Path $repo "shell\pptx.js") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $repo "shell\deck-export.js") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $repo "shell\presentation-builder.js") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $repo "shell\desktop-bridge.js") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $repo "shell\resource-reader.js") -Destination $appDir -Force
# npm resolves the complete production dependency graph, including platform PDF bindings.
$productionModules = & npm --prefix (Join-Path $repo 'shell') ls --omit=dev --all --parseable
if ($LASTEXITCODE -ne 0) { throw "生产依赖不完整，请先在shell中npm install" }
$modulesRoot = [IO.Path]::GetFullPath((Join-Path $repo 'shell/node_modules')) + [IO.Path]::DirectorySeparatorChar
foreach ($modulePath in $productionModules) {
    $absoluteModule = [IO.Path]::GetFullPath($modulePath)
    if (-not $absoluteModule.StartsWith($modulesRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $relativeModule = $absoluteModule.Substring($modulesRoot.Length)
    $destinationModule = Join-Path (Join-Path $appDir 'node_modules') $relativeModule
    New-Item -ItemType Directory -Force -Path (Split-Path $destinationModule) | Out-Null
    Copy-Item -LiteralPath $absoluteModule -Destination $destinationModule -Recurse -Force
}
Copy-Item -Path (Join-Path $repo "shell\renderer") -Destination $appDir -Recurse -Force
Copy-Item -Path (Join-Path $repo "shell\assets") -Destination $appDir -Recurse -Force
# 随包内置的技能（只读，用户改不了）：外壳用 --skills-dir 指给内核
if (Test-Path -LiteralPath (Join-Path $repo "shell\skills")) {
    Copy-Item -Path (Join-Path $repo "shell\skills") -Destination $appDir -Recurse -Force
}

$sourcePackage = Get-Content -LiteralPath (Join-Path $repo 'shell/package.json') -Raw | ConvertFrom-Json
$pkgJson = @{ name = 'lumin'; version = $sourcePackage.version; private = $true; main = 'main.js' } | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $appDir "package.json") -Value $pkgJson -Encoding utf8

Copy-Item -Path (Join-Path $repo "dist\core\*") -Destination $kernelDir -Recurse -Force
# 内核副本改叫 lumin-core（任务管理器里看到的是产品名）；main.js 优先找新名字，找不到退回老名字
$legacyKernel = Join-Path $kernelDir "itn-desktop-core.exe"
if (Test-Path -LiteralPath $legacyKernel) {
    Move-Item -LiteralPath $legacyKernel -Destination (Join-Path $kernelDir "lumin-core.exe") -Force
}

# 4) 用应用名替换默认启动文件名
$srcExe = Join-Path $OutDir "electron.exe"
if (Test-Path -LiteralPath $srcExe) {
    Move-Item -LiteralPath $srcExe -Destination (Join-Path $OutDir "Lumin.exe") -Force
}

# 4.5) 随包附带说明书，让解压的人不必翻仓库
Copy-Item -LiteralPath (Join-Path $repo "docs\07-使用说明.md") -Destination (Join-Path $OutDir "Lumin-使用说明.md") -Force
Copy-Item -LiteralPath (Join-Path $repo "docs\05-仓颉杯提交说明.md") -Destination (Join-Path $OutDir "Lumin-系统说明.md") -Force
Copy-Item -LiteralPath (Join-Path $repo "third_party\pi-studio-LICENSE.txt") -Destination (Join-Path $OutDir "pi-studio-LICENSE.txt") -Force

# 5) 压缩
$sourceCommit = (git -C $repo rev-parse HEAD).Trim()
$assetHashes = [ordered]@{}
$assetFiles = @(
    'resources/app/main.js', 'resources/app/preload.js', 'resources/app/pptx.js',
    'resources/app/renderer/index.html', 'resources/app/renderer/app.js',
    'resources/app/renderer/style.css', 'resources/app/renderer/workbench.js',
    'resources/app/renderer/workbench.css', 'resources/kernel/lumin-core.exe',
    'resources/app/renderer/coursemap.js', 'resources/app/renderer/coursemap.css',
    'resources/app/renderer/studyplayer.js', 'resources/app/renderer/studyplayer.css'
)
foreach ($relative in $assetFiles) {
    $assetHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $OutDir $relative) -Algorithm SHA256).Hash
}
$manifest = [ordered]@{
    version = $sourcePackage.version; build = $Build
    sourceCommit = $sourceCommit; builtAt = [DateTime]::UtcNow.ToString('o'); assets = $assetHashes
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $appDir 'renderer/release.json'), $manifest, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $OutDir 'release.json'), $manifest, [Text.UTF8Encoding]::new($false))
Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal -Force

$size = [math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1MB, 1)
Write-Output "app dir : $OutDir"
Write-Output "zip     : $ZipPath ($size MB)"
Get-ChildItem -LiteralPath $kernelDir | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
