param(
  [switch]$Unsigned,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$root = Split-Path -Parent $PSScriptRoot
$defaultSigningDirectory = Join-Path $env:LOCALAPPDATA 'Stremera\signing'
$defaultPrivateKeyPath = Join-Path $defaultSigningDirectory 'tauri-updater.key'
$defaultPasswordPath = Join-Path $defaultSigningDirectory 'tauri-updater-password.txt'
$defaultPasswordDpapiPath = Join-Path $defaultSigningDirectory 'tauri-updater-password.dpapi'
$injectedPrivateKey = $false
$injectedPrivateKeyPassword = $false

function Resolve-FirstExistingPath {
  param(
    [string[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $null
}

function Read-DpapiProtectedText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $encoded = (Get-Content -Raw $Path).Trim()
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    return $null
  }

  $protectedBytes = [Convert]::FromBase64String($encoded)
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )

  return [System.Text.Encoding]::UTF8.GetString($plainBytes)
}

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
    $resolvedPrivateKeyPath = Resolve-FirstExistingPath @(
      $defaultPrivateKeyPath,
      $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    )

    if ([string]::IsNullOrWhiteSpace($resolvedPrivateKeyPath)) {
      throw "Signed builds require TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PATH, or a local key at $defaultPrivateKeyPath."
    }

    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $resolvedPrivateKeyPath
    $injectedPrivateKey = $true
  }

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
    $resolvedPasswordPath = Resolve-FirstExistingPath @(
      $defaultPasswordPath,
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH
    )
    $resolvedDpapiPasswordPath = Resolve-FirstExistingPath @(
      $defaultPasswordDpapiPath,
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_DPAPI_PATH
    )

    if (-not [string]::IsNullOrWhiteSpace($resolvedPasswordPath)) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw $resolvedPasswordPath).Trim()
      $injectedPrivateKeyPassword = $true
    }
    elseif (-not [string]::IsNullOrWhiteSpace($resolvedDpapiPasswordPath)) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-DpapiProtectedText -Path $resolvedDpapiPasswordPath
      $injectedPrivateKeyPassword = $true
    }

    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
      throw 'Signed builds require TAURI_SIGNING_PRIVATE_KEY_PASSWORD, TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH, or TAURI_SIGNING_PRIVATE_KEY_PASSWORD_DPAPI_PATH.'
    }
  }

  & cargo tauri build --ci --bundles nsis
  exit $LASTEXITCODE
}
finally {
  if ($injectedPrivateKey) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  }

  if ($injectedPrivateKeyPassword) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }

  Pop-Location
}