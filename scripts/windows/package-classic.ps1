param(
  [string]$ProjectRoot = $(Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$PythonPath = ""
)

Set-Location $ProjectRoot

$builderBin = Join-Path $ProjectRoot "node_modules\.bin\electron-builder.cmd"
$releaseDir = Join-Path $ProjectRoot "release"
$unpackedDir = Join-Path $releaseDir "win-unpacked"
$exePath = Join-Path $unpackedDir "BridgeGit.exe"
$iconPath = Join-Path $ProjectRoot "assets\icons\bridgegit.ico"

function Resolve-CommandPath {
  param(
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($command -and $command.Source) {
      return $command.Source
    }
  }

  return $null
}

function Resolve-PythonPath {
  param(
    [string]$PreferredPath
  )

  if ($PreferredPath -and (Test-Path $PreferredPath)) {
    return (Resolve-Path $PreferredPath).Path
  }

  $pyLauncher = Resolve-CommandPath @("py")
  if ($pyLauncher) {
    $resolvedPython = & $pyLauncher -3 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $resolvedPython = $resolvedPython.Trim()
      if ($resolvedPython -and (Test-Path $resolvedPython)) {
        return $resolvedPython
      }
    }
  }

  $pythonCommand = Resolve-CommandPath @("python", "python3")
  if ($pythonCommand) {
    return $pythonCommand
  }

  return $null
}

function Get-RceditOverrideRoot {
  if ($env:LOCALAPPDATA) {
    return Join-Path $env:LOCALAPPDATA "BridgeGit\tools\rcedit"
  }

  return Join-Path ([System.IO.Path]::GetTempPath()) "BridgeGit\rcedit"
}

$resolvedPythonPath = Resolve-PythonPath $PythonPath

if ($resolvedPythonPath) {
  $env:PYTHON = $resolvedPythonPath
  $env:NODE_GYP_FORCE_PYTHON = $resolvedPythonPath
  Write-Output "[BridgeGit] Using Python at $resolvedPythonPath"
} else {
  Write-Warning "[BridgeGit] Python not found automatically. npm install may still work if node-gyp is already configured, otherwise rerun with -PythonPath <path>."
}

$electronBuilderCache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$rceditOverrideRoot = Get-RceditOverrideRoot
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
  Write-Error "[BridgeGit] Missing RCEdit binary at $rceditExe. Re-run after electron-builder downloads winCodeSign tools."
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
