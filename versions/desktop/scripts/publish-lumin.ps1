# 把本仓库里的 lumin/ 目录导出成**独立仓库**并推送到 GitHub。
# 原理：git subtree split 会把历史里所有碰过 lumin/ 的提交挑出来、重建成一棵"根就是 lumin"的历史，
#       所以独立仓保留了完整的开发历史，但看不到 ITN-Desktop 的其他内容。
#
# 用法： pwsh -File scripts\publish-lumin.ps1
#        pwsh -File scripts\publish-lumin.ps1 -Remote git@github.com:SuanXiangJi/lumin.git -Branch main
#        pwsh -File scripts\publish-lumin.ps1 -Proxy http://127.0.0.1:7897     # 直连不通时手动指代理
param(
    [string]$Remote = 'https://github.com/SuanXiangJi/lumin.git',
    [string]$Branch = 'main',
    [string]$Split = 'lumin-standalone',
    [string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'

# 本机常见代理端口：直连 github.com 不通时，多半是没走本地代理
function Find-LocalProxy {
    foreach ($port in 7897, 7890, 10809, 10808, 1080, 2080, 7891) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $ok = $client.ConnectAsync('127.0.0.1', $port).Wait(300)
            if ($ok -and $client.Connected) { $client.Close(); return ("http://127.0.0.1:" + $port) }
        } catch { } finally { $client.Dispose() }
    }
    return ''
}

$proj = Resolve-Path "$PSScriptRoot\.."
$gitRoot = (git -C $proj rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $gitRoot) { throw '无法确定 Git 仓库根目录' }
$luminPath = Join-Path $proj 'lumin'
# subtree 的前缀相对于 Git 根目录，同时兼容独立检出与 versions/desktop。
$subtreePrefix = [System.IO.Path]::GetRelativePath($gitRoot, $luminPath).Replace('\', '/')
if ($subtreePrefix -eq '..' -or $subtreePrefix.StartsWith('../')) { throw 'Lumin 目录必须位于当前仓库内' }
Push-Location $gitRoot
try {
    # lumin/ 有未提交改动就停下 —— 否则推上去的历史和你眼前看到的代码对不上
    $dirty = @(git status --porcelain -- $subtreePrefix)
    if ($dirty.Count -gt 0) {
        Write-Output 'lumin/ 还有未提交的改动，先提交再发布：'
        $dirty | ForEach-Object { Write-Output ("  " + $_) }
        throw '工作区不干净'
    }

    git branch -D $Split 2>$null | Out-Null
    git subtree split --prefix=$subtreePrefix -b $Split
    if ($LASTEXITCODE -ne 0) { throw 'git subtree split 失败' }

    $refspec = "refs/heads/" + $Split + ":refs/heads/" + $Branch
    Write-Output ("推送 " + $Split + " -> " + $Remote + " 的 " + $Branch + " ...")

    if ($Proxy) {
        git -c http.proxy=$Proxy -c https.proxy=$Proxy push $Remote $refspec
        if ($LASTEXITCODE -ne 0) { throw 'git push 失败' }
    } else {
        git push $Remote $refspec
        if ($LASTEXITCODE -ne 0) {
            $found = Find-LocalProxy
            if (-not $found) { throw 'git push 失败（而且没在 127.0.0.1 上找到常见代理端口，直连也不通）' }
            Write-Output ("直连失败，改用本地代理 " + $found + " 重试 ...")
            git -c http.proxy=$found -c https.proxy=$found push $Remote $refspec
            if ($LASTEXITCODE -ne 0) { throw 'git push 失败（走代理也不行）' }
        }
    }

    Write-Output '完成。'
} finally {
    Pop-Location
}
