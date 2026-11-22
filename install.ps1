# pi-web installer for Windows — downloads the binary and sets up auto-start.
#
# Standalone (no pi required):
#   irm https://raw.githubusercontent.com/yinniora/yugo-pi/main/install.ps1 | iex
#
# Via pi package (also registers /web, /remote commands):
#   pi install npm:@yinniora/yugo-pi@beta
#
# Updates are handled by re-running the same command.
#
# Auto-start model (the Windows counterpart of install.sh's launchd/systemd
# setup, kept admin-free): a HKCU Run-key entry launches pi-web-start.vbs at
# login, which runs pi-web-start.ps1 without a console window; the .ps1 loads
# ~/.config/pi-web/env (PI_WEB_TOKEN, PATH, ...) and starts the binary hidden.
# Requires the pi CLI plus a bash for pi's shell tool (Git Bash is enough —
# see pi's docs/windows.md).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'yinniora/yugo-pi'
if ($env:PI_WEB_INSTALL_DIR) {
  $InstallDir = $env:PI_WEB_INSTALL_DIR
} else {
  # No sudo-writable /usr/local/bin equivalent on Windows; the pi agent bin
  # dir works for both npm-lifecycle and standalone installs without elevation.
  $InstallDir = Join-Path $HOME '.pi\agent\bin'
}
$Binary = Join-Path $InstallDir 'pi-web.exe'
$VersionFile = Join-Path $HOME '.pi\agent\pi-web-version'
$ConfigDir = Join-Path $HOME '.config\pi-web'
$EnvFile = Join-Path $ConfigDir 'env'
$LauncherPs1 = Join-Path $ConfigDir 'pi-web-start.ps1'
$LauncherVbs = Join-Path $ConfigDir 'pi-web-start.vbs'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Info($msg) { Write-Host "-> $msg" }

function Get-Arch {
  $arch = "$env:PROCESSOR_ARCHITECTURE"
  # An x64 PowerShell on ARM64 reports AMD64; prefer the OS architecture.
  try { $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch {}
  switch -Regex ($arch) {
    '^(ARM64|Arm64)$' { return 'arm64' }
    '^(AMD64|X64|x64)$' { return 'amd64' }
    default { throw "Unsupported architecture: $arch" }
  }
}

function Get-PackageTag {
  # When running as an npm lifecycle script, install the binary that matches
  # the npm package version so pinned installs stay pinned (see install.sh).
  if ($env:npm_package_name -eq '@yinniora/yugo-pi' -and $env:npm_package_version) {
    return 'yugo-v' + $env:npm_package_version
  }
  return $null
}

function Get-LatestTag {
  $releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=25" -MaximumRedirection 0 -TimeoutSec 30
  $versions = foreach ($release in $releases) {
    if ($release.draft -eq $false -and $release.tag_name -cmatch '^yugo-v(\d{1,7}\.\d{1,7}\.\d{1,7})(?:-([A-Za-z]+)\.(\d{1,7}))?$') {
      [PSCustomObject]@{
        Tag = $release.tag_name; Version = [version]$Matches[1]; Stable = [int](-not $Matches[2]);
        Channel = $Matches[2]; Revision = [int]$Matches[3]
      }
    }
  }
  $latest = $versions | Sort-Object Version,Stable,Channel,Revision -Descending | Select-Object -First 1
  if (-not $latest) { throw 'No published YuGo Pi release was found.' }
  return $latest.Tag
}

function Get-InstalledVersion {
  if (Test-Path $Binary) {
    try {
      $v = & $Binary -version 2>$null
      if ($v) { return "$v".Trim() }
    } catch {}
  }
  # Binary missing or not runnable (e.g. partial install); fall back to the
  # version file.
  if (Test-Path $VersionFile) { return (Get-Content $VersionFile -First 1) }
  return $null
}

function Save-ReleaseArchive([Uri]$url, $archive, [long]$size) {
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(60)
  $cancel = New-Object System.Threading.CancellationTokenSource
  $cancel.CancelAfter(300000)
  try {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      if ($url.Scheme -ne 'https' -or -not $url.IsDefaultPort -or $url.UserInfo -or
          $url.Host -notin 'github.com','release-assets.githubusercontent.com','objects.githubusercontent.com') {
        throw 'YuGo Pi installer redirected to an unexpected download host.'
      }
      $response = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
      try {
        $status = [int]$response.StatusCode
        if ($status -eq 200) {
          if ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $size) {
            throw 'YuGo Pi download failed its size check.'
          }
          $body = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
          $file = [IO.File]::Open($archive, [IO.FileMode]::CreateNew)
          try {
            $buffer = New-Object byte[] 65536
            $written = 0L
            while (($count = $body.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
              $written += $count
              if ($written -gt $size) { throw 'YuGo Pi download exceeds its published size.' }
              $file.Write($buffer, 0, $count)
            }
            if ($written -ne $size) { throw 'YuGo Pi download failed its size check.' }
          } finally {
            $file.Dispose()
            $body.Dispose()
          }
          return
        }
        if ($status -notin 301,302,303,307,308 -or -not $response.Headers.Location) { break }
        $url = [Uri]::new($url, $response.Headers.Location)
      } finally {
        $response.Dispose()
      }
    }
    throw 'Could not download the verified YuGo Pi installer.'
  } finally {
    $client.Dispose()
    $cancel.Dispose()
  }
}

