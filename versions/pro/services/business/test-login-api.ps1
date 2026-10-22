$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-db-env.ps1')
$apiSdkFolder = [string][char]0x4ed3 + [string][char]0x9889
$apiSdkSetup = 'F:\' + $apiSdkFolder + '\Cangjie\envsetup.ps1'
if (-not (Test-Path -LiteralPath $apiSdkSetup)) { throw ('SDK setup not found: ' + $apiSdkSetup) }
. $apiSdkSetup
$env:CANGJIE_STDX_PATH = 'F:\cangjie-stdx\windows_x86_64_cjnative\dynamic\stdx'
$env:Path = $env:CANGJIE_STDX_PATH + ';F:\OpenSSL-Win64\bin;C:\Program Files\MySQL\MySQL Server 8.4\lib;C:\Program Files\MySQL\MySQL Server 8.4\bin;' + $env:Path
$apiProgram = Join-Path $PSScriptRoot 'target\release\bin\main.exe'
if (-not (Test-Path -LiteralPath $apiProgram)) { throw 'Run cjpm build first.' }
$apiEmail = Read-Host 'Website account email'
$apiPassword = Read-Host 'Website account password (not MySQL password)' -AsSecureString
$apiBstr = [IntPtr]::Zero
try {
    $apiBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($apiPassword)
    $apiPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiBstr)
    $apiJson = @{ email = $apiEmail; password = $apiPlain } | ConvertTo-Json -Compress
    try {
        $apiResult = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/api/v1/auth/login' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($apiJson)) -TimeoutSec 30
    } catch {
        if ($_.ErrorDetails.Message) { Write-Output $_.ErrorDetails.Message }
        throw 'Login request failed. Keep the cjpm run server window open and check the account/password.'
    }
    if ($apiResult.code -ne 0 -or [string]::IsNullOrEmpty($apiResult.data.accessToken)) {
        throw 'The server did not return a successful login token.'
    }
    Write-Output 'Password login API: passed'
    Write-Output ('User: ' + $apiResult.data.user.email)
    Write-Output ('Token type: ' + $apiResult.data.tokenType)
    Write-Output ('Expires in seconds: ' + $apiResult.data.expiresInSeconds)
    $apiSha = [Security.Cryptography.SHA256]::Create()
    try {
        $apiHash = [BitConverter]::ToString($apiSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($apiResult.data.accessToken))).Replace('-', '').ToLowerInvariant()
    } finally { $apiSha.Dispose() }
    & $apiProgram ('--check-login-session=' + $apiHash)
    if ($LASTEXITCODE -ne 0) { throw ('Session verification failed. Exit code: ' + $LASTEXITCODE) }
} finally {
    if ($apiBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiBstr) }
    $apiPlain = $null
    $apiJson = $null
    $apiResult = $null
    $apiPassword.Dispose()
}
