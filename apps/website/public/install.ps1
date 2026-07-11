# Cardo installer for Windows.
# Fetches the latest .msi from GitHub Releases and starts the installer.
# SmartScreen may warn because the build is not code-signed yet:
# "More info" → "Run anyway". Certificates come once donations cover them.
$ErrorActionPreference = 'Stop'

$repo = 'hollatzleif/cardo-app'
$api = "https://api.github.com/repos/$repo/releases/latest"

Write-Host '→ Looking up the latest Cardo release…'
$release = Invoke-RestMethod -Uri $api
$asset = $release.assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1
if (-not $asset) { throw 'No Windows build found in the latest release.' }

$target = Join-Path $env:TEMP $asset.name
Write-Host "→ Downloading $($asset.name)…"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target

Write-Host '→ Starting the installer…'
Start-Process msiexec.exe -ArgumentList "/i `"$target`"" -Wait
Write-Host '✓ Done! Cardo is in the Start menu.'
