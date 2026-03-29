param(
  [switch]$Unsigned,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$injectedPrivateKey = $false

Push-Location $root

try {
  if ($Clean) {
    & (Join-Path $PSScriptRoot 'clean-tauri.ps1')
  }

  if ($Unsigned) {
    $unsignedBuildConfig = '{\"bundle\":{\"createUpdaterArtifacts\":false}}'
    & cargo tauri build --ci --bundles nsis --config $unsignedBuildConfig
    exit $LASTEXITCODE
  }

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
      throw 'Signed builds require TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH.'
    }

    if (-not (Test-Path $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
      throw "Signing key file not found at $env:TAURI_SIGNING_PRIVATE_KEY_PATH"
    }

    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    $injectedPrivateKey = $true
  }

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
    throw 'Signed builds require TAURI_SIGNING_PRIVATE_KEY_PASSWORD.'
  }

  & cargo tauri build --ci --bundles nsis
  exit $LASTEXITCODE
}
finally {
  if ($injectedPrivateKey) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  }

  Pop-Location
}