$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-db-env.ps1')
$guestSdkName = [string][char]0x4ed3 + [string][char]0x9889
. ('F:\' + $guestSdkName + '\Cangjie\envsetup.ps1')
$env:CANGJIE_STDX_PATH = 'F:\cangjie-stdx\windows_x86_64_cjnative\dynamic\stdx'
$env:Path = $env:CANGJIE_STDX_PATH + ';F:\OpenSSL-Win64\bin;C:\Program Files\MySQL\MySQL Server 8.4\lib;C:\Program Files\MySQL\MySQL Server 8.4\bin;' + $env:Path
$guestProgram = Join-Path $PSScriptRoot 'target\release\bin\main.exe'

function Invoke-GuestApi([string] $path, $payload = $null) {
    $request = @{ Uri = ('http://127.0.0.1:5000/api/v1/auth/' + $path); Method = 'Post'; UseBasicParsing = $true; TimeoutSec = 60; ErrorAction = 'Stop' }
    if ($null -ne $payload) {
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
    }
    try {
        $response = Invoke-WebRequest @request
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
    }
}
function Assert-GuestResult($result, [int] $status, [int] $code, [string] $label) {
    if ($result.Status -ne $status -or $result.Body.code -ne $code) {
        Write-Output ('HTTP ' + $result.Status + '; code ' + $result.Body.code + '; ' + $result.Body.message)
        throw ($label + ' failed. Check the server window for details.')
    }
    Write-Output ($label + ': passed')
}
function Assert-GuestSession($data) {
    if ($data.tokenType -cne 'Bearer' -or [string]::IsNullOrEmpty($data.accessToken) -or $data.expiresInSeconds -le 0) {
        throw 'Login JWT response is incomplete.'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($data.accessToken))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    & $guestProgram ('--check-login-session=' + $hash)
    if ($LASTEXITCODE -ne 0) { throw 'Guest/demo session was not saved.' }
}

$guestResponses = @{}
foreach ($persona in @('beginner','research','practitioner')) {
    $result = Invoke-GuestApi ('guest-login?persona=' + $persona)
    Assert-GuestResult $result 200 0 ($persona + ' guest login')
    $data = $result.Body.data
    if ($data.guest -ne $true -or @($data.roles).Count -ne 1 -or $data.roles[0] -cne 'guest' -or
        $data.organizationCode -cne 'cloudbrain-shanghai') { throw 'Guest role/organization response mismatch.' }
    [guid]::Parse($data.user.id) | Out-Null
    [guid]::Parse($data.learnerId) | Out-Null
    Assert-GuestSession $data
    & $guestProgram ('--check-guest-profile=' + $persona + ':' + $data.user.id + ':' + $data.learnerId)
    if ($LASTEXITCODE -ne 0) { throw ($persona + ' preset was not saved correctly.') }
    $repeat = Invoke-GuestApi ('guest-login?persona=' + $persona)
    Assert-GuestResult $repeat 200 0 ($persona + ' repeat login')
    if ($repeat.Body.data.user.id -cne $data.user.id -or $repeat.Body.data.learnerId -cne $data.learnerId -or
        $repeat.Body.data.accessToken -ceq $data.accessToken) { throw 'Repeated guest login did not reuse the account/profile with a fresh token.' }
    $guestResponses[$persona] = $data
}
$defaultGuest = Invoke-GuestApi 'guest-login'
Assert-GuestResult $defaultGuest 200 0 'Default guest login'
if ($defaultGuest.Body.data.user.id -cne $guestResponses['research'].user.id) { throw 'Default guest should use research persona.' }
$advanced = Invoke-GuestApi 'guest-login?persona=advanced'
Assert-GuestResult $advanced 200 0 'Advanced persona alias'
if ($advanced.Body.data.user.id -cne $guestResponses['practitioner'].user.id) { throw 'Advanced alias should use practitioner persona.' }
$unknown = Invoke-GuestApi 'guest-login?persona=unknown-fixture'
Assert-GuestResult $unknown 200 0 'Unknown persona fallback'
if ($unknown.Body.data.user.id -cne $guestResponses['research'].user.id) { throw 'Unknown persona should use research persona.' }

$demoRaw = & $guestProgram '--list-demo-codes'
if ($LASTEXITCODE -ne 0) { throw 'Could not read existing DEMO identities.' }
$parsedDemoCodes = ($demoRaw -join [Environment]::NewLine) | ConvertFrom-Json
# Windows PowerShell 5.1 emits a JSON array as one pipeline object.
# Enumerate the parsed value separately to keep each code a single string.
$demoCodes = @($parsedDemoCodes)
if ($demoCodes.Count -eq 0) {
    Write-Output 'No active imported DEMO identity found; preparing one local test identity for the research guest learner.'
    $prepared = & $guestProgram '--prepare-local-demo-fixture'
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare a local demo fixture.' }
    $demoCode = $prepared | ConvertFrom-Json
} else { $demoCode = $demoCodes[0] }
if ($demoCode -isnot [string] -or [string]::IsNullOrWhiteSpace($demoCode) -or $demoCode.Length -gt 64) {
    throw 'Selected DEMO identity must be a single non-empty string of at most 64 characters.'
}
$demo = Invoke-GuestApi 'demo-login' @{ learnerCode = $demoCode }
Assert-GuestResult $demo 200 0 'Demo account login'
if ($demo.Body.data.guest -ne $false -or @($demo.Body.data.roles).Count -ne 1 -or
    $demo.Body.data.roles[0] -cne 'learner' -or $demo.Body.data.learnerId -cne $demoCode.Trim().ToLowerInvariant()) {
    throw 'Demo account response differs from the legacy contract.'
}
Assert-GuestSession $demo.Body.data
$normalized = Invoke-GuestApi 'demo-login' @{ learnerCode = (' ' + $demoCode.ToUpperInvariant() + ' ') }
Assert-GuestResult $normalized 200 0 'Demo code normalization'
if ($normalized.Body.data.user.id -cne $demo.Body.data.user.id) { throw 'Demo normalization changed the selected user.' }
$missing = Invoke-GuestApi 'demo-login' @{ learnerCode = ('missing-' + [guid]::NewGuid().ToString('N')) }
Assert-GuestResult $missing 404 3004 'Missing demo rejection'
$blank = Invoke-GuestApi 'demo-login' @{ learnerCode = ' ' }
Assert-GuestResult $blank 400 1000 'Empty demo code rejection'
Write-Output 'Full guest/demo batch: passed'
$guestResponses = $null
$demo = $null
$normalized = $null
