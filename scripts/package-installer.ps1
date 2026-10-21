param([string]$AppDir='', [string]$Compiler='', [string]$Output='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot\..").Path
$version=(Get-Content "$repo\shell\package.json" -Raw|ConvertFrom-Json).version
if(!$AppDir){$AppDir=Join-Path $repo "dist\Lumin-$version"}
$AppDir=(Resolve-Path -LiteralPath $AppDir).Path
if(!$Output){$Output=Join-Path $repo "dist\Lumin-Setup-$version-x64.exe"}
$Output=[IO.Path]::GetFullPath($Output)
if(Test-Path -LiteralPath $Output){throw "Installer already exists; choose a new output path: $Output"}
if(!$Compiler){
  $Compiler=Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\nsis-*\*\makensis.exe" -File | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if(!$Compiler -or !(Test-Path -LiteralPath $Compiler)){throw 'NSIS compiler missing; specify -Compiler'}
$manifest=Get-Content (Join-Path $AppDir 'release.json') -Raw|ConvertFrom-Json
if($manifest.version -ne $version){throw 'Application version and release manifest differ'}
foreach($asset in $manifest.assets.PSObject.Properties){
  if((Get-FileHash -LiteralPath (Join-Path $AppDir $asset.Name)).Hash -ne $asset.Value){throw "Application asset changed: $($asset.Name)"}
}
$build=Join-Path $repo ('tmp\installer-build-'+(Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Force -Path $build | Out-Null
$icon=Join-Path $repo 'shell/assets/lumin.ico'
if(!(Test-Path -LiteralPath $icon)){throw 'Lumin Windows icon is missing'}
$files=@(Get-ChildItem -LiteralPath $AppDir -File -Recurse)
$dirs=@(Get-ChildItem -LiteralPath $AppDir -Directory -Recurse|Sort-Object {$_.FullName.Length} -Descending)
$lines=@($files|ForEach-Object {'Delete "$INSTDIR\'+$_.FullName.Substring($AppDir.Length+1).Replace('$','$$')+'"'})
$lines+=@($dirs|ForEach-Object {'RMDir "$INSTDIR\'+$_.FullName.Substring($AppDir.Length+1).Replace('$','$$')+'"'})
$include=Join-Path $build 'uninstall-files.nsh'
[IO.File]::WriteAllLines($include,$lines,[Text.UTF8Encoding]::new($true))
$script=Join-Path $build 'lumin.nsi'
[IO.File]::WriteAllText($script,[IO.File]::ReadAllText("$PSScriptRoot\installer\lumin.nsi"),[Text.UTF8Encoding]::new($true))
$kb=[math]::Ceiling(($files|Measure-Object Length -Sum).Sum/1KB)
& $Compiler /V3 "/DVERSION=$version" "/DINPUT_DIR=$AppDir" "/DOUTPUT_FILE=$Output" "/DINSTALLER_ICON=$icon" "/DUNINSTALL_INCLUDE=$include" "/DINSTALL_SIZE_KB=$kb" $script
if($LASTEXITCODE -ne 0){throw 'NSIS compilation failed'}
$result=[ordered]@{version=$version;file=[IO.Path]::GetFileName($Output);bytes=(Get-Item -LiteralPath $Output).Length;sha256=(Get-FileHash -LiteralPath $Output).Hash;payloadCommit=$manifest.sourceCommit;payloadFiles=$files.Count;compilerSha256=(Get-FileHash -LiteralPath $Compiler).Hash}
$result|ConvertTo-Json|Set-Content -LiteralPath ($Output+'.json') -Encoding utf8
$result|ConvertTo-Json
