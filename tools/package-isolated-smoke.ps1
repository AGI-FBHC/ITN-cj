# Green-package startup check using a new empty data directory, without copying credentials.
param([string]$Exe = "$PSScriptRoot\..\dist\ITN-Desktop\ITN-Desktop.exe")
$ErrorActionPreference = 'Stop'
$smokeRoot = Join-Path $env:TEMP ('itn-package-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$resultPath = Join-Path $smokeRoot 'itn-desktop-smoke-result.txt'
$smokeProcess = $null
try {
    $smokeProcess = Start-Process -FilePath (Resolve-Path -LiteralPath $Exe) -ArgumentList '--smoke' `
        -Environment @{ LOCALAPPDATA = $smokeRoot; APPDATA = $smokeRoot; TEMP = $smokeRoot; TMP = $smokeRoot } `
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
