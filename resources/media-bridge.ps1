<#
.SYNOPSIS
  Music Overlayer media bridge.

.DESCRIPTION
  Reads the media sessions Windows knows about (Global System Media Transport Controls:
  the same players that appear in the Windows volume flyout - Spotify, Deezer, browser tabs
  playing SoundCloud or YouTube Music, and so on) and lets the widget control them.

  Started and supervised by the Electron main process. Must run in Windows PowerShell 5.1
  (powershell.exe); PowerShell 7 can't load WinRT types this way.

  media-native.cs (next to this script) reads the per-app volume, finds VB-CABLE and sends the
  shown player's sound through it (for the music-only equalizer). It's compiled the first time
  and kept in %LOCALAPPDATA%\Music Overlayer\native. Without it the bridge still works, minus
  those.

  Output: one JSON object per line on stdout (UTF-8)
    {"t":"hello","ps":"5.1.22621.4111","os":"10.0.22631.0"}
    {"t":"native","ok":true}                          or ok false with a message
    {"t":"ready"}
    {"t":"state","n":2,"s":{...}}                    s is null when no player has a session
                                                      s.vol is 0-1 and s.mute true/false, or both null
                                                      when the player's volume can't be found
    {"t":"cover","key":"...","mime":"image/jpeg","b64":"..."}   mime and b64 are null without
                                                      artwork, and "why" says what happened
    {"t":"cable","id":"{0.0.0.00000000}.{...}","routing":true,"bits":24}   VB-CABLE's "CABLE Input", or id
                                                      null; bits: the cable's sample size, 0 if unknown.
                                                      Sent at start, on "cable", and when it changes
    {"t":"routed","app":"Spotify.exe","n":1}        the app's sound now goes to the cable (n processes)
    {"t":"unrouted","app":"Spotify.exe","n":1}      back to the default device ("exited" when it quit)
    {"t":"ack","cmd":"next","ok":true}
    {"t":"error","message":"..."}
    {"t":"fatal","message":"..."}                   the script then exits with code 3

    {"t":"apps","ids":["Spotify.exe","Discord"]}    every app with a session, shown or not
    {"t":"usage","cpuMs":1234,"memKb":45678}        every 5 s: this process's CPU time so far and private memory

  Input: one command per line on stdin
    toggle | play | pause | next | prev | stop | seek <ms> | shuffle <0|1> | repeat <0|1|2>
    volume <0-1> | mute <0|1>                       the shown player's volume-mixer level
    volume <0-1> <base64 app id>                    the same for a given player
    cable                                           look for VB-CABLE again
    route <endpoint id>                             send the shown player's sound to that device
    unroute <base64 app id> | unroute *             send it (or everything routed) back to the default
    cycle | refresh
    filter <base64 of {"allow":"<regex>","block":"<regex>"}>   which apps to show (matched against app ids)

  Run it by hand with -Diagnose to print what it can read, then exit.
