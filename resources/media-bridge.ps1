<#
.SYNOPSIS
  Music Overlayer media bridge.

.DESCRIPTION
  Reads the media sessions Windows knows about (Global System Media Transport Controls:
  the same players that appear in the Windows volume flyout - Spotify, Deezer, browser tabs
  playing SoundCloud or YouTube Music, and so on) and lets the widget control them.

  Started and supervised by the Electron main process. Must run in Windows PowerShell 5.1
  (powershell.exe); PowerShell 7 can't load WinRT types this way.

  Output: one JSON object per line on stdout (UTF-8)
    {"t":"hello","ps":"5.1.22621.4111","os":"10.0.22631.0"}
    {"t":"ready"}
    {"t":"state","n":2,"s":{...}}                    s is null when no player has a session
    {"t":"cover","key":"...","mime":"image/jpeg","b64":"..."}   mime and b64 are null without artwork
    {"t":"ack","cmd":"next","ok":true}
    {"t":"error","message":"..."}
    {"t":"fatal","message":"..."}                   the script then exits with code 3

    {"t":"apps","ids":["Spotify.exe","Discord"]}    every app with a session, shown or not

  Input: one command per line on stdin
    toggle | play | pause | next | prev | stop | seek <ms> | shuffle <0|1> | repeat <0|1|2> | cycle | refresh
    filter <base64 of {"allow":"<regex>","block":"<regex>"}>   which apps to show (matched against app ids)
#>
param(
  [int]$PollMs = 400,
  # Same format as the "filter" command. Empty shows every app.
  [string]$Filter = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$script:writer = New-Object -TypeName System.IO.StreamWriter -ArgumentList @([Console]::OpenStandardOutput(), $utf8)
$script:writer.AutoFlush = $true
$script:reader = New-Object -TypeName System.IO.StreamReader -ArgumentList @([Console]::OpenStandardInput(), $utf8)

function Send-Line([string]$Line) {
  $script:writer.WriteLine($Line)
}

function Send-Json($Object) {
  Send-Line (ConvertTo-Json -InputObject $Object -Compress -Depth 5)
}

$script:lastError = ''
$script:lastErrorAt = [DateTime]::MinValue
function Send-Error([string]$Message) {
  $now = [DateTime]::UtcNow
  if ($Message -ne $script:lastError -or ($now - $script:lastErrorAt).TotalSeconds -gt 15) {
    $script:lastError = $Message
    $script:lastErrorAt = $now
    Send-Json ([ordered]@{ t = 'error'; message = $Message })
  }
}

if ($PSVersionTable.PSVersion.Major -ge 6) {
  Send-Json ([ordered]@{ t = 'fatal'; message = 'The media bridge needs Windows PowerShell 5.1 (powershell.exe).' })
  exit 3
}

Send-Json ([ordered]@{ t = 'hello'; ps = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.Version.ToString() })

# --- WinRT plumbing ---------------------------------------------------------------------------

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
} catch {
  Send-Json ([ordered]@{ t = 'fatal'; message = "Windows media controls aren't available on this PC: $($_.Exception.Message)" })
  exit 3
}

# WinRT async calls return IAsyncOperation<T>; convert them to .NET tasks so we can wait on them.
$script:asTaskGeneric = $null
foreach ($method in [System.WindowsRuntimeSystemExtensions].GetMethods()) {
  if ($method.Name -eq 'AsTask' -and $method.IsGenericMethodDefinition) {
    $parameters = $method.GetParameters()
    if ($parameters.Count -eq 1 -and $parameters[0].ParameterType.Name -eq 'IAsyncOperation`1') {
      $script:asTaskGeneric = $method
      break
    }
  }
}
if ($null -eq $script:asTaskGeneric) {
  Send-Json ([ordered]@{ t = 'fatal'; message = "Couldn't find WindowsRuntimeSystemExtensions.AsTask." })
  exit 3
}

$script:asTaskCache = @{}
function Wait-WinRT($Operation, [Type]$ResultType, [int]$TimeoutMs = 2500) {
  $cacheKey = $ResultType.FullName
  $asTask = $script:asTaskCache[$cacheKey]
  if ($null -eq $asTask) {
    $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
    $script:asTaskCache[$cacheKey] = $asTask
  }
  $task = $asTask.Invoke($null, @($Operation))
  if (-not $task.Wait($TimeoutMs)) {
    throw "Windows didn't answer in time ($cacheKey)."
  }
  return $task.Result
}

