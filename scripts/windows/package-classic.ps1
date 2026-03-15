param(
  [string]$ProjectRoot = $(Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$PythonPath = "C:\Users\otik\AppData\Local\Programs\Python\Python312\python.exe"
)

Set-Location $ProjectRoot

$builderBin = Join-Path $ProjectRoot "node_modules\.bin\electron-builder.cmd"
$releaseDir = Join-Path $ProjectRoot "release"
$unpackedDir = Join-Path $releaseDir "win-unpacked"
$exePath = Join-Path $unpackedDir "BridgeGit.exe"
$iconPath = Join-Path $ProjectRoot "assets\icons\bridgegit.ico"

if (Test-Path $PythonPath) {
  $env:PYTHON = $PythonPath
  $env:NODE_GYP_FORCE_PYTHON = $PythonPath
  Write-Output "[BridgeGit] Using Python at $PythonPath"
}

$electronBuilderCache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$rceditOverrideRoot = Join-Path $env:LOCALAPPDATA "bridgegit-tools\rcedit"
$rceditCandidates = @()

if (Test-Path $electronBuilderCache) {
  $rceditCandidates = Get-ChildItem $electronBuilderCache -Directory |
    Where-Object {
      (Test-Path (Join-Path $_.FullName "rcedit-x64.exe")) -and
      (Test-Path (Join-Path $_.FullName "rcedit-ia32.exe"))
    } |
    Sort-Object LastWriteTime -Descending
}

if ($rceditCandidates.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $rceditOverrideRoot | Out-Null

  Copy-Item (Join-Path $rceditCandidates[0].FullName "rcedit-x64.exe") (Join-Path $rceditOverrideRoot "rcedit-x64.exe") -Force
  Copy-Item (Join-Path $rceditCandidates[0].FullName "rcedit-ia32.exe") (Join-Path $rceditOverrideRoot "rcedit-x86.exe") -Force

  Write-Output "[BridgeGit] Using RCEdit override at $rceditOverrideRoot"
}

Write-Output "[BridgeGit] npm install"
npm.cmd install
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (!(Test-Path $builderBin)) {
  Write-Error "[BridgeGit] Missing electron-builder at $builderBin"
  exit 1
}

if (Test-Path $releaseDir) {
  Write-Output "[BridgeGit] Removing previous release output"
  Remove-Item $releaseDir -Recurse -Force
}

Write-Output "[BridgeGit] npm run build"
npm.cmd run build
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Output "[BridgeGit] electron-builder --win dir --x64"
& $builderBin --win dir --x64
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$rceditExe = Join-Path $rceditOverrideRoot "rcedit-x64.exe"
if (!(Test-Path $rceditExe)) {
  Write-Error "[BridgeGit] Missing RCEdit binary at $rceditExe"
  exit 1
}

if (!(Test-Path $exePath)) {
  Write-Error "[BridgeGit] Missing unpacked app executable at $exePath"
  exit 1
}

if (!(Test-Path $iconPath)) {
  Write-Error "[BridgeGit] Missing icon at $iconPath"
  exit 1
}

Write-Output "[BridgeGit] Patching BridgeGit.exe icon with RCEdit"
& $rceditExe $exePath --set-icon $iconPath
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Output "[BridgeGit] electron-builder --win nsis --x64 --prepackaged release\\win-unpacked"
& $builderBin --win nsis --x64 --prepackaged $unpackedDir
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
