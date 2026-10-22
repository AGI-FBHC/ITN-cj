param(
  [string]$Version = '',
  [string]$RemoteHost = 'root@113.249.102.41',
  [string]$RemoteRoot = '/opt/lumin-release',
  [string]$PublicBaseUrl = 'http://113.249.102.41:6025',
  [switch]$ValidateOnly,
  [switch]$FullPublicDownload
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
if (!$Version) { $Version = (Get-Content "$repo\shell\package.json" -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version: $Version" }

$installer = Join-Path $repo "dist\Lumin-Setup-$Version.exe"
$portable = Join-Path $repo "dist\Lumin-$Version.zip"
$installerManifest = "$installer.json"
$acceptance = Join-Path $repo "tmp\installer-acceptance-$Version.json"
foreach ($file in @($installer, $portable, $installerManifest, $acceptance)) {
  if (!(Test-Path -LiteralPath $file)) { throw "Missing release evidence: $file" }
}

$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$portableHash = (Get-FileHash -LiteralPath $portable -Algorithm SHA256).Hash
$manifest = Get-Content -LiteralPath $installerManifest -Raw | ConvertFrom-Json
$accepted = Get-Content -LiteralPath $acceptance -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version -or $manifest.sha256 -ne $installerHash) { throw 'Installer manifest does not match the local installer' }
if ($accepted.version -ne $Version -or $accepted.installerSha256 -ne $installerHash -or [int]$accepted.passed -lt 24) {
  throw 'Installer acceptance is missing or does not match this installer'
}

Write-Output "RELEASE version=$Version installer=$installerHash portable=$portableHash"
node "$PSScriptRoot\release-server-check.cjs"
if ($LASTEXITCODE -ne 0) { throw 'Local release server checks failed' }

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$localPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$localServer = $null
$previousUrl = $env:RELEASE_PAGE_URL
try {
  $localServer = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @("$PSScriptRoot\serve-release.cjs", (Join-Path $repo 'dist'), "$localPort") `
    -WorkingDirectory $repo -WindowStyle Hidden -PassThru
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$localPort/health" -TimeoutSec 2).StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
  if (!$ready) { throw 'Local release server did not start' }
  $env:RELEASE_PAGE_URL = "http://127.0.0.1:$localPort/"
  node "$PSScriptRoot\release-page-check.cjs"
  if ($LASTEXITCODE -ne 0) { throw 'Local release page checks failed' }
} finally {
  $env:RELEASE_PAGE_URL = $previousUrl
  if ($localServer) { Stop-Process -Id $localServer.Id -Force -ErrorAction SilentlyContinue }
}

if (!$ValidateOnly) {
  $sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
  & ssh @sshOptions $RemoteHost "mkdir -p '$RemoteRoot/incoming' '$RemoteRoot/backups'; ts=`$(date +%Y%m%d-%H%M%S); cp -p '$RemoteRoot/serve-release.cjs' '$RemoteRoot/backups/serve-release.cjs-`$ts'; cp -p '$RemoteRoot/release-site/index.html' '$RemoteRoot/backups/index.html-`$ts'; echo `$ts > '$RemoteRoot/backups/latest-deploy-seq'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not back up the remote release service' }

  $uploads = @(
    @{local=$installer; remote="$RemoteRoot/incoming/Lumin-Setup-$Version.exe.uploading"},
    @{local=$portable; remote="$RemoteRoot/incoming/Lumin-$Version.zip.uploading"},
    @{local=(Join-Path $PSScriptRoot 'serve-release.cjs'); remote="$RemoteRoot/incoming/serve-release.cjs.uploading"},
    @{local=(Join-Path $PSScriptRoot 'release-site\index.html'); remote="$RemoteRoot/incoming/index.html.uploading"}
  )
  $scpPath = (Get-Command scp).Source
  $uploadProcesses = @($uploads | ForEach-Object {
    Start-Process -FilePath $scpPath `
      -ArgumentList ($sshOptions + @($_.local, "${RemoteHost}:$($_.remote)")) `
      -WindowStyle Hidden -PassThru
  })
  foreach ($process in $uploadProcesses) {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Upload process failed with exit code $($process.ExitCode)" }
  }

  $remoteHashes = & ssh @sshOptions $RemoteHost "sha256sum '$RemoteRoot/incoming/Lumin-Setup-$Version.exe.uploading' '$RemoteRoot/incoming/Lumin-$Version.zip.uploading' '$RemoteRoot/incoming/serve-release.cjs.uploading' '$RemoteRoot/incoming/index.html.uploading'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not hash remote uploads' }
  $expected = @(
    $installerHash,
    $portableHash,
    (Get-FileHash -LiteralPath "$PSScriptRoot\serve-release.cjs" -Algorithm SHA256).Hash,
    (Get-FileHash -LiteralPath "$PSScriptRoot\release-site\index.html" -Algorithm SHA256).Hash
  )
  $actual = @($remoteHashes | ForEach-Object { ($_ -split '\s+')[0].ToUpperInvariant() })
  for ($i = 0; $i -lt $expected.Count; $i++) {
    if ($actual[$i] -ne $expected[$i]) { throw "Remote upload hash mismatch at index $i" }
  }

  & ssh @sshOptions $RemoteHost "set -eu; cd '$RemoteRoot'; mv 'incoming/Lumin-Setup-$Version.exe.uploading' 'releases/Lumin-Setup-$Version.exe'; mv 'incoming/Lumin-$Version.zip.uploading' 'releases/Lumin-$Version.zip'; mv incoming/serve-release.cjs.uploading serve-release.cjs; mv incoming/index.html.uploading release-site/index.html; chown root:lumin-release 'releases/Lumin-Setup-$Version.exe' 'releases/Lumin-$Version.zip'; chown root:root serve-release.cjs release-site/index.html; chmod 644 'releases/Lumin-Setup-$Version.exe' 'releases/Lumin-$Version.zip' serve-release.cjs release-site/index.html; systemctl restart lumin-release.service; for i in `$(seq 1 30); do curl -fsS --max-time 2 http://127.0.0.1:6025/health >/tmp/lumin-health.json && exit 0; sleep 1; done; exit 1"
  if ($LASTEXITCODE -ne 0) { throw 'Remote release activation failed' }
}

$previousUrl = $env:RELEASE_PAGE_URL
try {
  $env:RELEASE_PAGE_URL = "$($PublicBaseUrl.TrimEnd('/'))/"
  node "$PSScriptRoot\release-page-check.cjs"
  if ($LASTEXITCODE -ne 0) { throw 'Public release page checks failed' }
} finally {
  $env:RELEASE_PAGE_URL = $previousUrl
}

if ($FullPublicDownload) {
  $downloadDir = Join-Path $repo "tmp\public-download-$Version"
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  node "$PSScriptRoot\verify-public-release.cjs" "$($PublicBaseUrl.TrimEnd('/'))/Lumin-Setup-$Version.exe" (Join-Path $downloadDir "Lumin-Setup-$Version.exe") (Get-Item $installer).Length $installerHash 24
  if ($LASTEXITCODE -ne 0) { throw 'Public installer download verification failed' }
  node "$PSScriptRoot\verify-public-release.cjs" "$($PublicBaseUrl.TrimEnd('/'))/Lumin-$Version.zip" (Join-Path $downloadDir "Lumin-$Version.zip") (Get-Item $portable).Length $portableHash 24
  if ($LASTEXITCODE -ne 0) { throw 'Public portable download verification failed' }
}

Write-Output "DEPLOY_OK $($PublicBaseUrl.TrimEnd('/'))/Lumin-Setup-$Version.exe"
Write-Output "DEPLOY_OK $($PublicBaseUrl.TrimEnd('/'))/Lumin-$Version.zip"