# --- Sessions -----------------------------------------------------------------------------------

$script:manager = $null
$script:selected = $null   # session currently shown in the widget
$script:shownId = $null    # its app id
$script:pinnedId = $null   # app id picked by hand with "cycle"
$script:allowPattern = ''  # only apps matching this are shown ('' = all)
$script:blockPattern = ''  # apps matching this are never shown
$script:lastStateJson = ''
$script:lastAppsJson = ''

function Set-Filter([string]$Encoded) {
  if (-not $Encoded) { return }
  try {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded))
    $spec = ConvertFrom-Json -InputObject $json
    $script:allowPattern = [string]$spec.allow
    $script:blockPattern = [string]$spec.block
    $script:pinnedId = $null
    $script:lastStateJson = ''
  } catch {
    Send-Error "Ignored an invalid player filter: $($_.Exception.Message)"
  }
}

function Test-Allowed([string]$AppId) {
  try {
    if ($script:blockPattern -and $AppId -match $script:blockPattern) { return $false }
    if (-not $script:allowPattern) { return $true }
    return [bool]($AppId -match $script:allowPattern)
  } catch {
    return $true
  }
}

Set-Filter $Filter

function Connect-Manager {
  $operation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  $script:manager = Wait-WinRT $operation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) 8000
  Send-Json ([ordered]@{ t = 'ready' })
}

function Get-AppId($Session) {
  try { return [string]$Session.SourceAppUserModelId } catch { return '' }
}

function Get-Status($Session) {
  try { return [int]$Session.GetPlaybackInfo().PlaybackStatus } catch { return -1 }
}

function Publish-Apps($All) {
  $ids = New-Object -TypeName System.Collections.ArrayList
  foreach ($session in $All) {
    $id = Get-AppId $session
    if ($id -and -not $ids.Contains($id)) { [void]$ids.Add($id) }
  }
  $json = ConvertTo-Json -InputObject ([ordered]@{ t = 'apps'; ids = $ids.ToArray() }) -Compress -Depth 3
  if ($json -ne $script:lastAppsJson) {
    Send-Line $json
    $script:lastAppsJson = $json
  }
}

# Sessions of the apps the widget is allowed to show (music players, browsers).
function Get-AllSessions {
  $all = New-Object -TypeName System.Collections.ArrayList
  try {
    $sessions = $script:manager.GetSessions()
    foreach ($session in $sessions) {
      if ($null -ne $session) { [void]$all.Add($session) }
    }
  } catch {
    $current = $script:manager.GetCurrentSession()
    if ($null -ne $current) { [void]$all.Add($current) }
  }
  Publish-Apps $all

  $list = New-Object -TypeName System.Collections.ArrayList
  foreach ($session in $all) {
    if (Test-Allowed (Get-AppId $session)) { [void]$list.Add($session) }
  }
  return ,$list
}

function Find-Session($List, [string]$AppId) {
  if (-not $AppId) { return $null }
  foreach ($session in $List) {
    if ((Get-AppId $session) -eq $AppId) { return $session }
  }
  return $null
}

# Which player to show: one picked by hand, else whatever is playing (preferring the one already
# shown, then the one Windows considers current), else the last one shown.
function Select-Session($List) {
  if ($List.Count -eq 0) {
    $script:pinnedId = $null
    return $null
  }

  $playing = New-Object -TypeName System.Collections.ArrayList
  foreach ($session in $List) {
    if ((Get-Status $session) -eq 4) { [void]$playing.Add($session) }
  }

  $currentId = $null
  try {
    $current = $script:manager.GetCurrentSession()
    if ($null -ne $current) { $currentId = Get-AppId $current }
  } catch { }

  if ($script:pinnedId) {
    $pinned = Find-Session $List $script:pinnedId
    if ($null -ne $pinned -and ((Get-Status $pinned) -eq 4 -or $playing.Count -eq 0)) { return $pinned }
    $script:pinnedId = $null
  }

  if ($playing.Count -gt 0) {
    $match = Find-Session $playing $script:shownId
    if ($null -ne $match) { return $match }
    $match = Find-Session $playing $currentId
    if ($null -ne $match) { return $match }
    return $playing[0]
  }

  $match = Find-Session $List $script:shownId
  if ($null -ne $match) { return $match }
  $match = Find-Session $List $currentId
  if ($null -ne $match) { return $match }
  return $List[0]
}

