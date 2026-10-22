param([string]$Installer, [string]$SourceDir='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot\..").Path
$version=(Get-Content "$repo\shell\package.json" -Raw|ConvertFrom-Json).version
if(!$Installer){$Installer=Join-Path $repo "dist\Lumin-Setup-$version.exe"}
if(!$SourceDir){$SourceDir=Join-Path $repo "dist\Lumin-$version"}
$Installer=(Resolve-Path -LiteralPath $Installer).Path
$SourceDir=(Resolve-Path -LiteralPath $SourceDir).Path
$root=Join-Path $env:TEMP ('Lumin检查-'+[guid]::NewGuid().ToString('N').Substring(0,8)+'-学员')
$installed=Join-Path $root '应用安装 验收'
New-Item -ItemType Directory -Path $root | Out-Null
$desktop=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lumin.lnk'
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'Lumin'
$links=@($desktop,(Join-Path $menu 'Lumin.lnk'),(Join-Path $menu '卸载 Lumin.lnk'))
$snapshots=@{}
foreach($file in $links){$snapshots[$file]=if(Test-Path -LiteralPath $file){[IO.File]::ReadAllBytes($file)}else{$null}}
$keys=@('HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin','HKCU\Software\Classes\lumin')
$registry=@{}
foreach($key in $keys){
  $pspath=$key.Replace('HKCU\','HKCU:\')
  if(Test-Path -LiteralPath $pspath){
    $backup=Join-Path $root ('registry-'+$registry.Count+'.reg')
    & reg.exe export $key $backup /y | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Could not preserve original registry'}
    $registry[$key]=$backup
  }else{$registry[$key]=$null}
}
$script:checks=0
function Check([bool]$condition,[string]$message){if(!$condition){throw $message};$script:checks++;Write-Output ('PASS '+$message)}
function Install {
  $p=Start-Process -FilePath $Installer -ArgumentList '/S',('/D='+$installed) -WindowStyle Hidden -PassThru -Wait
  return $p.ExitCode
}
$p=$null
try {
  Check ((Install) -eq 0) 'silent install succeeds in Chinese and space path'
  Check (Test-Path -LiteralPath (Join-Path $installed 'Lumin.exe')) 'installed application exists'
  $files=@(Get-ChildItem -LiteralPath $SourceDir -Recurse -File)
  foreach($file in $files){
    $relative=$file.FullName.Substring($SourceDir.Length+1)
    $target=Join-Path $installed $relative
    if(!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $target).Hash){throw "Installed payload differs: $relative"}
  }
  Check $true ("all $($files.Count) installed files match source hashes")
  $uninstallKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumin'
  $registration=Get-ItemProperty -LiteralPath $uninstallKey
  Check ($registration.InstallLocation -eq $installed -and $registration.DisplayVersion -eq $version) 'uninstall registration has correct path and version'
  Check ($registration.UninstallString -eq ('"'+$installed+'\Uninstall Lumin.exe"')) 'quoted uninstall command handles spaces'
  $protocol=(Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\lumin\shell\open\command').'(default)'
  Check ($protocol -eq ('"'+$installed+'\Lumin.exe" "%1"')) 'deep link command points to installed application'
  $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $menu 'Lumin.lnk'))
  Check ($shortcut.TargetPath -eq (Join-Path $installed 'Lumin.exe')) 'start menu shortcut targets installed application'
  $extra=Join-Path $installed 'user-extra.txt'
  [IO.File]::WriteAllText($extra,'keep custom file')
  $data=Join-Path $root 'Lumin'
  New-Item -ItemType Directory -Force $data | Out-Null
  $marker=Join-Path $data 'user-data-marker.txt'
  [IO.File]::WriteAllText($marker,'keep learning data')
  $lock=[IO.File]::Open((Join-Path $installed 'Lumin.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try { Check ((Install) -eq 2) 'upgrade refuses locked running application files' } finally { $lock.Dispose() }
  Check ((Install) -eq 0) 'repeat install succeeds when files are unlocked'
  Check ((Get-Content -LiteralPath $marker -Raw) -eq 'keep learning data') 'upgrade preserves user data'
  Check ((Get-Content -LiteralPath $extra -Raw) -eq 'keep custom file') 'upgrade preserves additional installation-directory files'
  $environment=@{LOCALAPPDATA=$root;APPDATA=$root;TEMP=$root;TMP=$root}
  $p=Start-Process -FilePath (Join-Path $installed 'Lumin.exe') -ArgumentList '--smoke','--ui-check',('--user-data-dir='+ (Join-Path $root 'electron-profile')) -Environment $environment -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'startup.log') -RedirectStandardError (Join-Path $root 'startup.err')
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  $resultFile=Join-Path $root 'lumin-smoke-result.txt'
  while(!(Test-Path -LiteralPath $resultFile) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
  Check (Test-Path -LiteralPath $resultFile) 'installed Electron produces smoke result'
  $result=Get-Content -LiteralPath $resultFile -Raw
  Write-Output $result
  Check ($result -match 'RESULT=OK' -and $result -match 'PRELOAD=ok' -and $result -match 'TITLEBAR=ok') 'installed preload, title bar and application start pass'
  if(!$p.WaitForExit(10000)){$p.Kill();throw 'Smoke process did not finish'}
  $runtime='C:\Users\GeJie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  & $runtime "$PSScriptRoot\check-installed-resources.cjs" $installed $root "$repo\tmp\proposal-0.8.28.pdf"
  Check ($LASTEXITCODE -eq 0) 'installed PPT DOCX PDF runtime and isolated database pass'
  $database=Join-Path $data 'itn.db'
  $databaseHash=(Get-FileHash -LiteralPath $database).Hash
  Check ((Install) -eq 0) 'upgrade succeeds with an existing initialized database'
  Check ((Get-FileHash -LiteralPath $database).Hash -eq $databaseHash) 'upgrade leaves the actual learning database byte-identical'
  $u=Start-Process -FilePath (Join-Path $installed 'Uninstall Lumin.exe') -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while((Test-Path -LiteralPath (Join-Path $installed 'Lumin.exe')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
  Check (!(Test-Path -LiteralPath (Join-Path $installed 'Lumin.exe'))) 'uninstall removes owned application files'
  Check (Test-Path -LiteralPath $extra) 'uninstall preserves unrelated files in chosen directory'
  Check ((Get-Content -LiteralPath $marker -Raw) -eq 'keep learning data') 'uninstall retains learning data'
  Check ((Get-FileHash -LiteralPath $database).Hash -eq $databaseHash) 'uninstall leaves the actual learning database byte-identical'
  Check (!(Test-Path -LiteralPath $uninstallKey)) 'uninstall removes its registration'
  Check ((Install) -eq 0) 'reinstall succeeds after uninstall'
  Check ((Get-Content -LiteralPath $marker -Raw) -eq 'keep learning data') 'reinstall retains previous data'
  Check ((Get-FileHash -LiteralPath $database).Hash -eq $databaseHash) 'reinstall leaves the actual learning database byte-identical'
  Start-Process -FilePath (Join-Path $installed 'Uninstall Lumin.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while((Test-Path -LiteralPath $uninstallKey) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
  Write-Output ("RESULT $script:checks/$script:checks PASS; evidence=$root")
} finally {
  $owned=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($installed+'\',[StringComparison]::OrdinalIgnoreCase)})
  foreach($process in $owned){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
  # Restore precisely the registry keys and shortcuts touched by this product's installer.
  foreach($key in $keys){
    $pspath=$key.Replace('HKCU\','HKCU:\')
    if(Test-Path -LiteralPath $pspath){Remove-Item -LiteralPath $pspath -Recurse -Force}
    if($registry[$key]){& reg.exe import $registry[$key] | Out-Null}
  }
  foreach($file in $links){
    if($null -ne $snapshots[$file]){
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
      [IO.File]::WriteAllBytes($file,$snapshots[$file])
    }
    elseif(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}
  }
  if((Test-Path -LiteralPath $menu) -and @(Get-ChildItem -LiteralPath $menu -Force).Count -eq 0){Remove-Item -LiteralPath $menu}
}
[ordered]@{version=$version;installerSha256=(Get-FileHash -LiteralPath $Installer).Hash;passed=$script:checks;payloadFiles=$files.Count;evidence=$root}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $repo "tmp\installer-acceptance-$version.json") -Encoding utf8
