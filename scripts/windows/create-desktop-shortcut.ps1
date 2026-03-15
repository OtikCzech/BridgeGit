param(
  [string]$ProjectRoot = $(Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$ShortcutName = "BridgeGit"
)

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath ($ShortcutName + ".lnk")
$launcherPath = Join-Path $ProjectRoot "scripts\windows\launch-app-hidden.vbs"
$iconPath = Join-Path $ProjectRoot "assets\icons\bridgegit.ico"

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$shortcut.Arguments = '"' + $launcherPath + '"'
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = "Launch BridgeGit"
$shortcut.IconLocation = $iconPath
$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