#>
param(
  # How often to read the sessions while something plays, and while nothing does.
  [int]$PollMs = 500,
  [int]$IdlePollMs = 1500,
  # Same format as the "filter" command. Empty shows every app.
  [string]$Filter = '',
  [switch]$Diagnose
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

$script:lastUsageAt = [DateTime]::MinValue
function Send-Usage {
  $script:lastUsageAt = [DateTime]::UtcNow
  try {
    $self = [System.Diagnostics.Process]::GetCurrentProcess()
    $self.Refresh()
    Send-Json ([ordered]@{ t = 'usage'; cpuMs = [long]$self.TotalProcessorTime.TotalMilliseconds; memKb = [long]($self.PrivateMemorySize64 / 1024) })
  } catch {
    Send-Json ([ordered]@{ t = 'usage' })
  }
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

if (-not $Diagnose) {
  Send-Json ([ordered]@{ t = 'hello'; ps = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.Version.ToString() })
}

# --- WinRT plumbing ---------------------------------------------------------------------------

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IContentTypeProvider, Windows.Storage.Streams, ContentType = WindowsRuntime]
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

# --- Native helper ------------------------------------------------------------------------------

$script:native = $false
$script:nativeError = ''
$script:nativeFrom = ''    # 'cache', 'compiled' or 'memory'
$script:nativeMs = 0

# Compiling takes a second or two, so the result is kept, named after the source's hash.
function Initialize-Native {
  if ($null -ne ('MusicOverlayer.AudioApps' -as [type])) {
    $script:native = $true
    return
  }
  $source = Join-Path -Path $PSScriptRoot -ChildPath 'media-native.cs'
  if (-not (Test-Path -LiteralPath $source)) {
    $script:nativeError = 'media-native.cs is missing next to the bridge script.'
    return
  }
  $code = [System.IO.File]::ReadAllText($source)
  $cached = $null
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $script:nativeFrom = 'cache'
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($code))).Replace('-', '').Substring(0, 16)
    $folder = Join-Path -Path ([Environment]::GetFolderPath('LocalApplicationData')) -ChildPath 'Music Overlayer\native'
    $cached = Join-Path -Path $folder -ChildPath "media-native-$hash.dll"
    if (-not (Test-Path -LiteralPath $cached)) {
      $null = New-Item -ItemType Directory -Force -Path $folder
      # Copies from older versions of the app aren't needed any more.
      Get-ChildItem -LiteralPath $folder -Filter 'media-native-*.dll' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
      $script:nativeFrom = 'compiled'
      Add-Type -TypeDefinition $code -Language CSharp -OutputAssembly $cached -OutputType Library -IgnoreWarnings
    }
    if ($null -eq ('MusicOverlayer.AudioApps' -as [type])) { Add-Type -LiteralPath $cached }
  } catch {
    $script:nativeError = $_.Exception.Message
    # A damaged copy would fail the same way next time; remove it so it gets rebuilt.
    if ($cached -and $null -eq ('MusicOverlayer.AudioApps' -as [type])) {
      Remove-Item -LiteralPath $cached -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -eq ('MusicOverlayer.AudioApps' -as [type])) {
    # No usable copy on disk (blocked folder, half-written file...): compile in memory instead.
    $script:nativeFrom = 'memory'
    try {
      Add-Type -TypeDefinition $code -Language CSharp -IgnoreWarnings
    } catch {
      $script:nativeError = "Couldn't compile media-native.cs: $($_.Exception.Message)"
    }
  }
  $script:native = $null -ne ('MusicOverlayer.AudioApps' -as [type])
  if ($script:native) { $script:nativeError = '' }
  $script:nativeMs = [int]$clock.ElapsedMilliseconds
}

Initialize-Native
if (-not $Diagnose) {
  if ($script:native) { Send-Json ([ordered]@{ t = 'native'; ok = $true; from = $script:nativeFrom; ms = $script:nativeMs }) }
  else { Send-Json ([ordered]@{ t = 'native'; ok = $false; message = $script:nativeError; ms = $script:nativeMs }) }
}

# --- Sessions -----------------------------------------------------------------------------------

$script:manager = $null
$script:selected = $null   # session currently shown in the widget
$script:shownId = $null    # its app id
$script:shownSession = $null  # the session shown last (kept while a browser is between songs)
$script:shownTitle = ''       # its title: tabs of one browser share an app id, titles tell them apart
$script:shownStatus = -1   # its playback status (4 = playing)
$script:pinnedId = $null   # app id picked by hand with "cycle"
$script:allowPattern = ''  # only apps matching this are shown ('' = all)
$script:blockPattern = ''  # apps matching this are never shown
$script:lastStateJson = ''
$script:lastAppsJson = ''
$script:pinnedAt = [DateTime]::MinValue    # when it was picked
$script:startedAt = @{}    # app id -> when it last started playing
$script:lastPlayed = @{}   # app id -> when it was last seen playing
$script:wasPlaying = @{}   # app ids playing at the previous check
$script:holding = $false   # set by Select-Session: keep showing what's shown
# Browsers pause or drop their media session for a moment between songs. A player that was just
# playing keeps being shown for this long while its session is gone.
$script:holdMs = 15000

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
  if (-not $Diagnose) { Send-Json ([ordered]@{ t = 'ready' }) }
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

