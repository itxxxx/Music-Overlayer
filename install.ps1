<#
  Music Overlayer installer. Made by ITX.

  Run this in PowerShell (no admin needed):

    irm https://raw.githubusercontent.com/itxxxx/Music-Overlayer/main/install.ps1 | iex

  It downloads the latest Music Overlayer release from GitHub, installs it for the current user,
  offers to set up the music-only equalizer (VB-CABLE, a free virtual audio cable), and starts
  the app. Running it again updates Music Overlayer to the latest release.
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

  # VB-CABLE adds an output device named "CABLE Input".
  function Test-VirtualCable {
    $render = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\*\Properties'
    foreach ($properties in (Get-ItemProperty -Path $render -ErrorAction SilentlyContinue)) {
      if ([string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},2' -like 'CABLE Input*') { return $true }
    }
    return $null -ne (Get-ChildItem -Path (Join-Path $env:SystemRoot 'System32\drivers\vbaudio_cable*.sys') -ErrorAction SilentlyContinue | Select-Object -First 1)
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

  # 3. The music-only equalizer needs VB-CABLE
  $restartNeeded = $false
  if (Test-VirtualCable) {
    Write-Step 'VB-CABLE is already installed'
  } else {
    $answer = 'n'
    try {
      $answer = Read-Host 'Set up the music-only equalizer too? It installs VB-CABLE, a free virtual audio cable (needs admin permission and a restart) [Y/n]'
    } catch { }
    if ($answer -notmatch '^\s*(n|no)\s*$') {
      $folder = Join-Path $env:TEMP 'music-overlayer-vbcable'
      Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
      $null = New-Item -ItemType Directory -Path $folder
      try {
        Write-Step 'Downloading VB-CABLE from vb-audio.com'
        $zip = Join-Path $folder 'VBCABLE_Driver_Pack.zip'
        Invoke-WebRequest -Uri 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' -OutFile $zip -UseBasicParsing
        Expand-Archive -LiteralPath $zip -DestinationPath $folder -Force
        $cableSetup = Join-Path $folder 'VBCABLE_Setup_x64.exe'
        if (-not (Test-Path -LiteralPath $cableSetup)) { throw "the download didn't contain VB-CABLE's setup" }
        Write-Step 'Running VB-CABLE setup: allow it when Windows asks'
        Start-Process -FilePath $cableSetup -ArgumentList '-i', '-h' -Verb RunAs -Wait
        $restartNeeded = $true
      } catch {
        Write-Warning "Couldn't set up VB-CABLE ($($_.Exception.Message)). You can set it up later from the equalizer panel in $AppName."
      }
      Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
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
