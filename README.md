# Music Overlayer

**Made by ITX**

A small always-on-top now-playing overlay for Windows, with a built-in 10-band equalizer. It only follows music: Spotify, Deezer, TIDAL, Apple Music and other music apps, plus browser tabs (SoundCloud, YouTube Music, Deezer and Spotify Web). Discord, games and other apps are ignored.

## Install

Open **PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/itxxxx/Music-Overlayer/main/install.ps1 | iex
```

This installs Music Overlayer for your account (no admin needed), offers to set up the equalizer and starts the app. Run the same command again to update.

To uninstall, go to Windows Settings → Apps → Installed apps → Music Overlayer.

Music Overlayer needs 64-bit Windows 10 or 11.

## What's new in 1.1.0

- **Music-only equalizer.** The equalizer can now change just the player the overlay shows. Discord, games and everything else sound exactly as before. It's the new default, and the old behaviour is still there as **Everything**. See [The equalizer](#the-equalizer).
- **Volume slider.** Change the player's own volume right from the card.
- **More reliable covers.** Artwork shows up more often, and an optional online lookup finds covers that some players don't share.
- **Clearer shuffle and repeat.** The buttons light up when they're on, and repeat one shows a small 1.
- **Lighter on your PC.** The overlay uses less CPU and memory.

To update, run the install command again.

## What it does

- **Pill:** shows the artwork, title, artist and live bars. After 4 seconds on its own it fades to 75% opacity.
- **Card:** move the pointer over the pill and it comes back to full opacity. Rest there for 0.3 s and it opens into the card, with the cover art, a timeline you can drag to seek, previous/play-pause/next, and shuffle/repeat when the player supports them. Shuffle and repeat light up when they're on; repeat one shows a small 1.
- **Volume:** the slider under the controls changes the player's own volume, not your whole PC's. It's the same level as the player's slider in the Windows volume mixer. For a browser tab it changes the whole browser, because Windows has no volume per tab.
- **Equalizer:** 10 bands, presets, your own saved presets and a preamp. By default it changes only the music player the overlay shows. Open it with the sliders button on the cover.
- **Colours:** the overlay picks its colours from the current album art.
- **Always on top:** it stays above other windows without taking focus. Clicks pass through everywhere except the overlay itself.

| To do this | Do this |
| --- | --- |
| Open the card | Rest the pointer on the pill for 0.3 s, or click it |
| Seek | Click or drag the timeline |
| Change the player's volume | Drag the volume slider, or scroll over it. Click the speaker to mute. |
| Switch player | Click the player name on the cover. It only works when more than one music app is playing. |
| Move the overlay | Drag it. The position is remembered. |
| Settings, hide, quit | Right-click the overlay, or use the tray icon |

## Music only

Music Overlayer shows music apps and browser tabs. Discord, games, Teams and every other app are ignored.

To change this, open the tray menu → **Players**:
- Tick or untick any player it has seen.
- Turn **Show browser tabs** off if you only want desktop music apps. Browser tabs are on by default because SoundCloud and YouTube Music play there.

The visualizer only moves while music is playing, so game sounds and voice chat don't drive it.

## The equalizer

The equalizer has two modes. Pick one at the top of the equalizer panel.

**Music only** (the default) changes only the player the overlay shows: Spotify, Deezer, a browser tab and so on. Discord, games and everything else sound exactly as before.

Windows can't equalize one app by itself, so this mode sends the player's sound through **VB-CABLE**, a free virtual audio cable by VB-Audio. Music Overlayer equalizes it there and plays it on your speakers or headphones. To set it up:

1. Open the equalizer in the card and click **Set up**, or say yes when the install command asks.
2. Allow it when Windows asks for permission, then allow the driver.
3. Restart Windows once.

Some things to know:
- For a browser tab, the whole browser goes through the equalizer, because Windows treats the browser as one app.
- The music gets a small delay, about the time it takes to blink. You won't notice it in music; a video may look very slightly out of sync.
- When Music Overlayer is closed, or the music stays paused for 20 seconds, the player goes back to playing straight to your speakers, without the equalizer.
- While the equalizer works, Windows shows Music Overlayer as using a microphone. That's VB-CABLE's recording side, which carries your music. Nothing is recorded or saved.

**Everything** changes all the sound on your speakers or headphones, including voices in Discord calls and games. It uses **Equalizer APO** (free, open source), which the panel offers to set up the same way. Then:
- To change which devices get it, use tray → **Equalizer engine** → **Choose speakers and headphones…**
- If you already use Equalizer APO, your own settings stay as they are; Music Overlayer only adds its own. To remove them, use tray → **Equalizer engine** → **Unlink Music Overlayer**.

Use the switch at the top of the equalizer panel to turn the equalizer off.

## Troubleshooting

**The overlay says "Can't read Windows media right now".**
The message under it gives the reason. It usually means a security policy or antivirus on this PC is blocking PowerShell scripts.

**A player doesn't show up.**
Tray → **Players** lists every app that reported media. Tick it there. In Firefox, also check that `media.hardwaremediakeys.enabled` is `true` in `about:config`.

**The timeline is greyed out, or shuffle and repeat are missing.**
That player doesn't let other apps use them. Browsers and Apple Music don't offer shuffle or repeat to other apps, so the card leaves those buttons out.

**There's no cover art.**
Some players don't share their artwork with Windows. Tray → **Find missing covers online** looks it up by title and artist on Apple's iTunes Search. It's off until you turn it on.

**Music only says "Windows blocks apps from using recording devices".**
VB-CABLE's recording side counts as a microphone. In Windows Settings → Privacy → Microphone, turn on **Let desktop apps access your microphone**.

**A player is silent.**
If Music Overlayer was closed unexpectedly while the equalizer worked, the player may still be sending its sound to VB-CABLE. Start Music Overlayer again and it puts it back. You can also reset it in Windows Settings → System → Sound → Volume mixer → **Reset**.

**There's no volume slider.**
The slider only shows when the player appears in the Windows volume mixer. Play something in it and it shows up.

**The equalizer does nothing.**
- Restart Windows after setup.
- In **Music only**, the panel says which player it's equalizing. If the music plays without it, pause and play once.
- In **Everything**, check tray → **Equalizer engine** → **Choose speakers and headphones…** and make sure the device you listen on is ticked.

---

Music Overlayer is made by ITX.