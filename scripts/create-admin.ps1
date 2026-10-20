param(
    [string]$Account = 'admin',
    [string]$Password = '',
    [string]$DisplayName = '管理员'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing $envFile" }

$envMap = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') { $envMap[$Matches[1].Trim()] = $Matches[2].Trim() }
}
if ($envMap['ZHIXUN_DB_NAME'] -ne 'itn_learning_v2_dev') {
    throw 'Refusing to create an admin outside the isolated itn_learning_v2_dev database'
}
if ([string]::IsNullOrWhiteSpace($Password)) {
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $Password = -join (1..12 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
}

$mysql = (Get-Command mysql.exe -ErrorAction SilentlyContinue).Source
if (-not $mysql) { $mysql = 'C:\Program Files\MySQL\MySQL Server 9.3\bin\mysql.exe' }

$salt = [guid]::NewGuid().ToString('N')
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("${salt}:${Password}")) | ForEach-Object { $_.ToString('x2') })
$userId = [guid]::NewGuid().ToString()
$loginKey = $Account.ToLowerInvariant().Replace("'", "''")
$escapedName = $DisplayName.Replace("'", "''")

$sql = @"
INSERT INTO users(id,login_key,password_salt,password_hash,display_name,role,created_at)
VALUES('$userId','$loginKey','$salt','$hash','$escapedName','admin',NOW(6))
ON DUPLICATE KEY UPDATE password_salt=VALUES(password_salt),password_hash=VALUES(password_hash),display_name=VALUES(display_name),role='admin';
"@

# Feed the statement through a UTF-8 file so the console code page cannot corrupt the display name.
$tempSql = Join-Path ([IO.Path]::GetTempPath()) ("zhixun-admin-" + [guid]::NewGuid().ToString('N') + ".sql")
[IO.File]::WriteAllText($tempSql, $sql, [Text.UTF8Encoding]::new($false))
try {
    & $mysql -h $envMap['ZHIXUN_DB_HOST'] -P $envMap['ZHIXUN_DB_PORT'] -u $envMap['ZHIXUN_DB_USER'] `
        "-p$($envMap['ZHIXUN_DB_PASSWORD'])" --default-character-set=utf8mb4 `
        "--database=$($envMap['ZHIXUN_DB_NAME'])" -e "source $($tempSql.Replace('\', '/'))" 2>&1 |
        Where-Object { $_ -notmatch 'Using a password' }
    if ($LASTEXITCODE -ne 0) { throw 'Creating the admin account failed' }
} finally {
    Remove-Item -LiteralPath $tempSql -ErrorAction SilentlyContinue
}

Write-Output "管理员账号: $loginKey"
Write-Output "管理员密码: $Password"
Write-Output '请登录管理端后把密码存到安全位置；重新执行本脚本并传入 -Password 可重置。'
