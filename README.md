# Music Overlayer

**Made by ITX**

A small always-on-top now-playing overlay for Windows, with a built-in 10-band equalizer. It only follows music: Spotify, Deezer, TIDAL, Apple Music and other music apps, plus browser tabs (SoundCloud, YouTube Music, Deezer and Spotify Web). Discord, games and other apps are ignored.

## Install

Open **PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/itxxxx/Music-Overlayer/main/install.ps1 | iex
```

This downloads the latest release and installs it for your account (no admin needed). It then offers to set up the equalizer and starts Music Overlayer. Run the same command again to update.

To uninstall, go to Windows Settings → Apps → Installed apps → Music Overlayer.

## What it does

- **Pill:** shows the artwork, title, artist and live bars. After 4 seconds on its own it fades to 75% opacity.
- **Card:** move the pointer over the pill and it comes back to full opacity. Rest there for 0.3 s and it opens into the card, with the cover art, a timeline you can drag to seek, previous/play-pause/next, and shuffle/repeat when the player supports them.
- **Equalizer:** 10 bands, presets, your own saved presets and a preamp. Open it with the sliders button on the cover.
- **Colours:** the overlay picks its colours from the current album art.
- **Always on top:** it stays above other windows without taking focus. Clicks pass through everywhere except the overlay itself.

| To do this | Do this |
| --- | --- |
| Open the card | Rest the pointer on the pill for 0.3 s, or click it |
| Seek | Click or drag the timeline |
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

Windows doesn't let one app change another app's sound on its own; that takes an audio driver component. Music Overlayer uses **Equalizer APO** (free, open source) for that. You never have to download or configure it yourself:

1. Open the equalizer in the card and click **Set up**, or say yes during the install command.
2. Windows asks for permission, then Equalizer APO's setup window opens. Tick the speakers or headphones you listen on.
3. Restart Windows once.

From then on, every change you make in the overlay is applied instantly. Some things to know:
- The equalizer applies to everything played on the devices you ticked, not just music. Use the switch in the equalizer panel to turn it off.
- To change which devices get the equalizer, use tray → **Equalizer engine** → **Choose speakers and headphones…**
- Behind the scenes, Music Overlayer writes its bands to `music-overlayer-eq.txt` in Equalizer APO's `config` folder. It also adds these lines to `config.txt`:

  ```
  # >>> Music Overlayer equalizer (added by Music Overlayer - delete these lines to unlink it)
  Device: all
  Channel: all
  Include: music-overlayer-eq.txt
  # <<< Music Overlayer equalizer
  ```

  Tray → **Equalizer engine** → **Unlink Music Overlayer** removes these lines.

## Publish to GitHub (first time)

The install command downloads the newest release from https://github.com/itxxxx/Music-Overlayer. Releases are built automatically by GitHub Actions (`.github/workflows/release.yml`) every time a version tag is pushed.

You need [Git for Windows](https://git-scm.com/download/win). Then run these in the project folder:

```powershell
cd "D:\Dev\Music player"

# Put the release workflow where GitHub looks for it (only if release.yml is in this folder)
mkdir .github\workflows
move release.yml .github\workflows\release.yml

git init
git add .
git commit -m "Music Overlayer 1.0.0"
git branch -M main
git remote add origin https://github.com/itxxxx/Music-Overlayer.git

# The repo already has a README commit: merge it in, keeping this project's README
git pull origin main --allow-unrelated-histories --no-edit -X ours
git push -u origin main

# Publish version 1.0.0
git tag v1.0.0
git push origin v1.0.0
```

Some notes on these commands:
- The first `git push` opens a GitHub sign-in in your browser.
- If `git commit` asks who you are, run `git config --global user.name "ITX"` and `git config --global user.email "<your email>"`, then commit again.
- If the pull stops with a conflict in `README.md`, run `git checkout --ours README.md`, then `git add README.md`, then `git commit --no-edit`.

After the tag is pushed, open the repo's **Actions** tab. The *Release* run takes about 5–10 minutes, then the installer and the portable `.exe` appear under **Releases**. The install command works from that moment.

### Next versions

1. Change `"version"` in `package.json`, for example to `1.1.0`.
2. Run `git commit -am "1.1.0"`, then `git push`.
3. Run `git tag v1.1.0`, then `git push origin v1.1.0`.

People get the update by running the install command again.

## Develop

You need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
npm install      # also downloads Electron itself (about 100 MB, once)
npm run dev      # run with hot reload
npm run demo     # run with demo tracks, no music needed
npm run dist     # build the installer and portable app into dist/
```

If `npm run dev` ever says **Electron uninstall**, run `npx install-electron` and try again.

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with hot reload |
| `npm run demo` | Run with demo tracks |
| `npm run build` | Build into `out/` |
| `npm start` | Run the built app |
| `npm run typecheck` | Type-check main, preload and UI |
| `npm run dist` | Installer and portable `.exe` in `dist/` |

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| Media bridge | `resources/media-bridge.ps1` | A Windows PowerShell script the app runs in the background. It reads Windows' media sessions every 0.4 s, keeps only the allowed players and sends play/pause, next, previous and seek. |
| Player rules | `src/shared/apps.ts` | Which apps count as music players or browsers. |
| Supervisor | `src/main/media/windows-bridge.ts` | Starts the script, restarts it if it stops, and passes the player rules on to it. |
| Window | `src/main/widget-window.ts` | Transparent, always on top, click-through outside the overlay, never takes focus. |
| Visualizer | `src/renderer/src/lib/audio-levels.ts` | Reads the level of what your PC is playing (loopback; nothing is recorded or saved). |
| Equalizer | `src/main/eq/equalizer-apo.ts`, `src/shared/eq.ts` | Sets up Equalizer APO and writes the filter file. The curve in the panel is the real response of those filters. |
| Installer | `install.ps1`, `.github/workflows/release.yml` | The one-line install command and the release builds. |

### Project structure and shadcn/ui

The project uses the shadcn layout:
- `components.json`
- Tailwind CSS v4 (`src/renderer/src/index.css`)
- TypeScript, with the `@/` alias pointing to `src/renderer/src`

UI components live in `src/renderer/src/components/ui`. That's where the shadcn CLI installs components, and the path copy-pasted components import from (`@/components/ui/button`, `@/lib/utils`). Add more components with `npx shadcn@latest add <name>`.

The 21st.dev **AudioPlayer** is in `components/ui/audio-player.tsx` (unchanged). The overlay uses an adapted version, `components/ui/now-playing-card.tsx`, which drives the player Windows reports instead of its own `<audio>` element.

## Troubleshooting

**The card says "Can't read Windows media right now".**
The message under it gives the reason. Usually a policy or antivirus is blocking PowerShell scripts. To test the bridge on its own, run from the install folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File resources\media-bridge.ps1
```

With music playing it prints a line of JSON per change. Type `next` and press Enter to skip a track.

**A player doesn't show up.**
Tray → **Players** lists every app that reported media. Tick it there. In Firefox, also check that `media.hardwaremediakeys.enabled` is `true` in `about:config`.

**The timeline is greyed out, or shuffle and repeat are.**
That player doesn't report them to Windows. Spotify, for example, doesn't offer shuffle or repeat.

**The equalizer does nothing.**
- Restart Windows after setup.
- Check tray → **Equalizer engine** → **Choose speakers and headphones…** and make sure the device you listen on is ticked.

---

Music Overlayer is made by ITX.