function Get-Binary($arch, $tag) {
  $asset = "yugo-pi-windows-$arch.zip"
  $url = "https://github.com/$Repo/releases/download/$tag/$asset"
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/tags/$tag" -MaximumRedirection 0 -TimeoutSec 30
  $assets = @($release.assets | Where-Object { $_.name -ceq $asset })
  if ($release.draft -ne $false -or $release.tag_name -cne $tag -or $assets.Count -ne 1) {
    throw 'This YuGo Pi release does not contain the expected archive.'
  }
  $size = [long]$assets[0].size
  if ($assets[0].state -cne 'uploaded' -or $size -le 0 -or $size -gt 256MB -or
      $assets[0].digest -cnotmatch '^sha256:[a-f0-9]{64}$') {
    throw 'The YuGo Pi archive has no valid size or SHA-256 metadata.'
  }
  Info "Downloading pi-web $tag (windows-$arch)..."
  $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ('pi-web-' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  $dest = Join-Path $tmpDir 'pi-web.exe'
  $archive = Join-Path $tmpDir 'release.zip'
  try {
    Save-ReleaseArchive $url $archive $size
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -cne $assets[0].digest.Substring(7)) { throw 'YuGo Pi download failed its SHA-256 check.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
      $expected = @{'pi-web.exe' = 256MB; LICENSE = 4MB; NOTICE = 4MB; THIRD_PARTY_NOTICES = 8MB}
      foreach ($entry in $zip.Entries) {
        if ($entry.FullName -cnotin @($expected.Keys) -or $entry.Length -le 0 -or $entry.Length -gt $expected[$entry.FullName]) {
          throw 'Unexpected member in the YuGo Pi archive.'
        }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $tmpDir $entry.FullName))
        $expected.Remove($entry.FullName)
      }
      if ($expected.Count) { throw 'The YuGo Pi archive is incomplete.' }
    } finally {
      $zip.Dispose()
    }
    $legal = Join-Path $HOME '.local\share\yugo-pi\legal'
    New-Item -ItemType Directory -Force -Path $legal | Out-Null
    foreach ($name in 'LICENSE','NOTICE','THIRD_PARTY_NOTICES') {
      Copy-Item -LiteralPath (Join-Path $tmpDir $name) -Destination (Join-Path $legal $name) -Force
    }
    return $dest
  } catch {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Stop-PiWeb {
  # Stop the running instance before swapping the binary. Skipped for in-place
  # self-updates: pi-web spawned this script (via `pi install`) and restarts
  # itself afterward (see internal/app/update.go).
  Get-Process -Name 'pi-web' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

function Install-Binary($src, $tag) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # A running executable cannot be overwritten on Windows, but it can be
  # renamed: move the old binary aside, move the new one into place, then try
  # to delete the leftover (harmlessly fails while the old process still runs;
  # the next install removes it).
  $old = "$Binary.old"
  Remove-Item $old -Force -ErrorAction SilentlyContinue
  if (Test-Path $Binary) { Move-Item $Binary $old -Force }
  Move-Item $src $Binary -Force
  Remove-Item $old -Force -ErrorAction SilentlyContinue

  New-Item -ItemType Directory -Force -Path (Split-Path $VersionFile) | Out-Null
  Set-Content -Path $VersionFile -Value $tag
  Info "pi-web $tag installed to $Binary"
}

function Install-Ctl {
  if (-not $PSScriptRoot -or $env:npm_package_name -cne '@yinniora/yugo-pi') { return }
  $src = Join-Path $PSScriptRoot '.pi\skills\common\pi_web.py'
  if (-not (Test-Path $src)) { return }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $py = Join-Path $InstallDir 'pi-web-ctl.py'
  Copy-Item $src $py -Force
  $cmdPath = Join-Path $InstallDir 'pi-web-ctl.cmd'
  @"
@echo off
setlocal
where python >nul 2>nul && (
  python "%~dp0pi-web-ctl.py" %*
  exit /b %ERRORLEVEL%
)
where py >nul 2>nul && (
  py -3 "%~dp0pi-web-ctl.py" %*
  exit /b %ERRORLEVEL%
)
echo pi-web-ctl requires Python 3 >&2
exit /b 1
"@ | Set-Content -Path $cmdPath -Encoding ASCII
  Info "pi-web-ctl installed to $cmdPath"
}

function Set-EnvFileVar($file, $key, $value) {
  if ($value -match '[\r\n]') { throw 'A value in the local service environment contains a line break.' }
  $lines = @()
  if (Test-Path $file) { $lines = @(Get-Content $file) }
  $found = $false
  $lines = @($lines | ForEach-Object {
    if ($_ -match ('^' + [regex]::Escape($key) + '=')) { $found = $true; "$key=$value" } else { $_ }
  })
  if (-not $found) { $lines += "$key=$value" }
  $staged = Join-Path (Split-Path $file) ([IO.Path]::GetRandomFileName())
  try {
    New-Item -ItemType File -Path $staged | Out-Null
    Protect-EnvironmentFile $staged
    [IO.File]::WriteAllLines($staged, [string[]]$lines, [System.Text.UTF8Encoding]::new($false))
    [IO.File]::Replace($staged, $file, $null)
  } finally {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
  }
}

function Protect-EnvironmentFile($file) {
  $item = Get-Item -LiteralPath $file
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The local service environment must use a private regular file.'
  }
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $sid = [System.Security.Principal.SecurityIdentifier]
  $acl = Get-Acl -LiteralPath $file
  if ($acl.GetOwner($sid) -ne $owner) { throw 'The current user must own the local service environment.' }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($entry in $acl.GetAccessRules($true, $false, $sid)) { $acl.RemoveAccessRuleSpecific($entry) }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $file -AclObject $acl
}