function Switch-Session {
  $list = Get-AllSessions
  if ($list.Count -lt 2) { return }
  $ids = @()
  foreach ($session in $list) { $ids += (Get-AppId $session) }
  $index = [Array]::IndexOf($ids, [string]$script:shownId)
  $nextId = $ids[($index + 1) % $ids.Count]
  $script:pinnedId = $nextId
  $script:shownId = $nextId
  $script:lastStateJson = ''
}

function Get-Milliseconds($TimeSpan) {
  try { return [Math]::Round($TimeSpan.TotalMilliseconds) } catch { return 0 }
}

function Read-SessionState($Session) {
  $info = $Session.GetPlaybackInfo()
  $timeline = $Session.GetTimelineProperties()

  $props = $null
  try {
    $props = Wait-WinRT ($Session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  } catch {
    Send-Error "Couldn't read track details: $($_.Exception.Message)"
  }

  $controls = $info.Controls
  $mask = 0
  if ($controls.IsPlayEnabled) { $mask = $mask -bor 1 }
  if ($controls.IsPauseEnabled) { $mask = $mask -bor 2 }
  if ($controls.IsNextEnabled) { $mask = $mask -bor 4 }
  if ($controls.IsPreviousEnabled) { $mask = $mask -bor 8 }
  if ($controls.IsPlaybackPositionEnabled) { $mask = $mask -bor 16 }
  if ($controls.IsShuffleEnabled) { $mask = $mask -bor 32 }
  if ($controls.IsRepeatEnabled) { $mask = $mask -bor 64 }
  if ($controls.IsPlayPauseToggleEnabled) { $mask = $mask -bor 128 }

  $shuffle = $null
  if ($null -ne $info.IsShuffleActive) { $shuffle = [bool]$info.IsShuffleActive }
  $repeat = $null
  if ($null -ne $info.AutoRepeatMode) { $repeat = [int]$info.AutoRepeatMode }
  $rate = 1.0
  if ($null -ne $info.PlaybackRate) { $rate = [double]$info.PlaybackRate }

  $updated = 0
  try { $updated = $timeline.LastUpdatedTime.ToUnixTimeMilliseconds() } catch { }
  $position = Get-Milliseconds $timeline.Position
  $start = Get-Milliseconds $timeline.StartTime
  $end = Get-Milliseconds $timeline.EndTime

  $app = Get-AppId $Session
  $title = ''
  $artist = ''
  $album = ''
  $albumArtist = ''
  if ($null -ne $props) {
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
    $albumArtist = [string]$props.AlbumArtist
  }
  $key = "$app|$title|$artist|$album"

  $state = [ordered]@{
    app = $app
    title = $title
    artist = $artist
    album = $album
    albumArtist = $albumArtist
    st = [int]$info.PlaybackStatus
    pos = $position
    start = $start
    end = $end
    upd = $updated
    rate = $rate
    ctl = $mask
    shuffle = $shuffle
    repeat = $repeat
    key = $key
  }
  return @{ State = $state; Props = $props; Key = $key }
}

$script:lastStateJson = ''
function Publish-State($State, [int]$Count) {
  $json = ConvertTo-Json -InputObject ([ordered]@{ t = 'state'; n = $Count; s = $State }) -Compress -Depth 5
  if ($json -ne $script:lastStateJson) {
    Send-Line $json
    $script:lastStateJson = $json
  }
}

# --- Artwork --------------------------------------------------------------------------------------

function Get-ImageMime([byte[]]$Bytes, [string]$ContentType) {
  if ($Bytes.Length -ge 12) {
    if ($Bytes[0] -eq 0x89 -and $Bytes[1] -eq 0x50 -and $Bytes[2] -eq 0x4E) { return 'image/png' }
    if ($Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xD8) { return 'image/jpeg' }
    if ($Bytes[0] -eq 0x47 -and $Bytes[1] -eq 0x49 -and $Bytes[2] -eq 0x46) { return 'image/gif' }
    if ($Bytes[0] -eq 0x42 -and $Bytes[1] -eq 0x4D) { return 'image/bmp' }
    if ($Bytes[0] -eq 0x52 -and $Bytes[1] -eq 0x49 -and $Bytes[8] -eq 0x57 -and $Bytes[9] -eq 0x45) { return 'image/webp' }
  }
  if ($ContentType -like 'image/*') { return $ContentType }
  return 'image/png'
}

function Read-ArtworkBytes($Reference) {
  # First try a WinRT DataReader, then fall back to the .NET stream bridge.
  try {
    $stream = Wait-WinRT ($Reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]) 4000
    try {
      $size = [uint32]$stream.Size
      if ($size -eq 0 -or $size -gt 16000000) { return $null }
      $dataReader = [Windows.Storage.Streams.DataReader]::new($stream)
      try {
        $null = Wait-WinRT ($dataReader.LoadAsync($size)) ([uint32]) 4000
        $buffer = New-Object -TypeName byte[] -ArgumentList $size
        $dataReader.ReadBytes($buffer)
        return @{ Bytes = $buffer; ContentType = [string]$stream.ContentType }
      } finally {
        try { $null = $dataReader.DetachStream() } catch { }
        try { $dataReader.Dispose() } catch { }
      }
    } finally {
      try { $stream.Dispose() } catch { }
    }
  } catch { }

  $stream = Wait-WinRT ($Reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]) 4000
  try {
    $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $memory = New-Object -TypeName System.IO.MemoryStream
    $netStream.CopyTo($memory)
    return @{ Bytes = $memory.ToArray(); ContentType = [string]$stream.ContentType }
  } finally {
    try { $stream.Dispose() } catch { }
  }
}

