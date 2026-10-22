$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-db-env.ps1')
$accountSdkName = [string][char]0x4ed3 + [string][char]0x9889
. ('F:\' + $accountSdkName + '\Cangjie\envsetup.ps1')
$env:CANGJIE_STDX_PATH = 'F:\cangjie-stdx\windows_x86_64_cjnative\dynamic\stdx'
$env:Path = $env:CANGJIE_STDX_PATH + ';F:\OpenSSL-Win64\bin;C:\Program Files\MySQL\MySQL Server 8.4\lib;C:\Program Files\MySQL\MySQL Server 8.4\bin;' + $env:Path
$accountProgram = Join-Path $PSScriptRoot 'target\release\bin\main.exe'

function Invoke-AccountApi([string] $path, [hashtable] $payload) {
    $requestJson = $payload | ConvertTo-Json -Compress
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:5000/api/v1/auth/' + $path) -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($requestJson)) -TimeoutSec 90
        return @{ Status = [int]$response.StatusCode; Body = ($response.Content | ConvertFrom-Json) }
    } catch {
        if ($null -eq $_.Exception.Response) { throw 'API server is unreachable. Keep cjpm run open in the first window.' }
        $failureResponse = $_.Exception.Response
        $failureBody = $_.ErrorDetails.Message
        if ([string]::IsNullOrWhiteSpace($failureBody)) {
            if ($null -ne $failureResponse.PSObject.Methods['GetResponseStream']) {
                $reader = New-Object IO.StreamReader($failureResponse.GetResponseStream())
                try { $failureBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
            } else { $failureBody = $failureResponse.Content.ReadAsStringAsync().Result }
        }
        return @{ Status = [int]$failureResponse.StatusCode; Body = ($failureBody | ConvertFrom-Json) }
    } finally { $requestJson = $null }
}
function Assert-Api([hashtable] $result, [int] $status, [int] $code, [string] $label) {
    if ($result.Status -ne $status -or $result.Body.code -ne $code) {
        Write-Output ('HTTP ' + $result.Status + '; code ' + $result.Body.code + '; ' + $result.Body.message)
        throw ($label + ' failed.')
    }
    Write-Output ($label + ': passed')
}
function Assert-Session($result) {
    if ([string]::IsNullOrEmpty($result.data.accessToken)) { throw 'Login returned no JWT.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($result.data.accessToken))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    & $accountProgram ('--check-login-session=' + $hash)
    if ($LASTEXITCODE -ne 0) { throw 'Login session verification failed.' }
}

Write-Output 'Mode 1: test email-code login with an existing account.'
Write-Output 'Mode 2: register a NEW email account, then test password and email-code login.'
$accountMode = Read-Host 'Choose 1 or 2 (2 tests the full batch)'
if ($accountMode -ne '1' -and $accountMode -ne '2') { throw 'Choose 1 or 2.' }
$accountEmail = Read-Host 'Email address you can receive verification mail at'
$accountPlain = $null
$accountSecret = $null
$accountBstr = [IntPtr]::Zero
try {
    if ($accountMode -eq '2') {
        $accountSecret = Read-Host 'NEW website password: 8-64 characters, with letters and digits' -AsSecureString
        $accountBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($accountSecret)
        $accountPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($accountBstr)
        if ($accountPlain.Length -lt 8 -or $accountPlain.Length -gt 64 -or $accountPlain -notmatch '[A-Za-z]' -or $accountPlain -notmatch '[0-9]') { throw 'Password does not meet registration requirements.' }
        $sent = Invoke-AccountApi 'send-code' @{ email = $accountEmail; purpose = 'REGISTER' }
        Assert-Api $sent 200 0 'Registration verification mail'
        $rateLimited = Invoke-AccountApi 'send-code' @{ email = $accountEmail; purpose = 'REGISTER' }
        Assert-Api $rateLimited 429 1003 'Registration resend limit'
        $accountCode = Read-Host 'Enter the 6-digit REGISTER code from your inbox (check spam folder)'
        $accountRegistration = @{ email = $accountEmail; password = $accountPlain; nickname = 'Migration Test'; verificationCode = $accountCode }
        $registered = Invoke-AccountApi 'register' $accountRegistration
        Assert-Api $registered 201 0 'Registration API'
        $duplicate = Invoke-AccountApi 'register' $accountRegistration
        Assert-Api $duplicate 409 1001 'Duplicate-email rejection'
        $passwordLogin = Invoke-AccountApi 'login' @{ email = $accountEmail; password = $accountPlain }
        Assert-Api $passwordLogin 200 0 'New-account password login'
        Assert-Session $passwordLogin.Body
        $accountRegistration = $null
        $passwordLogin = $null
    }
    $loginSent = Invoke-AccountApi 'send-code' @{ email = $accountEmail; purpose = 'LOGIN' }
    Assert-Api $loginSent 200 0 'Login verification mail'
    $loginRate = Invoke-AccountApi 'send-code' @{ email = $accountEmail; purpose = 'LOGIN' }
    Assert-Api $loginRate 429 1003 'Login resend limit'
    $accountLoginCode = Read-Host 'Enter the 6-digit LOGIN code from your inbox'
    $loginPayload = @{ email = $accountEmail; verificationCode = $accountLoginCode }
    $codeLogin = Invoke-AccountApi 'email-code-login' $loginPayload
    Assert-Api $codeLogin 200 0 'Email-code login API'
    Assert-Session $codeLogin.Body
    $reuse = Invoke-AccountApi 'email-code-login' $loginPayload
    Assert-Api $reuse 400 1002 'Consumed-code rejection'
    if ($accountMode -eq '2') { Write-Output 'Full registration/password/email-code batch: passed' }
    else { Write-Output 'Existing-account email-code login: passed; registration was not tested in this mode.' }
} finally {
    if ($accountBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($accountBstr) }
    if ($null -ne $accountSecret) { $accountSecret.Dispose() }
    $accountPlain = $null
    $accountRegistration = $null
    $codeLogin = $null
    $passwordLogin = $null
    $loginPayload = $null
}
