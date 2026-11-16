param(
    [string]$Version = "7.0.14"
)

$ErrorActionPreference = "Stop"

# Download portable MongoDB (no admin rights required).
# Usage: npm run setup-mongo
# This script is ASCII-only on purpose: Windows PowerShell 5.1 reads
# UTF-8 without BOM as ANSI and would garble non-ASCII text.

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools\mongodb"
$mongod = Join-Path $tools "bin\mongod.exe"

if (Test-Path $mongod) {
    Write-Host "[OK] Portable MongoDB already installed: $mongod"
    Write-Host "Run: npm start"
    exit 0
}

$tmp = Join-Path $root ".tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "mongodb.zip"

if (-not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
    $url = "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-$Version.zip"
    Write-Host "Downloading MongoDB $Version (~600MB), please wait..."
    Write-Host "  $url"
    curl.exe -L --retry 3 -o $zip $url
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Download failed. Check your network, or download the zip manually into $zip"
    }
}

Write-Host "Extracting to $tools ..."
if (Test-Path $tools) {
    Remove-Item $tools -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tools | Out-Null
Expand-Archive -Path $zip -DestinationPath $tools -Force

# The archive contains one mongodb-... subfolder; move its contents up.
$inner = Get-ChildItem $tools -Directory |
    Where-Object { $_.Name -like "mongodb-*" } |
    Select-Object -First 1
if ($inner) {
    Move-Item -Path (Join-Path $inner.FullName "*") -Destination $tools -Force
    Remove-Item $inner.FullName -Recurse -Force
}

Remove-Item $zip -Force -ErrorAction SilentlyContinue

# Keep only the server binary and its DLLs; drop debug symbols and unused tools
# (mongod.pdb alone is ~1GB).
$bin = Join-Path $tools "bin"
if (Test-Path $bin) {
    Get-ChildItem $bin -File | Where-Object {
        $_.Name -notlike "mongod.exe" -and $_.Name -notlike "*.dll"
    } | Remove-Item -Force -ErrorAction SilentlyContinue
}

if (Test-Path $mongod) {
    Write-Host "[OK] MongoDB ready: $mongod"
    Write-Host "Now run: npm start  (the server starts the database automatically)"
} else {
    Write-Error "bin\mongod.exe not found after extraction"
}