function Read-Artwork($Props) {
  if ($null -eq $Props) { return $null }
  $reference = $Props.Thumbnail
  if ($null -eq $reference) { return $null }
  $result = Read-ArtworkBytes $reference
  if ($null -eq $result -or $null -eq $result.Bytes -or $result.Bytes.Length -eq 0) { return $null }
  return @{
    Mime = (Get-ImageMime $result.Bytes $result.ContentType)
    Base64 = [Convert]::ToBase64String($result.Bytes)
  }
}

# Artwork is read when the track changes and twice more shortly after, because some players
# (Spotify among them) publish the new title before the new artwork.
$script:coverKey = $null
$script:coverSent = $null
$script:coverSchedule = New-Object -TypeName System.Collections.ArrayList

function Update-Cover($Props, [string]$Key) {
  $now = [DateTime]::UtcNow
  if ($Key -ne $script:coverKey) {
    $script:coverKey = $Key
    $script:coverSent = $null
    $script:coverSchedule.Clear()
    [void]$script:coverSchedule.Add($now)
    [void]$script:coverSchedule.Add($now.AddMilliseconds(1500))
    [void]$script:coverSchedule.Add($now.AddMilliseconds(4500))
  }
  if ($script:coverSchedule.Count -eq 0 -or $now -lt $script:coverSchedule[0]) { return }
  $script:coverSchedule.RemoveAt(0)

  $art = $null
  try { $art = Read-Artwork $Props } catch { Send-Error "Couldn't read artwork: $($_.Exception.Message)" }
  $base64 = ''
  if ($null -ne $art) { $base64 = [string]$art.Base64 }

  if ($null -ne $script:coverSent) {
    if ($base64 -eq $script:coverSent) { return }
    # Keep artwork we already sent if a later read comes back empty.
    if ($base64 -eq '') { return }
  }
  $script:coverSent = $base64

  $keyJson = ConvertTo-Json -InputObject $Key -Compress
  if ($base64 -eq '') {
    Send-Line ('{"t":"cover","key":' + $keyJson + ',"mime":null,"b64":null}')
  } else {
    Send-Line ('{"t":"cover","key":' + $keyJson + ',"mime":"' + $art.Mime + '","b64":"' + $base64 + '"}')
  }
}

