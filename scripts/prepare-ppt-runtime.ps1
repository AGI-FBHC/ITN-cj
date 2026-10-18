# 准备 Lumin 的 PPT 渲染运行时。
#
# 目标机器不要求预装 Python；这里把一个官方 embeddable Python 以及
# python-pptx/Pillow/lxml 的 wheel 内容放进 shell/renderer/ppt-renderer/python。
# 生成目录不入 Git，package-app.ps1 会把它一起打进 Electron 资源。
param(
    [string]$Version = '3.13.5',
    [string]$Target = "$PSScriptRoot\..\shell\renderer\ppt-renderer\python",
    [string]$CacheDir = "$PSScriptRoot\..\tmp\ppt-runtime-cache",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path "$PSScriptRoot\.."
$targetPath = [IO.Path]::GetFullPath($Target)
$repoPath = [IO.Path]::GetFullPath("$PSScriptRoot\..")
if (-not $targetPath.StartsWith($repoPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝把 PPT runtime 写到仓库目录之外：$targetPath"
}
$cachePath = [IO.Path]::GetFullPath($CacheDir)
$zipName = "python-$Version-embed-amd64.zip"
$zipPath = Join-Path $cachePath $zipName
$url = "https://www.python.org/ftp/python/$Version/$zipName"

if ($Force -and (Test-Path -LiteralPath $targetPath)) {
    Remove-Item -LiteralPath $targetPath -Recurse -Force
}
if (Test-Path -LiteralPath (Join-Path $targetPath 'python.exe')) {
    Write-Output "PPT runtime already exists: $targetPath"
    exit 0
}

New-Item -ItemType Directory -Force -Path $cachePath, $targetPath | Out-Null
if (-not (Test-Path -LiteralPath $zipPath)) {
    Write-Output "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
}
Expand-Archive -LiteralPath $zipPath -DestinationPath $targetPath -Force

# embeddable Python 默认不加载 Lib\site-packages；补上并启用 site。
$pth = Get-ChildItem -LiteralPath $targetPath -Filter 'python*._pth' | Select-Object -First 1
if (-not $pth) { throw '找不到 embeddable Python 的 ._pth 文件' }
$zipLib = (Get-ChildItem -LiteralPath $targetPath -Filter 'python*.zip' | Select-Object -First 1).Name
$lines = @($zipLib, '.', 'Lib\site-packages', 'import site')
[IO.File]::WriteAllLines($pth.FullName, $lines, [Text.UTF8Encoding]::new($false))

$site = Join-Path $targetPath 'Lib\site-packages'
New-Item -ItemType Directory -Force -Path $site | Out-Null
$python = Join-Path $targetPath 'python.exe'
$pipBootstrap = Join-Path $cachePath 'get-pip.py'
if (-not (Test-Path -LiteralPath $pipBootstrap)) {
    Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $pipBootstrap -UseBasicParsing
}
if (-not (Test-Path -LiteralPath (Join-Path $targetPath 'Scripts\pip.exe'))) {
    & $python -X utf8 $pipBootstrap --no-warn-script-location | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'embeddable Python 安装 pip 失败' }
}
& $python -X utf8 -m pip install --disable-pip-version-check --no-compile --target $site `
    'python-pptx==1.0.2' 'Pillow==11.1.0' 'lxml==5.3.0' | Out-Host
if ($LASTEXITCODE -ne 0) { throw '安装 PPT runtime 依赖失败' }

& $python -X utf8 -c "import pptx, PIL, lxml; print('PPT runtime OK', pptx.__version__, PIL.__version__, lxml.__version__)" | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'PPT runtime 自检失败' }
Write-Output "PPT runtime ready: $targetPath"