# 打包并验证绿色压缩包里的应用能真正启动
$ErrorActionPreference = 'Continue'
$result = Join-Path $env:TEMP "itn-desktop-smoke-result.txt"
$before = if (Test-Path $result) { (Get-Item $result).LastWriteTime } else { $null }

& "$PSScriptRoot\..\scripts\package-app.ps1" | Select-Object -Last 3

$exe = Resolve-Path "$PSScriptRoot\..\dist\ITN-Desktop\ITN-Desktop.exe"
Write-Output "启动 $exe"
$p = Start-Process -FilePath $exe -ArgumentList "--smoke" -PassThru
Start-Sleep -Seconds 15

if (Test-Path $result) {
    $after = (Get-Item $result).LastWriteTime
    $fresh = ($before -eq $null) -or ($after -ne $before)
    Write-Output ("结果文件已刷新: {0} ({1})" -f $fresh, $after)
    Get-Content $result
} else {
    Write-Output "未生成结果文件"
}
if (-not $p.HasExited) { $p.Kill() }