function Update-Sessions {
  $list = Get-AllSessions
  $session = Select-Session $list
  $script:selected = $session
  if ($null -eq $session) {
    $script:shownId = $null
    Publish-State $null 0
    return
  }
  $script:shownId = Get-AppId $session
  $result = Read-SessionState $session
  Publish-State $result.State $list.Count
  Update-Cover $result.Props $result.Key
}

# --- Commands -------------------------------------------------------------------------------------

function Invoke-MediaCommand([string]$Line) {
  $parts = $Line.Trim() -split '\s+'
  $name = $parts[0].ToLowerInvariant()
  $argument = ''
  if ($parts.Count -gt 1) { $argument = $parts[1] }

  if ($name -eq 'refresh') {
    $script:lastStateJson = ''
    $script:coverKey = $null
    return
  }
  if ($name -eq 'cycle') {
    Switch-Session
    return
  }
  if ($name -eq 'filter') {
    Set-Filter $argument
    return
  }

  $session = $script:selected
  if ($null -eq $session) {
    Send-Json ([ordered]@{ t = 'ack'; cmd = $name; ok = $false })
    return
  }

  $operation = $null
  switch ($name) {
    'toggle' { $operation = $session.TryTogglePlayPauseAsync() }
    'play' { $operation = $session.TryPlayAsync() }
    'pause' { $operation = $session.TryPauseAsync() }
    'next' { $operation = $session.TrySkipNextAsync() }
    'prev' { $operation = $session.TrySkipPreviousAsync() }
    'stop' { $operation = $session.TryStopAsync() }
    'seek' {
      $ms = [double]::Parse($argument, [System.Globalization.CultureInfo]::InvariantCulture)
      $ticks = [long]([Math]::Max(0, $ms) * 10000)
      $operation = $session.TryChangePlaybackPositionAsync($ticks)
    }
    'shuffle' { $operation = $session.TryChangeShuffleActiveAsync(($argument -eq '1')) }
    'repeat' {
      $mode = [Windows.Media.MediaPlaybackAutoRepeatMode]([int]$argument)
      $operation = $session.TryChangeAutoRepeatModeAsync($mode)
    }
  }
  if ($null -eq $operation) {
    Send-Error "Unknown command: $name"
    return
  }
  $ok = [bool](Wait-WinRT $operation ([bool]) 3000)
  Send-Json ([ordered]@{ t = 'ack'; cmd = $name; ok = $ok })
}

# --- Main loop ------------------------------------------------------------------------------------

$pending = $script:reader.ReadLineAsync()
$nextPoll = [DateTime]::UtcNow
$failures = 0

while ($true) {
  if ($null -ne $pending) {
    $waitMs = [int][Math]::Max(0, [Math]::Min(1000, ($nextPoll - [DateTime]::UtcNow).TotalMilliseconds))
    $hasLine = $false
    try { $hasLine = $pending.Wait($waitMs) } catch { $hasLine = $true }

    if ($hasLine) {
      if ($pending.IsFaulted -or $pending.IsCanceled) {
        # Can't read commands any more; keep reporting state.
        Send-Error "Stopped reading commands."
        $pending = $null
        continue
      }
      $line = $pending.Result
      if ($null -eq $line) { break }  # stdin closed: the widget has quit
      if ($line.Trim().Length -gt 0) {
        try {
          if ($null -eq $script:manager) { Connect-Manager }
          Invoke-MediaCommand $line
        } catch {
          Send-Error "Command failed: $($_.Exception.Message)"
        }
      }
      $pending = $script:reader.ReadLineAsync()
      $nextPoll = [DateTime]::UtcNow.AddMilliseconds(150)
      continue
    }
  } else {
    $sleepMs = [int][Math]::Max(0, [Math]::Min(1000, ($nextPoll - [DateTime]::UtcNow).TotalMilliseconds))
    Start-Sleep -Milliseconds $sleepMs
  }

  if ([DateTime]::UtcNow -lt $nextPoll) { continue }

  try {
    if ($null -eq $script:manager) { Connect-Manager }
    Update-Sessions
    $failures = 0
  } catch {
    $failures++
    Send-Error "Couldn't read media sessions: $($_.Exception.Message)"
    if ($failures -ge 5) {
      $script:manager = $null
      $failures = 0
    }
  }
  $nextPoll = [DateTime]::UtcNow.AddMilliseconds($PollMs)
}

exit 0
