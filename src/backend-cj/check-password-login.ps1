$ErrorActionPreference = 'Stop'

# Interactive local credential check. Neither input is placed in command history.
$loginCheckProgram = Join-Path $PSScriptRoot 'target\release\bin\main.exe'
if (-not (Test-Path -LiteralPath $loginCheckProgram)) {
    throw 'Build the project with cjpm build first.'
}
. (Join-Path $PSScriptRoot 'load-db-env.ps1')
$loginCheckSdkFolder = [string][char]0x4ed3 + [string][char]0x9889
$loginCheckSdkSetup = 'F:\' + $loginCheckSdkFolder + '\Cangjie\envsetup.ps1'
if (-not (Test-Path -LiteralPath $loginCheckSdkSetup)) {
    throw ('Cangjie SDK setup script not found: ' + $loginCheckSdkSetup)
}
. $loginCheckSdkSetup
$env:CANGJIE_STDX_PATH = 'F:\cangjie-stdx\windows_x86_64_cjnative\dynamic\stdx'
$env:Path = $env:CANGJIE_STDX_PATH + ';C:\Program Files\MySQL\MySQL Server 8.4\lib;C:\Program Files\MySQL\MySQL Server 8.4\bin;' + $env:Path
$loginCheckEmail = Read-Host 'Website account email'
$loginCheckSecret = Read-Host 'Website account password (not the MySQL password)' -AsSecureString
$loginCheckBstr = [IntPtr]::Zero
$loginCheckOriginalEncoding = $OutputEncoding
$loginCheckOriginalConsoleInputEncoding = [Console]::InputEncoding
$loginCheckOriginalConsoleOutputEncoding = [Console]::OutputEncoding
$loginCheckProcess = $null
try {
    $loginCheckBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loginCheckSecret)
    $loginCheckPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($loginCheckBstr)
    if ($loginCheckEmail.Contains("`n") -or $loginCheckEmail.Contains("`r") -or
        $loginCheckPlain.Contains("`n") -or $loginCheckPlain.Contains("`r")) {
        throw 'This console check accepts single-line email and password input.'
    }
    $loginCheckEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = $loginCheckEncoding
    [Console]::OutputEncoding = $loginCheckEncoding
    $OutputEncoding = $loginCheckEncoding
    $loginCheckStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $loginCheckStartInfo.FileName = $loginCheckProgram
    $loginCheckStartInfo.Arguments = '--check-password'
    $loginCheckStartInfo.WorkingDirectory = $PSScriptRoot
    $loginCheckStartInfo.UseShellExecute = $false
    $loginCheckStartInfo.CreateNoWindow = $true
    $loginCheckStartInfo.RedirectStandardInput = $true
    $loginCheckStartInfo.RedirectStandardOutput = $true
    $loginCheckStartInfo.RedirectStandardError = $true
    $loginCheckProcess = New-Object System.Diagnostics.Process
    $loginCheckProcess.StartInfo = $loginCheckStartInfo
    if (-not $loginCheckProcess.Start()) { throw 'Could not start the Cangjie password checker.' }
    $loginCheckStdout = $loginCheckProcess.StandardOutput.ReadToEndAsync()
    $loginCheckStderr = $loginCheckProcess.StandardError.ReadToEndAsync()
    $loginCheckProcess.StandardInput.WriteLine($loginCheckEmail)
    $loginCheckProcess.StandardInput.WriteLine($loginCheckPlain)
    $loginCheckProcess.StandardInput.Close()
    $loginCheckProcess.WaitForExit()
    $loginCheckResult = $loginCheckStdout.Result
    $loginCheckError = $loginCheckStderr.Result
    if (-not [string]::IsNullOrWhiteSpace($loginCheckResult)) { Write-Output $loginCheckResult.TrimEnd() }
    if (-not [string]::IsNullOrWhiteSpace($loginCheckError)) { Write-Output $loginCheckError.TrimEnd() }
    if ($loginCheckProcess.ExitCode -eq 0) {
        if ($loginCheckResult -notmatch 'Password authentication passed') {
            Write-Output 'Password check completed successfully.'
        }
    } elseif ($loginCheckProcess.ExitCode -eq 1) {
        if ($loginCheckResult -notmatch 'Password authentication rejected') {
            Write-Output 'Password authentication rejected.'
        }
    } else {
        throw ('Password check could not finish. Exit code: ' + $loginCheckProcess.ExitCode)
    }
} finally {
    $OutputEncoding = $loginCheckOriginalEncoding
    [Console]::InputEncoding = $loginCheckOriginalConsoleInputEncoding
    [Console]::OutputEncoding = $loginCheckOriginalConsoleOutputEncoding
    if ($loginCheckBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($loginCheckBstr)
    }
    $loginCheckPlain = $null
    if ($null -ne $loginCheckProcess) { $loginCheckProcess.Dispose() }
    $loginCheckSecret.Dispose()
}