function Get-EverySession {
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
  return ,$all
}

# Sessions of the apps the widget is allowed to show (music players, browsers).
function Get-AllSessions {
  $all = Get-EverySession
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

function Get-Title($Session) {
  try {
    $props = Wait-WinRT ($Session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1500
    if ($null -ne $props) { return [string]$props.Title }
  } catch { }
  return ''
}

# The shown session in $List. Tabs of one browser share an app id (two Opera tabs are both
# "Opera"), so it's the same session object if Windows hands that back, else the one of the same
# app with the same title. With $Strict, a lone session of that app with another title counts as
# another tab, not as the shown one.
function Find-Shown($List, [bool]$Strict) {
  $id = [string]$script:shownId
  if (-not $id) { return $null }
  $same = New-Object -TypeName System.Collections.ArrayList
  foreach ($session in $List) {
    if ((Get-AppId $session) -eq $id) { [void]$same.Add($session) }
  }
  if ($same.Count -eq 0) { return $null }
  foreach ($session in $same) {
    if ([object]::ReferenceEquals($session, $script:shownSession)) { return $session }
  }
  if ($same.Count -eq 1 -and -not $Strict) { return $same[0] }
  foreach ($session in $same) {
    if ((Get-Title $session) -eq $script:shownTitle) { return $session }
  }
  if ($Strict) { return $null }
  return $same[0]
}

function Get-Time([hashtable]$Map, [string]$AppId) {
  if ($AppId -and $Map.ContainsKey($AppId)) { return [DateTime]$Map[$AppId] }
  return [DateTime]::MinValue
}

# The playing session whose player started most recently after $Since, other than $ExceptId.
function Get-StartedAfter($Playing, [DateTime]$Since, [string]$ExceptId) {
  $best = $null
  $bestAt = $Since
  foreach ($session in $Playing) {
    $id = Get-AppId $session
    if ($id -eq $ExceptId) { continue }
    $at = Get-Time $script:startedAt $id
    if ($at -gt $bestAt) {
      $best = $session
      $bestAt = $at
    }
  }
  return $best
}

# Which player to show. The shown player stays until a different player is started after it
# stopped (or after it was picked by hand). Another app that was already playing doesn't take
# over: Spotify can report "playing" while it plays on another device, and a browser pauses or
# drops its session between two songs. With nothing shown, show what plays, preferring the
# player Windows considers current.
function Select-Session($List) {
  $now = [DateTime]::UtcNow
  $script:holding = $false

  $playing = New-Object -TypeName System.Collections.ArrayList
  $nowPlaying = @{}
  foreach ($session in $List) {
    if ((Get-Status $session) -ne 4) { continue }
    $id = Get-AppId $session
    [void]$playing.Add($session)
    $nowPlaying[$id] = $true
    if (-not $script:wasPlaying.ContainsKey($id)) { $script:startedAt[$id] = $now }
    $script:lastPlayed[$id] = $now
  }
  $script:wasPlaying = $nowPlaying

  $shownId = [string]$script:shownId
  if ($shownId) {
    $shown = Find-Shown $List $true
    if ($null -ne $shown -and (Get-Status $shown) -eq 4) {
      # Picked by hand and now playing: the usual rules apply again.
      if ($shownId -eq $script:pinnedId) { $script:pinnedId = $null }
      return $shown
    }
    $playedAt = Get-Time $script:lastPlayed $shownId
    # A second of slack: a player started just before this one was paused still counts.
    $since = $playedAt
    if ($since -gt [DateTime]::MinValue) { $since = $since.AddSeconds(-1) }
    if ($shownId -eq $script:pinnedId -and $script:pinnedAt -gt $since) { $since = $script:pinnedAt }
    $started = Get-StartedAfter $playing $since $shownId
    if ($null -ne $started) { return $started }
    # Another tab of the same browser plays: show that tab, unless this one was picked by hand.
    if ($nowPlaying.ContainsKey($shownId) -and $shownId -ne $script:pinnedId) {
      foreach ($session in $playing) {
        if ((Get-AppId $session) -eq $shownId -and -not [object]::ReferenceEquals($session, $shown)) { return $session }
      }
    }
    if ($null -ne $shown) { return $shown }
    # Gone right after playing: most likely between two songs.
    if ((Test-Allowed $shownId) -and ($now - $playedAt).TotalMilliseconds -le $script:holdMs) {
      $script:holding = $true
      return $null
    }
  }

  if ($List.Count -eq 0) { return $null }

  $currentId = $null
  try {
    $current = $script:manager.GetCurrentSession()
    if ($null -ne $current) { $currentId = Get-AppId $current }
  } catch { }

  if ($playing.Count -gt 0) {
    $match = Find-Session $playing $currentId
    if ($null -ne $match) { return $match }
    $match = Get-StartedAfter $playing ([DateTime]::MinValue) ''
    if ($null -ne $match) { return $match }
    return $playing[0]
  }

  # Nothing plays: the player that played last, else the one Windows considers current.
  $best = $null
  $bestAt = [DateTime]::MinValue
  foreach ($session in $List) {
    $at = Get-Time $script:lastPlayed (Get-AppId $session)
    if ($at -gt $bestAt) {
      $best = $session
      $bestAt = $at
    }
  }
  if ($null -ne $best) { return $best }
  $match = Find-Session $List $currentId
  if ($null -ne $match) { return $match }
  return $List[0]
}

# Shows the next session (by hand). Goes session by session, so two tabs of one browser can
# be picked too.
function Switch-Session {
  $list = Get-AllSessions
  if ($list.Count -lt 2) { return }
  # Where the shown session is: same app and title, else just the same app.
  $titles = @()
  foreach ($session in $list) { $titles += (Get-Title $session) }
  $index = -1
  for ($i = 0; $i -lt $list.Count -and $index -lt 0; $i++) {
    if ((Get-AppId $list[$i]) -eq $script:shownId -and $titles[$i] -eq $script:shownTitle) { $index = $i }
  }
  for ($i = 0; $i -lt $list.Count -and $index -lt 0; $i++) {
    if ((Get-AppId $list[$i]) -eq $script:shownId) { $index = $i }
  }
  $nextIndex = ($index + 1) % $list.Count
  $next = $list[$nextIndex]
  $script:shownId = Get-AppId $next
  $script:shownSession = $next
  $script:shownTitle = $titles[$nextIndex]
  $script:pinnedId = $script:shownId
  $script:pinnedAt = [DateTime]::UtcNow
  $script:lastStateJson = ''
}

function Get-Milliseconds($TimeSpan) {
  try { return [Math]::Round($TimeSpan.TotalMilliseconds) } catch { return 0 }
}

function Get-Controls($Info) {
  $controls = $Info.Controls
  $mask = 0
  if ($controls.IsPlayEnabled) { $mask = $mask -bor 1 }
  if ($controls.IsPauseEnabled) { $mask = $mask -bor 2 }
  if ($controls.IsNextEnabled) { $mask = $mask -bor 4 }
  if ($controls.IsPreviousEnabled) { $mask = $mask -bor 8 }
  if ($controls.IsPlaybackPositionEnabled) { $mask = $mask -bor 16 }
  if ($controls.IsShuffleEnabled) { $mask = $mask -bor 32 }
  if ($controls.IsRepeatEnabled) { $mask = $mask -bor 64 }
  if ($controls.IsPlayPauseToggleEnabled) { $mask = $mask -bor 128 }
  return $mask
}

# The volume-mixer level of the app behind a session, or $null.
function Get-AppVolume([string]$AppId) {
  if (-not $script:native -or -not $AppId) { return $null }
  try {
    $volume = [MusicOverlayer.AudioApps]::Get($AppId)
    if ($volume.Found) { return $volume }
  } catch {
    Send-Error "Couldn't read the player's volume: $($_.Exception.Message)"
  }
  return $null
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

  $level = $null
  $muted = $null
  $volume = Get-AppVolume $app
  if ($null -ne $volume) {
    $level = [double]$volume.Level
    $muted = [bool]$volume.Muted
  }

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
    ctl = (Get-Controls $info)
    shuffle = $shuffle
    repeat = $repeat
    vol = $level
    mute = $muted
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

function Get-ImageMime([byte[]]$Bytes) {
  if ($null -eq $Bytes -or $Bytes.Length -lt 12) { return $null }
  if ($Bytes[0] -eq 0x89 -and $Bytes[1] -eq 0x50 -and $Bytes[2] -eq 0x4E -and $Bytes[3] -eq 0x47) { return 'image/png' }
  if ($Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xD8 -and $Bytes[2] -eq 0xFF) { return 'image/jpeg' }
  if ($Bytes[0] -eq 0x47 -and $Bytes[1] -eq 0x49 -and $Bytes[2] -eq 0x46) { return 'image/gif' }
  if ($Bytes[0] -eq 0x42 -and $Bytes[1] -eq 0x4D) { return 'image/bmp' }
  if ($Bytes[0] -eq 0x52 -and $Bytes[1] -eq 0x49 -and $Bytes[2] -eq 0x46 -and $Bytes[3] -eq 0x46 -and
      $Bytes[8] -eq 0x57 -and $Bytes[9] -eq 0x45 -and $Bytes[10] -eq 0x42 -and $Bytes[11] -eq 0x50) { return 'image/webp' }
  return $null
}

# Players hand over streams PowerShell often can't see into (a bare System.__ComObject: Size
# reads as $null and AsStreamForRead finds no overload). Going through the WinRT interface types
# by reflection works whatever the stream's class is.
$script:streamSize = [Windows.Storage.Streams.IRandomAccessStream].GetProperty('Size')
$script:asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$script:closeStream = [System.IDisposable].GetMethod('Dispose')
$script:maxArtworkBytes = 16000000

# Returns a hashtable with Mime, Base64 and Length, or with Why when there's no artwork.
function Read-Artwork($Props) {
  if ($null -eq $Props) { return @{ Why = "the track details couldn't be read" } }
  $reference = $null
  try { $reference = $Props.Thumbnail } catch { }
  if ($null -eq $reference) { return @{ Why = 'the player shares no artwork' } }

  $stream = Wait-WinRT ($reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]) 4000
  $bytes = $null
  try {
    $size = 0
    try { $size = [uint64]$script:streamSize.GetValue($stream) } catch { }
    if ($size -gt $script:maxArtworkBytes) { return @{ Why = "the artwork is too large ($size bytes)" } }
    $netStream = $script:asStreamForRead.Invoke($null, @($stream))
    try {
      $memory = New-Object -TypeName System.IO.MemoryStream
      $netStream.CopyTo($memory)
      $bytes = $memory.ToArray()
    } finally {
      try { $netStream.Dispose() } catch { }
    }
  } finally {
    try { $null = $script:closeStream.Invoke($stream, $null) } catch { }
  }

  $mime = Get-ImageMime $bytes
  if ($null -eq $mime) {
    $length = 0
    if ($null -ne $bytes) { $length = $bytes.Length }
    return @{ Why = "the artwork didn't read as an image ($length bytes)" }
  }
  return @{ Mime = $mime; Base64 = [Convert]::ToBase64String($bytes); Length = $bytes.Length }
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
  try { $art = Read-Artwork $Props } catch { $art = @{ Why = $_.Exception.Message } }
  $base64 = ''
  if ($null -ne $art.Base64) { $base64 = [string]$art.Base64 }

  if ($null -ne $script:coverSent) {
    if ($base64 -eq $script:coverSent) { return }
    # Keep artwork we already sent if a later read comes back empty.
    if ($base64 -eq '') { return }
  }
  $script:coverSent = $base64

  $keyJson = ConvertTo-Json -InputObject $Key -Compress
  if ($base64 -eq '') {
    $whyJson = ConvertTo-Json -InputObject ([string]$art.Why) -Compress
    Send-Line ('{"t":"cover","key":' + $keyJson + ',"mime":null,"b64":null,"why":' + $whyJson + '}')
  } else {
    Send-Line ('{"t":"cover","key":' + $keyJson + ',"mime":"' + $art.Mime + '","b64":"' + $base64 + '"}')
  }
}

function Update-Sessions {
  $list = Get-AllSessions
  $session = Select-Session $list
  if ($script:holding) {
    # The shown player is between two songs: leave the widget as it is for now.
    $script:selected = $null
    return
  }

  $script:selected = $session
  if ($null -eq $session) {
    $script:shownId = $null
    $script:shownSession = $null
    $script:shownTitle = ''
    $script:shownStatus = -1
    Publish-State $null 0
    return
  }
  $id = Get-AppId $session
  if ($id -ne $script:pinnedId) { $script:pinnedId = $null }
  $script:shownId = $id
  $script:shownSession = $session
  $result = Read-SessionState $session
  $script:shownTitle = [string]$result.State.title
  $script:shownStatus = [int]$result.State.st
  Publish-State $result.State $list.Count
  Update-Cover $result.Props $result.Key
}

# --- Music-only equalizer: VB-CABLE routing --------------------------------------------------------

$script:lastCableJson = ''
$script:cableCheckedAt = [DateTime]::MinValue
# -IfChanged: only when something changed since the last report (the 10-second re-check, which
# notices VB-CABLE installed, removed or switched between 16 and 24 bit in Sound settings).
function Send-CableStatus([switch]$IfChanged) {
  $script:cableCheckedAt = [DateTime]::UtcNow
  $id = $null
  $routing = $false
  $bits = 0
  $why = ''
  if ($script:native) {
    try { $id = [MusicOverlayer.AudioDevices]::FindCableInput() } catch { $why = $_.Exception.Message }
    try { $routing = [MusicOverlayer.AudioRouting]::Available } catch { $why = $_.Exception.Message }
    if (-not $routing -and -not $why) { $why = [string][MusicOverlayer.AudioRouting]::LastError }
    if ($id) {
      try { $bits = [MusicOverlayer.AudioDevices]::CableBits() } catch { $bits = 0 }
    }
  } else {
    $why = $script:nativeError
  }
  $json = ConvertTo-Json -InputObject ([ordered]@{ t = 'cable'; id = $id; routing = $routing; bits = $bits; why = $why }) -Compress -Depth 5
  if ($IfChanged -and $json -eq $script:lastCableJson) { return }
  $script:lastCableJson = $json
  Send-Line $json
}
if (-not $Diagnose) { Send-CableStatus }

function Send-Routed([string]$Type, [string]$AppId, [int]$Count, [string]$Why = '', [bool]$Exited = $false) {
  $message = [ordered]@{ t = $Type; app = $AppId; n = $Count }
  if ($Why) { $message.why = $Why }
  if ($Exited) { $message.exited = $true }
  Send-Json $message
}

# A routed player that quits gets its route undone right away (see AudioRouting.TakeExited).
function Update-Routes {
  if (-not $script:native) { return }
  foreach ($app in [MusicOverlayer.AudioRouting]::TakeExited()) { Send-Routed 'unrouted' $app 1 '' $true }
}

# --- Commands -------------------------------------------------------------------------------------

function Send-Ack([string]$Name, [bool]$Ok) {
  Send-Json ([ordered]@{ t = 'ack'; cmd = $Name; ok = $Ok })
}

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
  if ($name -eq 'cable') {
    Send-CableStatus
    return
  }
  if ($name -eq 'route') {
    $count = 0
    $why = ''
    if (-not $script:native) { $why = $script:nativeError }
    elseif (-not $script:shownId) { $why = 'no player is shown' }
    else {
      $count = [MusicOverlayer.AudioRouting]::Route($script:shownId, $argument)
      # Its sound now starts a new session on the cable: look for it often for a few seconds.
      [MusicOverlayer.AudioApps]::RefreshSoon(4000)
      if ($count -eq 0) { $why = [string][MusicOverlayer.AudioRouting]::LastError }
      if ($count -eq 0 -and -not $why) { $why = "the player isn't playing through any output device yet" }
    }
    Send-Routed 'routed' ([string]$script:shownId) $count $why
    return
  }
  if ($name -eq 'unroute') {
    if (-not $script:native) { return }
    [MusicOverlayer.AudioApps]::RefreshSoon(4000)
    if ($argument -eq '*') {
      Send-Routed 'unrouted' '*' ([MusicOverlayer.AudioRouting]::UnrouteAll())
      return
    }
    $app = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($argument))
    Send-Routed 'unrouted' $app ([MusicOverlayer.AudioRouting]::Unroute($app))
    return
  }
  if ($name -eq 'volume' -or $name -eq 'mute') {
    # The volume-mixer level of the shown player, through the native helper. "volume <level>
    # <base64 app id>" sets a given player's instead (the overlay turning one down on the cable,
    # or back up): every session it has, read fresh, since moving it to the cable starts a new one.
    $ok = $false
    $target = [string]$script:shownId
    $named = $false
    if ($name -eq 'volume' -and $parts.Count -gt 2 -and $parts[2]) {
      $target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
      $named = $true
    }
    if ($script:native -and $target) {
      if ($name -eq 'volume') {
        $level = [double]::Parse($argument, [System.Globalization.CultureInfo]::InvariantCulture)
        $ok = [MusicOverlayer.AudioApps]::SetLevel($target, $level, $named) -gt 0
      } else {
        $ok = [MusicOverlayer.AudioApps]::SetMuted($script:shownId, ($argument -eq '1')) -gt 0
      }
    }
    $script:lastStateJson = ''
    Send-Ack $name $ok
    return
  }

  $session = $script:selected
  if ($null -eq $session) {
    Send-Ack $name $false
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
  Send-Ack $name $ok
}

# --- Diagnostics ----------------------------------------------------------------------------------

function Invoke-Diagnose {
  Send-Line 'Music Overlayer media bridge diagnostics'
  Send-Line "Windows PowerShell $($PSVersionTable.PSVersion) on Windows $([Environment]::OSVersion.Version)"
  if ($script:native) { Send-Line "Native helper: loaded ($($script:nativeFrom), $($script:nativeMs) ms)" }
  else { Send-Line "Native helper: NOT loaded after $($script:nativeMs) ms. $($script:nativeError)" }
  try {
    Connect-Manager
  } catch {
    Send-Line "Media sessions: can't connect. $($_.Exception.Message)"
    return
  }

  $all = Get-EverySession
  $current = ''
  try { $current = Get-AppId $script:manager.GetCurrentSession() } catch { }
  Send-Line ''
  Send-Line "Media sessions: $($all.Count) (Windows' current one: $current)"
  $statusNames = @('closed', 'opened', 'changing', 'stopped', 'playing', 'paused')
  $repeatNames = @('none', 'track', 'list')
  foreach ($session in $all) {
    $app = Get-AppId $session
    try {
      $result = Read-SessionState $session
      $state = $result.State
      $status = "status $($state.st)"
      if ($state.st -ge 0 -and $state.st -lt $statusNames.Count) { $status = $statusNames[$state.st] }
      Send-Line ''
      Send-Line "  $app"
      Send-Line "    track: '$($state.title)' by '$($state.artist)' on '$($state.album)', $status"
      Send-Line "    timeline: $([Math]::Round($state.pos / 1000))s of $([Math]::Round(($state.end - $state.start) / 1000))s"
      $names = @()
      $labels = @('play', 'pause', 'next', 'previous', 'seek', 'shuffle', 'repeat', 'play/pause')
      for ($bit = 0; $bit -lt $labels.Count; $bit++) { if ($state.ctl -band (1 -shl $bit)) { $names += $labels[$bit] } }
      Send-Line "    controls it allows: $($names -join ', ')"
      $shuffle = 'not reported'
      if ($null -ne $state.shuffle) { if ($state.shuffle) { $shuffle = 'on' } else { $shuffle = 'off' } }
      $repeat = 'not reported'
      if ($null -ne $state.repeat) { $repeat = $repeatNames[[int]$state.repeat] }
      Send-Line "    shuffle: $shuffle, repeat: $repeat"
      $art = $null
      try { $art = Read-Artwork $result.Props } catch { $art = @{ Why = $_.Exception.Message } }
      if ($null -ne $art.Base64) { Send-Line "    artwork: $($art.Length) bytes, $($art.Mime)" }
      else { Send-Line "    artwork: none. $($art.Why)" }
      if ($script:native) {
        $volume = [MusicOverlayer.AudioApps]::Get($app)
        if ($volume.Found) { Send-Line "    volume: $([Math]::Round($volume.Level * 100))%$(if ($volume.Muted) { ', muted' }) (processes: $($volume.Processes))" }
        else { Send-Line "    volume: no audio session found for this app" }
      }
      if (-not (Test-Allowed $app)) { Send-Line '    (hidden by the player filter)' }
    } catch {
      Send-Line "  $app : couldn't read it. $($_.Exception.Message)"
    }
  }

  if ($script:native) {
    Send-Line ''
    Send-Line 'Apps using audio:'
    $script:writer.Write([MusicOverlayer.AudioApps]::Describe())
    if ([MusicOverlayer.AudioApps]::LastError) { Send-Line "  error: $([MusicOverlayer.AudioApps]::LastError)" }

    Send-Line ''
    Send-Line 'Output devices:'
    foreach ($output in [MusicOverlayer.AudioDevices]::Outputs()) { Send-Line "  $($output.Value)  $($output.Key)" }
    $cable = [MusicOverlayer.AudioDevices]::FindCableInput()
    if ($cable) { Send-Line "VB-CABLE: found ($cable), $([MusicOverlayer.AudioDevices]::CableBits()) bit" } else { Send-Line 'VB-CABLE: not found' }
    if ([MusicOverlayer.AudioRouting]::Available) { Send-Line "Per-app routing: available ($([MusicOverlayer.AudioRouting]::Variant) interface)" }
    else { Send-Line "Per-app routing: NOT available. $([MusicOverlayer.AudioRouting]::LastError)" }
  }
}

if ($Diagnose) {
  Invoke-Diagnose
  exit 0
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
      if ($null -eq $line) { break }  # stdin closed: the widget has quit (or crashed)
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
  try { Update-Routes } catch { Send-Error "Couldn't check routed players: $($_.Exception.Message)" }
  # Every 5 s: this process's own CPU and memory, for the overlay's usage total. It also tells
  # the widget the bridge is alive (it restarts a bridge that goes quiet for too long).
  if (([DateTime]::UtcNow - $script:lastUsageAt).TotalSeconds -ge 5) { Send-Usage }
  if ($script:native -and ([DateTime]::UtcNow - $script:cableCheckedAt).TotalSeconds -ge 10) {
    try { Send-CableStatus -IfChanged } catch { Send-Error "Couldn't check VB-CABLE: $($_.Exception.Message)" }
  }

  # Read often while music plays; when it doesn't, nothing moves, so read less.
  $interval = $IdlePollMs
  if ($script:shownStatus -eq 4) { $interval = $PollMs }
  $nextPoll = [DateTime]::UtcNow.AddMilliseconds($interval)
}

# Whatever happened to the widget, the music goes back to the normal output device.
if ($script:native) {
  try { $null = [MusicOverlayer.AudioRouting]::UnrouteAll() } catch { }
}
exit 0