function Initialize-EnvFile {
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  if (-not (Test-Path $EnvFile)) { New-Item -ItemType File -Path $EnvFile | Out-Null }
  Protect-EnvironmentFile $EnvFile

  $hasToken = Select-String -Path $EnvFile -Pattern '^PI_WEB_TOKEN=' -Quiet
  if (-not $hasToken) {
    $token = $env:PI_WEB_TOKEN
    if (-not $token) {
      $bytes = New-Object byte[] 32
      $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
      $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    }
    Set-EnvFileVar $EnvFile 'PI_WEB_TOKEN' $token
    Info "Saved the local service token in $EnvFile"
  }

  # Persist PI_CODING_AGENT_DIR so auto-started pi-web finds the right sessions.
  if ($env:PI_CODING_AGENT_DIR) { Set-EnvFileVar $EnvFile 'PI_CODING_AGENT_DIR' $env:PI_CODING_AGENT_DIR }

  # The Run-key launcher starts with the login default environment. Preserve
  # the install-time PATH so pi-web can find `pi` for browser chat.
  Set-EnvFileVar $EnvFile 'PATH' $env:Path
}

function Initialize-Autostart {
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $envPathLiteral = $EnvFile.Replace("'", "''")
  $binaryLiteral = $Binary.Replace("'", "''")

  $ps1 = @"
# Generated by pi-web install.ps1 — starts pi-web hidden with the environment
# from the env file (PI_WEB_TOKEN, PATH, ...). Regenerated on every install.
`$envFile = '$envPathLiteral'
if (Test-Path `$envFile) {
  foreach (`$line in Get-Content `$envFile) {
    if (`$line -match '^\s*#' -or `$line -notmatch '=') { continue }
    `$name, `$value = `$line -split '=', 2
    Set-Item -Path ('Env:' + `$name) -Value `$value
  }
}
Start-Process -FilePath '$binaryLiteral' -WindowStyle Hidden
"@
  Set-Content -Path $LauncherPs1 -Value $ps1

  # wscript runs the PowerShell launcher with window style 0 so login does not
  # flash a console window.
  $vbs = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""' + $LauncherPs1 + '""", 0, False'
  Set-Content -Path $LauncherVbs -Value $vbs

  Set-ItemProperty -Path $RunKey -Name 'pi-web' -Value ('wscript.exe "' + $LauncherVbs + '"')
  Info 'Windows auto-start configured (Run key + hidden launcher)'
}

function Start-PiWeb {
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $LauncherVbs + '"')
}

function Main {
  Write-Host ''
  Info 'pi-web installer (Windows)'
  Write-Host ''

  $arch = Get-Arch

  $tag = Get-PackageTag
  if ($tag) { Info "Using pi-web package version $tag." } else { $tag = Get-LatestTag }
  if ($tag -cnotmatch '^yugo-v\d{1,7}\.\d{1,7}\.\d{1,7}(?:-[A-Za-z]+\.\d{1,7})?$') { throw 'Unexpected YuGo Pi release tag.' }

  $installed = Get-InstalledVersion
  if ((Test-Path $Binary) -and ("$installed" -creplace '^yugo-v','') -ceq ($tag -creplace '^yugo-v','')) {
    Install-Ctl
    Info "Already up-to-date ($tag)."
    Write-Host ''
    return
  }
  if ($installed) { Info "Update available: $installed -> $tag" }

  $tmpBinary = Get-Binary $arch $tag

  $inplace = [bool]$env:PI_WEB_INPLACE_UPDATE
  try {
    if ((Test-Path $Binary) -and -not $inplace) { Stop-PiWeb }
    Install-Binary $tmpBinary $tag
  } finally {
    Remove-Item -LiteralPath (Split-Path $tmpBinary) -Recurse -Force -ErrorAction SilentlyContinue
  }
  Install-Ctl

  # In-place self-update: pi-web triggered this and restarts itself afterward.
  # Skip env/auto-start setup so we don't kill the npm process running this
  # script or clobber the launcher's PATH.
  if ($inplace) {
    Info "Binary updated to $tag; pi-web will restart to apply it."
    Write-Host ''
    return
  }

  Initialize-EnvFile
  Initialize-Autostart

  Info 'pi-web will listen on localhost; if Tailscale is running, it will publish HTTPS with Tailscale Serve.'
  Start-PiWeb

  Info "Done! pi-web $tag is ready."
  Write-Host ''
}

Main
