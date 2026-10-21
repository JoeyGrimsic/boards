# Creates a "Boards" shortcut in the Start menu (and optionally on the desktop),
# so typing "boards" in Windows search opens doodleboard.
param([switch]$Desktop, [switch]$Remove)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server.py'
$links = @(Join-Path ([Environment]::GetFolderPath('Programs')) 'Boards.lnk')
if ($Desktop -or $Remove) { $links += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Boards.lnk' }

if ($Remove) {
  foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l; Write-Host "  removed $l" } }
  exit 0
}

# Find the real Python, then the pythonw.exe beside it (pythonw = no console window).
$python = $null
foreach ($cmd in 'python', 'py') {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $c) { continue }
  try {
    $exe = & $c.Source -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { $python = $exe.Trim(); break }
  } catch { }
}
if (-not $python) {
  Write-Host ''
  Write-Host '  Python is not installed yet. Get it from https://www.python.org/downloads/'
  Write-Host '  (tick "Add python.exe to PATH"), then run this again.'
  exit 1
}
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'

$shell = New-Object -ComObject WScript.Shell
foreach ($path in $links) {
  $lnk = $shell.CreateShortcut($path)
  if (Test-Path $pythonw) {
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = "`"$server`" --app --background"
  } else {
    # no pythonw: fall back to the batch file, minimized
    $lnk.TargetPath = Join-Path $root 'start.bat'
    $lnk.WindowStyle = 7
  }
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $root 'app\icon.ico') + ',0'
  $lnk.Description = 'doodleboard - brainstorming boards'
  $lnk.Save()
  Write-Host "  created $path"
}
