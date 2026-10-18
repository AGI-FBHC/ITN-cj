$ErrorActionPreference = 'Stop'
$accountEnvPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $accountEnvPath)) { throw 'Create the local .env file first.' }
$accountEnvKeys = @('DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','JWT_SECRET','ACCESS_TOKEN_TTL_SECONDS',
    'SMTP_HOST','SMTP_PORT','SMTP_USERNAME','SMTP_PASSWORD','EMAIL_FROM','SMTP_FROM','MAIL_FROM_NAME','MAIL_SUBJECT_PREFIX',
    'VERIFICATION_CODE_TTL_SECONDS','VERIFICATION_CODE_RESEND_SECONDS','RAG_ASSET_DIR','KNOWLEDGE_CORE_URL','KC_INTERNAL_SECRET','AGENT_URL','AGENT_INTERNAL_SECRET')
foreach ($accountLine in (Get-Content -LiteralPath $accountEnvPath -Encoding UTF8)) {
    $accountLine = $accountLine.Trim()
    if ($accountLine.Length -eq 0 -or $accountLine.StartsWith('#')) { continue }
    $accountParts = $accountLine.Split([char[]]@('='), 2)
    if ($accountParts.Length -ne 2) { throw 'Invalid .env entry. Use KEY=VALUE.' }
    $accountKey = $accountParts[0].Trim()
    if ($accountEnvKeys -notcontains $accountKey) { continue }
    $accountValue = $accountParts[1].Trim()
    if ($accountValue.Length -ge 2 -and (($accountValue.StartsWith('"') -and $accountValue.EndsWith('"')) -or
        ($accountValue.StartsWith("'") -and $accountValue.EndsWith("'")))) {
        $accountValue = $accountValue.Substring(1, $accountValue.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($accountKey, $accountValue, [EnvironmentVariableTarget]::Process)
}
if ([String]::IsNullOrEmpty($env:DB_PASSWORD)) { throw 'DB_PASSWORD is missing.' }
if ([String]::IsNullOrEmpty($env:JWT_SECRET)) { throw 'JWT_SECRET is missing.' }
Write-Output 'Database, JWT and mail environment variables loaded.'
