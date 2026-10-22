# Project-local MySQL uses a separate data directory and port from other projects.
# Call after loading .env.local; remote database configurations are left untouched.
$ErrorActionPreference = 'Stop'
if ($env:ZHIXUN_DB_HOST -notin @('127.0.0.1', 'localhost') -or $env:ZHIXUN_DB_PORT -ne '13307') { return }

$projectRoot = Split-Path -Parent $PSScriptRoot
$mysqlRoot = Join-Path $projectRoot 'data/local-mysql'
$mysqlConfig = Join-Path $mysqlRoot 'my.ini'
$mysqlBin = 'C:/Program Files/MySQL/MySQL Server 9.3/bin'
if (-not (Test-Path -LiteralPath $mysqlConfig)) {
    throw 'Project MySQL configuration is missing: data/local-mysql/my.ini. Restore the local database before starting.'
}

function Test-ProjectMySqlPort {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connected = $client.ConnectAsync('127.0.0.1', 13307)
        if (-not $connected.Wait(500)) { return $false }
        return $client.Connected
    } catch { return $false } finally { $client.Dispose() }
}

if (-not (Test-ProjectMySqlPort)) {
    $mysqlExe = Join-Path $mysqlBin 'mysqld.exe'
    if (-not (Test-Path -LiteralPath $mysqlExe)) { throw "MySQL executable is missing: $mysqlExe" }
    $process = Start-Process -FilePath $mysqlExe `
        -ArgumentList ('"--defaults-file={0}"' -f $mysqlConfig) `
        -WorkingDirectory $mysqlRoot -WindowStyle Hidden -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-ProjectMySqlPort) { $ready = $true; break }
        if ($process.HasExited) { break }
    }
    if (-not $ready) { throw 'Project MySQL did not start. Check data/local-mysql/mysql-error.log.' }
}

# The current native Cangjie driver supports caching_sha2_password fast auth.
# A standard client primes that cache after MySQL starts; no password is put in argv.
$mysqlClient = Join-Path $mysqlBin 'mysql.exe'
$previousPassword = $env:MYSQL_PWD
try {
    $env:MYSQL_PWD = $env:ZHIXUN_DB_PASSWORD
    $clientArgs = @('--protocol=TCP', '--host=127.0.0.1', '--port=13307',
        "--user=$($env:ZHIXUN_DB_USER)", '--connect-timeout=5',
        '--batch', '--skip-column-names', '--execute=SELECT 1', $env:ZHIXUN_DB_NAME)
    $null = & $mysqlClient @clientArgs
    if ($LASTEXITCODE -ne 0) { throw 'Project MySQL application account could not connect.' }
} finally {
    if ($null -eq $previousPassword) { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
    else { $env:MYSQL_PWD = $previousPassword }
}
