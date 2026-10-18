$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$logoInput = $null
$logoImage = $null
$logoBitmap = $null
$logoGraphics = $null
$logoOutput = $null
try {
    Add-Type -AssemblyName System.Drawing
    $logoEncoded = [Console]::In.ReadLine()
    if ($logoEncoded.Length -gt 2796204) { exit 2 }
    $logoBytes = [Convert]::FromBase64String($logoEncoded)
    if ($logoBytes.Length -eq 0 -or $logoBytes.Length -gt 2097152) { exit 2 }
    $logoInput = [IO.MemoryStream]::new($logoBytes, $false)
    $logoImage = [Drawing.Image]::FromStream($logoInput, $true, $true)
    if ($logoImage.Width -lt 1 -or $logoImage.Height -lt 1) { exit 4 }
    if ([long]$logoImage.Width * [long]$logoImage.Height -gt 16000000) { exit 3 }
    $logoScale = [Math]::Min(1.0, 1024.0 / [Math]::Max($logoImage.Width, $logoImage.Height))
    $logoWidth = [Math]::Max(1, [int][Math]::Floor($logoImage.Width * $logoScale + 0.5))
    $logoHeight = [Math]::Max(1, [int][Math]::Floor($logoImage.Height * $logoScale + 0.5))
    $logoBitmap = [Drawing.Bitmap]::new($logoWidth, $logoHeight, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $logoGraphics = [Drawing.Graphics]::FromImage($logoBitmap)
    $logoGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $logoGraphics.DrawImage($logoImage, 0, 0, $logoWidth, $logoHeight)
    $logoOutput = [IO.MemoryStream]::new()
    $logoBitmap.Save($logoOutput, [Drawing.Imaging.ImageFormat]::Png)
    [Console]::Out.Write([Convert]::ToBase64String($logoOutput.ToArray()))
} catch { exit 4 }
finally {
    foreach ($logoResource in @($logoGraphics, $logoBitmap, $logoImage, $logoOutput, $logoInput)) {
        if ($null -ne $logoResource) { $logoResource.Dispose() }
    }
}
