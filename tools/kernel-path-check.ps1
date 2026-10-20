param([string]$Package='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot\..").Path
if(!$Package){$version=(Get-Content "$repo\shell\package.json" -Raw|ConvertFrom-Json).version;$Package=Join-Path $repo "dist\Lumin-$version"}
$root=Join-Path $env:TEMP ('lumin-path-'+[guid]::NewGuid().ToString('N')+'-中文 空格')
$kernel=Join-Path $root '内核运行'
$ui=Join-Path $root '界面资源'
$data=Join-Path $root '学习数据'
$skills=Join-Path $root '内置技能'
$portFile=Join-Path $root '服务端口.txt'
New-Item -ItemType Directory -Path $root,$ui,$data,$skills | Out-Null
Copy-Item -LiteralPath (Join-Path $Package 'resources\kernel') -Destination $kernel -Recurse
Copy-Item -LiteralPath (Join-Path $Package 'resources\app\renderer\index.html') -Destination $ui
$p=$null
try {
  $args=@('--data-dir="'+$data+'"','--ui-dir="'+$ui+'"','--skills-dir="'+$skills+'"','--port-file="'+$portFile+'"','--seed-guided-fixture=1')
  $p=Start-Process -FilePath (Join-Path $kernel 'lumin-core.exe') -WorkingDirectory $kernel -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'stdout.log') -RedirectStandardError (Join-Path $root 'stderr.log')
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while(!(Test-Path -LiteralPath $portFile) -and !$p.HasExited -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
  if(!(Test-Path -LiteralPath $portFile)){throw ('Unicode path startup failed: '+(Get-Content (Join-Path $root 'stderr.log') -Raw))}
  $base='http://127.0.0.1:'+(Get-Content -LiteralPath $portFile -Raw).Trim()
  if((Invoke-RestMethod ($base+'/health')).data.status -ne 'ok'){throw 'Unicode path health failed'}
  if((Invoke-WebRequest $base).Content -notmatch 'Lumin|LUMIN'){throw 'Unicode UI path cannot be read'}
  if(!(Test-Path -LiteralPath (Join-Path $data 'itn.db'))){throw 'Unicode database path was not created'}
  Write-Output ('PASS Chinese executable, working directory, argv, UI, skills, data and port paths; '+$root)
}finally{if($p -and !$p.HasExited){$p.Kill();[void]$p.WaitForExit(5000)}}
