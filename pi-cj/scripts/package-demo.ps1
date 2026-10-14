# 把 pi-cj 的演示程序打成"双击就能跑"的绿色目录（目标机器无需装仓颉）。
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\..\scripts\env.ps1"

$proj = Resolve-Path "$PSScriptRoot\.."
$dist = Join-Path $proj "dist\pi-cj-demo"

$built = Join-Path $proj "target\release\bin\main.exe"
if (-not (Test-Path -LiteralPath $built)) {
    throw "找不到构建产物 $built，请先运行 scripts/demo.ps1 或 cjpm build"
}
# 打包前确认产物比源码新，否则会把"上一次的二进制"当成这次的结果发出去
$builtTime = (Get-Item -LiteralPath $built).LastWriteTimeUtc
$newest = Get-ChildItem -Path (Join-Path $proj "src") -Recurse -File -Include *.cj |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($newest -and $newest.LastWriteTimeUtc -gt $builtTime) {
    throw "构建产物比源码旧（$($newest.FullName)），请先 cjpm build"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null

$runtimeLib = "$SdkRoot\cangjie\runtime\lib\windows_x86_64_cjnative"
$artifacts = @(
    @{ from = $built; to = "pi-cj-demo.exe" },
    @{ from = "$runtimeLib\libcangjie-runtime.dll"; to = "libcangjie-runtime.dll" },
    @{ from = "$runtimeLib\libboundscheck.dll"; to = "libboundscheck.dll" }
)

foreach ($a in $artifacts) {
    if (-not (Test-Path -LiteralPath $a.from)) { throw "missing artifact: $($a.from)" }
    $dest = Join-Path $dist $a.to
    Copy-Item -LiteralPath $a.from -Destination $dest -Force
    $srcHash = (Get-FileHash -LiteralPath $a.from -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw "拷贝后哈希不一致：$dest" }
}

# 演示输出很长，双击 exe 后窗口会立刻关掉 —— 附一个"双击就能看清"的启动器
$launcher = @'
@echo off
chcp 65001 > nul
cd /d "%~dp0"
pi-cj-demo.exe
echo.
echo （按任意键关闭）
pause > nul
'@
Set-Content -LiteralPath (Join-Path $dist "运行演示.cmd") -Value $launcher -Encoding OEM

$readme = @'
pi-cj 演示（Pi-Agent 风格的仓颉 Agent 运行时）

双击「运行演示.cmd」即可看到四段输出：
  1. 流式解析：工具参数边到边解析（半截 JSON 也能实时读出工具名和已到齐的参数）
  2. 标准模式跑一轮：turn/step 事件流、工具执行、结果回灌、最终回答
  3. 研究模式：联网工具出现，回答里的 [W9] 会被引用自检抓出来
  4. 护栏：模式白名单、最大模型轮数、可中止

这里跑的是假模型（脚本播放器）与假工具，不联网、不读写任何文件，纯离线演示运行时行为。
源码与单元测试在 ..\..\（cjpm test，56 个用例）。
'@
Set-Content -LiteralPath (Join-Path $dist "说明.txt") -Value $readme -Encoding UTF8

Write-Output "packaged to $dist"
Get-ChildItem $dist -File | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}
