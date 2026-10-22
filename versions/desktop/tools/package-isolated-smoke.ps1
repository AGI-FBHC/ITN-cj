# Green-package startup check using a new empty data directory, without copying credentials.
param([string]$Exe = "$PSScriptRoot\..\dist\ITN-Desktop\ITN-Desktop.exe")
$ErrorActionPreference = 'Stop'
$smokeRoot = Join-Path $env:TEMP ('itn-package-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$resultPath = Join-Path $smokeRoot 'lumin-smoke-result.txt'
$smokeProcess = $null
# 文档预览的样张：有 python-docx 就生成一份真文件，没有就跳过这一条（脚本本身不依赖它）
$docFixture = Join-Path $smokeRoot 'docx-fixture.docx'
$docMade = $false
try {
    $mkLines = @(
        'import sys',
        'from docx import Document',
        'd = Document()',
        'd.add_heading("自检文档", level=1)',
        'd.add_paragraph("第一段：自检用。")',
        'd.add_heading("第二节", level=2)',
        'd.add_paragraph("第二段：自检用。")',
        'd.save(sys.argv[1])'
    )
    $mkPath = Join-Path $smokeRoot 'mkdocx.py'
    Set-Content -LiteralPath $mkPath -Value $mkLines -Encoding UTF8
    & python $mkPath $docFixture 2>$null | Out-Null
    $docMade = Test-Path -LiteralPath $docFixture
} catch { $docMade = $false }
$envPairs = @{ LOCALAPPDATA = $smokeRoot; APPDATA = $smokeRoot; TEMP = $smokeRoot; TMP = $smokeRoot }
if ($docMade) { $envPairs['LUMIN_SMOKE_DOC'] = $docFixture }
try {
    $smokeProcess = Start-Process -FilePath (Resolve-Path -LiteralPath $Exe) -ArgumentList '--smoke' `
        -Environment $envPairs `
        -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (!(Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (!(Test-Path -LiteralPath $resultPath)) { throw 'Packaged app did not produce its startup result' }
    $result = Get-Content -LiteralPath $resultPath -Raw
    Write-Output $result
    Write-Output ('Isolated empty data directory: ' + $smokeRoot)
    if ($result -notmatch 'RESULT=OK') { throw 'Packaged startup check failed' }
} finally {
    if ($smokeProcess -and !$smokeProcess.HasExited) {
        $smokeProcess.WaitForExit(2000) | Out-Null
        if (!$smokeProcess.HasExited) { $smokeProcess.Kill() }
    }
}
