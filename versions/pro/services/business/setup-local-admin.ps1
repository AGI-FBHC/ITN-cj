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
$env:Path = $env:CANGJIE_STDX_PATH + ';F:\OpenSSL-Win64\bin;C:\Program Files\MySQL\MySQL Server 8.4\lib;C:\Program Files\MySQL\MySQL Server 8.4\bin;' + $env:Path
$loginCheckSecret = Read-Host 'Set local admin password: 8-64 ASCII characters, letters and digits' -AsSecureString
$loginCheckBstr = [IntPtr]::Zero
$loginCheckOriginalEncoding = $OutputEncoding
$loginCheckOriginalConsoleInputEncoding = [Console]::InputEncoding
$loginCheckOriginalConsoleOutputEncoding = [Console]::OutputEncoding
$loginCheckProcess = $null
try {
    $loginCheckBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loginCheckSecret)
    $loginCheckPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($loginCheckBstr)
    if ($loginCheckPlain -notmatch '^(?=.*[A-Za-z])(?=.*[0-9])[!-~]{8,64}$') {
        throw 'Use 8-64 ASCII characters containing letters and digits.'
    }
    $loginCheckEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = $loginCheckEncoding
    [Console]::OutputEncoding = $loginCheckEncoding
    $OutputEncoding = $loginCheckEncoding
    $loginCheckStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $loginCheckStartInfo.FileName = $loginCheckProgram
    $loginCheckStartInfo.Arguments = '--prepare-local-admin'
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
    $loginCheckProcess.StandardInput.WriteLine($loginCheckPlain)
    $loginCheckProcess.StandardInput.Close()
    $loginCheckProcess.WaitForExit()
    $loginCheckResult = $loginCheckStdout.Result
    $loginCheckError = $loginCheckStderr.Result
    if (-not [string]::IsNullOrWhiteSpace($loginCheckResult)) { Write-Output $loginCheckResult.TrimEnd() }
    if (-not [string]::IsNullOrWhiteSpace($loginCheckError)) { Write-Output $loginCheckError.TrimEnd() }
    if ($loginCheckProcess.ExitCode -ne 0) {
        throw ('Local administrator setup failed. Exit code: ' + $loginCheckProcess.ExitCode)
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
