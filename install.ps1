<#
  Music Overlayer installer. Made by ITX.

  Run this in PowerShell (no admin needed):

    irm https://raw.githubusercontent.com/itxxxx/Music-Overlayer/main/install.ps1 | iex

  It downloads the latest Music Overlayer release from GitHub, installs it for the current user,
  offers to set up the equalizer engine (Equalizer APO, free), and starts the app.
  Running it again updates Music Overlayer to the latest release.
#>

& {
  # Where releases are published. Change this if you fork the project.
  $Repo = 'itxxxx/Music-Overlayer'
  $AppName = 'Music Overlayer'

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is much faster without the progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

  function Find-App {
    $default = Join-Path $env:LOCALAPPDATA "Programs\$AppName\$AppName.exe"
    if (Test-Path -LiteralPath $default) { return $default }
    $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    foreach ($entry in (Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)) {
      if ($entry.DisplayName -like "$AppName*" -and $entry.DisplayIcon) {
        $exe = ($entry.DisplayIcon -split ',')[0].Trim('"')
        if (Test-Path -LiteralPath $exe) { return $exe }
      }
    }
    return $null
  }

  function Test-EqualizerEngine {
    if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\EqualizerAPO') { return $true }
    return Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'EqualizerAPO\config\config.txt')
  }

  if (-not [Environment]::Is64BitOperatingSystem) { throw "$AppName needs 64-bit Windows 10 or 11." }

  # 1. Latest release
  Write-Step "Looking up the latest $AppName release"
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'music-overlayer-installer'; 'Accept' = 'application/vnd.github+json' }
  } catch {
    throw "Couldn't find a published release at https://github.com/$Repo/releases ($($_.Exception.Message))"
  }
  $asset = $release.assets | Where-Object { $_.name -match 'Setup.*\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw "The latest release ($($release.tag_name)) has no Windows installer attached." }

  # 2. Download and install (per user, silent)
  $setup = Join-Path $env:TEMP $asset.name
  Write-Step "Downloading $AppName $($release.tag_name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -UseBasicParsing

  Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Step "Installing $AppName"
  $process = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
  Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
  if ($process.ExitCode -ne 0) { throw "The installer stopped with exit code $($process.ExitCode)." }

  # 3. Equalizer engine
  $restartNeeded = $false
  if (Test-EqualizerEngine) {
    Write-Step 'The equalizer engine is already installed'
  } else {
    $answer = 'n'
    try {
      $answer = Read-Host 'Set up the equalizer too? It installs Equalizer APO (free, needs admin permission and a restart) [Y/n]'
    } catch { }
    if ($answer -notmatch '^\s*(n|no)\s*$') {
      Write-Step 'Downloading Equalizer APO'
      $apoSetup = Join-Path $env:TEMP 'EqualizerAPO-setup.exe'
      $sources = @(
        'https://downloads.sourceforge.net/project/equalizerapo/1.4.2/EqualizerAPO-x64-1.4.2.exe',
        'https://sourceforge.net/projects/equalizerapo/files/latest/download'
      )
      $downloaded = $false
      foreach ($source in $sources) {
        try {
          # SourceForge sends download tools straight to the file; browsers get a web page.
          Invoke-WebRequest -Uri $source -OutFile $apoSetup -UserAgent 'Wget/1.21.4' -UseBasicParsing
          $head = [System.IO.File]::ReadAllBytes($apoSetup)[0..1]
          if ($head[0] -eq 0x4D -and $head[1] -eq 0x5A) { $downloaded = $true; break }
        } catch { }
      }
      if (-not $downloaded) {
        Write-Warning "Couldn't download Equalizer APO. You can set it up later from the equalizer panel in $AppName."
      } else {
        Write-Step 'Running Equalizer APO setup: tick your speakers or headphones when it asks'
        try {
          Start-Process -FilePath $apoSetup -Verb RunAs -Wait
          $restartNeeded = $true
        } catch {
          Write-Warning "Equalizer APO setup was cancelled. You can set it up later from the equalizer panel in $AppName."
        }
        Remove-Item -LiteralPath $apoSetup -ErrorAction SilentlyContinue
      }
    }
  }

  # 4. Start the app
  $exe = Find-App
  if ($exe) {
    Write-Step "Starting $AppName"
    Start-Process -FilePath $exe
  }

  Write-Host ''
  Write-Host "$AppName $($release.tag_name) is installed. Its icon is in the system tray; right-click it for settings." -ForegroundColor Green
  if ($restartNeeded) {
    Write-Host 'Restart Windows to finish setting up the equalizer.' -ForegroundColor Yellow
  }
  Write-Host "To uninstall: Windows Settings > Apps > Installed apps > $AppName."
}
