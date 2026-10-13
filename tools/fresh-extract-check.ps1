# 验收视角：把绿色压缩包解压到干净目录后直接运行，验证「解压即用」
$ErrorActionPreference = 'Continue'

$zip = Resolve-Path "$PSScriptRoot\..\dist\ITN-Desktop-win-x64.zip"
$dest = Join-Path $env:TEMP ("itn-fresh-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Output "解压到 $dest …"
$sw = [Diagnostics.Stopwatch]::StartNew()
Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
$sw.Stop()
Write-Output ("解压耗时 {0} 秒" -f [math]::Round($sw.Elapsed.TotalSeconds, 1))

$exe = Join-Path $dest "ITN-Desktop.exe"
Write-Output ("入口存在: {0}" -f (Test-Path -LiteralPath $exe))
Get-ChildItem $dest | Where-Object { $_.Name -in @("ITN-Desktop.exe", "resources", "locales") } | Select-Object Name
Get-ChildItem (Join-Path $dest "resources\kernel") | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}

$resultFile = Join-Path $env:TEMP "itn-desktop-smoke-result.txt"
$before = if (Test-Path $resultFile) { (Get-Item $resultFile).LastWriteTime } else { $null }

Write-Output "启动应用…"
$proc = Start-Process -FilePath $exe -ArgumentList "--smoke" -PassThru
Start-Sleep -Seconds 18

if (Test-Path $resultFile) {
    $after = (Get-Item $resultFile).LastWriteTime
    $fresh = ($before -eq $null) -or ($after -ne $before)
    Write-Output ("结果已刷新: {0}" -f $fresh)
    Get-Content $resultFile
} else {
    Write-Output "未生成结果文件"
}
if (-not $proc.HasExited) { $proc.Kill() }
