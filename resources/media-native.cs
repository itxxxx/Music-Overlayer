// Music Overlayer native helper.
//
// media-bridge.ps1 compiles this file once and keeps the result (see Initialize-Native), with
// the C# compiler that comes with Windows (.NET Framework 4.x), so it must stay C# 5: no string
// interpolation, no ?. and no expression-bodied members. It talks to Windows audio through COM:
//
//   AudioApps     the per-app volume Windows keeps for each app (the volume mixer).
//   AudioDevices  finds VB-CABLE's "CABLE Input" among the output devices, and the bit depth
//                 of both of its sides.
//   AudioRouting  sends one app's sound to another output device, the way Windows Settings >
//                 Sound > Volume mixer does. That's how only the music app gets equalized.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace MusicOverlayer
{
    internal static class Com
    {
        internal static void Check(int hresult, string what)
        {
            if (hresult < 0) throw new COMException(what + " failed (0x" + hresult.ToString("X8") + ")", hresult);
        }

        internal static void Release(object instance)
        {
            if (instance != null && Marshal.IsComObject(instance))
            {
                try { Marshal.ReleaseComObject(instance); } catch { }
            }
        }
    }

    // --- Per-app audio -----------------------------------------------------------------------------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorClass
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr groupingParam, int streamFlags, out IntPtr sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr groupingParam, int streamFlags, out IntPtr audioVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
        [PreserveSig] int RegisterSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        // IAudioSessionControl
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingParam);
        [PreserveSig] int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
        // IAudioSessionControl2
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out int processId);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;

        public PropertyKey(string formatId, int propertyId)
        {
            FormatId = new Guid(formatId);
            PropertyId = propertyId;
        }
    }

    // Only the parts used here: the type and, for strings, the pointer. The last field makes the
    // struct as large as the real PROPVARIANT on 64-bit Windows. A blob is its size (offset 8)
    // and a pointer: at 16 on 64-bit Windows (Reserved), at 12 on 32-bit (Word12).
    [StructLayout(LayoutKind.Explicit)]
    internal struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
        [FieldOffset(8)] public int Size;
        [FieldOffset(12)] public int Word12;
        [FieldOffset(16)] public IntPtr Reserved;
    }

    /// <summary>Volume of one app as Windows' volume mixer shows it.</summary>
    public sealed class AppVolume
    {
        public bool Found;
        public double Level;
        public bool Muted;
        /// <summary>Process names that matched, for diagnostics.</summary>
        public string Processes;
    }

    public static class AudioApps
    {
        private sealed class Session
        {
            public int ProcessId;
            public string Process;
            public IAudioSessionControl2 Control;
            public ISimpleAudioVolume Volume;
        }

        private const int RenderFlow = 0;          // eRender
        private const int ActiveDevices = 1;       // DEVICE_STATE_ACTIVE
        private const int AllContexts = 23;        // CLSCTX_ALL
        private const int SessionActive = 1;       // AudioSessionStateActive
        private const int SessionExpired = 2;      // AudioSessionStateExpired
        private const int RefreshEveryMs = 3000;
        // Right after a player is moved to another device, its sound shows up there as a new
        // session: look this often for a while (see RefreshSoon).
        private const int RefreshFastMs = 250;

        private static readonly Guid SessionManagerId = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        private static Guid ownChanges = new Guid("5A0C2B6E-3C1B-4B57-9A9E-6D3B1F4E2C71");

        private static readonly List<Session> sessions = new List<Session>();
        private static readonly Dictionary<int, string> processNames = new Dictionary<int, string>();
        private static int refreshedAt;
        private static bool everRefreshed;
        private static int fastUntil;
        private static bool fast;

        public static string LastError { get; private set; }

        // App ids that don't contain their process name: a part of the id -> process names.
        private static readonly string[][] Aliases =
        {
            new[] { "spotify", "spotify" },
            new[] { "edge", "msedge" },
            new[] { "chrome", "chrome" },
            new[] { "chromium", "chromium" },
            new[] { "brave", "brave" },
            new[] { "opera", "opera" },
            new[] { "vivaldi", "vivaldi" },
            new[] { "yandex", "browser" },
            new[] { "thebrowsercompany", "arc" },
            new[] { "applemusic", "applemusic", "amplibraryagent" },
            new[] { "itunes", "itunes" },
            new[] { "zunemusic", "microsoft.media.player", "music.ui" },
            new[] { "deezer", "deezer" },
            new[] { "tidal", "tidal", "tidalplayer" },
            new[] { "amazon", "amazon music", "amazonmusic" },
            new[] { "youtubemusic", "youtube music" },
            new[] { "foobar2000", "foobar2000" },
            new[] { "musicbee", "musicbee" },
            new[] { "aimp", "aimp" },
            new[] { "winamp", "winamp" },
            new[] { "videolan", "vlc" },
            new[] { "vlc", "vlc" },
            new[] { "qobuz", "qobuz" },
            new[] { "soundcloud", "soundcloud" },
            new[] { "pandora", "pandora" },
            new[] { "audacious", "audacious" },
            new[] { "cider", "cider" },
        };

        // Firefox and its forks use a hash of their install folder as their app id.
        private static readonly string[] MozillaProcesses =
        {
            "firefox", "librewolf", "waterfox", "floorp", "zen", "mullvadbrowser", "palemoon", "seamonkey"
        };

        /// <summary>Re-reads every app's audio session on every active output device.</summary>
        public static void Refresh()
        {
            refreshedAt = Environment.TickCount;
            everRefreshed = true;
            ReleaseAll();
            IMMDeviceEnumerator enumerator = null;
            IMMDeviceCollection devices = null;
            var alive = new Dictionary<int, bool>();
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass();
                Com.Check(enumerator.EnumAudioEndpoints(RenderFlow, ActiveDevices, out devices), "EnumAudioEndpoints");
                int deviceCount;
                Com.Check(devices.GetCount(out deviceCount), "IMMDeviceCollection.GetCount");
                for (int d = 0; d < deviceCount; d++)
                {
                    IMMDevice device = null;
                    object managerObject = null;
                    IAudioSessionEnumerator list = null;
                    try
                    {
                        if (devices.Item(d, out device) < 0 || device == null) continue;
                        Guid iid = SessionManagerId;
                        if (device.Activate(ref iid, AllContexts, IntPtr.Zero, out managerObject) < 0 || managerObject == null) continue;
                        var manager = (IAudioSessionManager2)managerObject;
                        if (manager.GetSessionEnumerator(out list) < 0 || list == null) continue;
                        int count;
                        if (list.GetCount(out count) < 0) continue;
                        for (int i = 0; i < count; i++)
                        {
                            IAudioSessionControl2 control;
                            if (list.GetSession(i, out control) < 0 || control == null) continue;
                            int state = 0, processId = 0;
                            bool keep = control.GetState(out state) >= 0 && state != SessionExpired &&
                                        control.GetProcessId(out processId) >= 0 && processId > 0;
                            string name = keep ? ProcessName(processId) : null;
                            if (string.IsNullOrEmpty(name))
                            {
                                Com.Release(control);
                                continue;
                            }
                            alive[processId] = true;
                            sessions.Add(new Session
                            {
                                ProcessId = processId,
                                Process = name,
                                Control = control,
                                Volume = control as ISimpleAudioVolume
                            });
                        }
                    }
                    finally
                    {
                        Com.Release(list);
                        Com.Release(managerObject);
                        Com.Release(device);
                    }
                }
                LastError = null;
            }
            catch (Exception error)
            {
                LastError = error.Message;
            }
            finally
            {
                Com.Release(devices);
                Com.Release(enumerator);
            }

            // Forget processes that have gone, so a reused id gets its new name.
            var gone = new List<int>();
            foreach (int id in processNames.Keys) if (!alive.ContainsKey(id)) gone.Add(id);
            foreach (int id in gone) processNames.Remove(id);
        }

        private static void RefreshIfStale()
        {
            if (fast && Environment.TickCount - fastUntil >= 0) fast = false;
            int every = fast ? RefreshFastMs : RefreshEveryMs;
            if (!everRefreshed || Environment.TickCount - refreshedAt > every) Refresh();
        }

        /// <summary>
        /// Read the sessions more often for the next `forMs`: a player just moved to another output
        /// device gets a new session there (with the volume Windows remembers for that device).
        /// </summary>
        public static void RefreshSoon(int forMs)
        {
            fast = true;
            fastUntil = Environment.TickCount + forMs;
            refreshedAt = Environment.TickCount - RefreshEveryMs - 1;
        }

        private static void ReleaseAll()
        {
            foreach (var session in sessions) Com.Release(session.Control);
            sessions.Clear();
        }

        private static string ProcessName(int processId)
        {
            string name;
            if (processNames.TryGetValue(processId, out name)) return name;
            try
            {
                using (var process = Process.GetProcessById(processId))
                {
                    name = process.ProcessName.ToLowerInvariant();
                }
            }
            catch
            {
                name = null;
            }
            if (name != null) processNames[processId] = name;
            return name;
        }

        private static string Letters(string value)
        {
            var builder = new StringBuilder(value.Length);
            foreach (char c in value.ToLowerInvariant()) if (char.IsLetterOrDigit(c)) builder.Append(c);
            return builder.ToString();
        }

        private static bool IsHexId(string value)
        {
            if (value.Length != 16) return false;
            foreach (char c in value) if (Uri.IsHexDigit(c) == false) return false;
            return true;
        }

        /// <summary>Process names that can belong to a media session's app id.</summary>
        internal static List<string> CandidatesFor(string appId)
        {
            var names = new List<string>();
            if (string.IsNullOrEmpty(appId)) return names;
            string id = appId.ToLowerInvariant();
            string bare = id.EndsWith(".exe") ? id.Substring(0, id.Length - 4) : id;
            names.Add(bare);
            int bang = bare.IndexOf('!');
            if (bang >= 0)
            {
                names.Add(bare.Substring(bang + 1));
                bare = bare.Substring(0, bang);
            }
            // "C:\Program Files\App\app.exe" -> "app"
            int slash = Math.Max(bare.LastIndexOf('\\'), bare.LastIndexOf('/'));
            if (slash >= 0) names.Add(bare.Substring(slash + 1));
            foreach (string part in bare.Split('.', '_', '-', ' ', '\\', '/'))
            {
                if (part.Length >= 3) names.Add(part);
            }
            if (IsHexId(appId)) names.AddRange(MozillaProcesses);
            string letters = Letters(appId);
            foreach (string[] alias in Aliases)
            {
                if (letters.Contains(alias[0]))
                {
                    for (int i = 1; i < alias.Length; i++) names.Add(alias[i]);
                }
            }
            return names;
        }

        /// <summary>Which of these process names (lower case, no .exe) belong to the app id.</summary>
        public static string[] MatchProcesses(string appId, string[] processes)
        {
            var found = new List<string>();
            List<string> names = CandidatesFor(appId);
            if (names.Count == 0 || processes == null) return found.ToArray();
            foreach (string process in processes)
            {
                if (names.Contains(process) && !found.Contains(process)) found.Add(process);
            }
            if (found.Count > 0) return found.ToArray();

            // Loose match: the app id spells out the process name (TIDAL, YouTube Music, ...).
            string letters = Letters(appId);
            foreach (string process in processes)
            {
                string compact = Letters(process);
                if (compact.Length >= 5 && letters.Contains(compact) && !found.Contains(process)) found.Add(process);
            }
            return found.ToArray();
        }

        private static List<Session> Match(string appId)
        {
            var processes = new List<string>();
            foreach (var session in sessions) if (!processes.Contains(session.Process)) processes.Add(session.Process);
            var matched = new List<string>(MatchProcesses(appId, processes.ToArray()));
            var found = new List<Session>();
            foreach (var session in sessions) if (matched.Contains(session.Process)) found.Add(session);
            return found;
        }

        /// <summary>Ids of the processes that play the app's sound (each has an audio session).</summary>
        public static int[] ProcessIds(string appId)
        {
            var ids = new List<int>();
            try
            {
                RefreshIfStale();
                List<Session> matches = Match(appId);
                if (matches.Count == 0 && Environment.TickCount - refreshedAt > 500)
                {
                    Refresh();
                    matches = Match(appId);
                }
                foreach (var session in matches) if (!ids.Contains(session.ProcessId)) ids.Add(session.ProcessId);
            }
            catch (Exception error)
            {
                LastError = error.Message;
            }
            return ids.ToArray();
        }

        /// <summary>The volume-mixer level of the app behind a media session.</summary>
        public static AppVolume Get(string appId)
        {
            var result = new AppVolume();
            try
            {
                RefreshIfStale();
                List<Session> matches = Match(appId);
                if (matches.Count == 0)
                {
                    // A player that just started may not have had a session at the last refresh.
                    if (Environment.TickCount - refreshedAt > 500)
                    {
                        Refresh();
                        matches = Match(appId);
                    }
                }
                // The loudest session that's playing (an app can have one per output device, each
                // with its own volume), or the first one when none is playing.
                Session best = null;
                float level = 0f;
                bool bestActive = false;
                foreach (var session in matches)
                {
                    if (session.Volume == null) continue;
                    int state;
                    bool active = session.Control.GetState(out state) >= 0 && state == SessionActive;
                    float sessionLevel;
                    if (session.Volume.GetMasterVolume(out sessionLevel) < 0) continue;
                    if (best == null || (active && (!bestActive || sessionLevel > level)))
                    {
                        best = session;
                        level = sessionLevel;
                        bestActive = active;
                    }
                }
                if (best == null) return result;
                bool muted;
                if (best.Volume.GetMute(out muted) < 0) return result;
                result.Found = true;
                result.Level = Math.Round(Math.Max(0f, Math.Min(1f, level)), 3);
                result.Muted = muted;
                var unique = new List<string>();
                foreach (var session in matches) if (!unique.Contains(session.Process)) unique.Add(session.Process);
                result.Processes = string.Join(",", unique.ToArray());
            }
            catch (Exception error)
            {
                LastError = error.Message;
                Refresh();
            }
            return result;
        }

        /// <summary>Sets the app's volume (0 to 1) in every session it has. Returns how many it set.</summary>
        public static int SetLevel(string appId, double level)
        {
            return SetLevel(appId, level, false);
        }

        /// <summary>
        /// `fresh`: read the sessions again first, so one that just appeared (the player moved to
        /// another output device) gets the level too. For the overlay turning a player down.
        /// </summary>
        public static int SetLevel(string appId, double level, bool fresh)
        {
            float value = (float)Math.Max(0.0, Math.Min(1.0, level));
            return Apply(appId, fresh, delegate (ISimpleAudioVolume volume)
            {
                return volume.SetMasterVolume(value, ref ownChanges);
            });
        }

        public static int SetMuted(string appId, bool muted)
        {
            return Apply(appId, false, delegate (ISimpleAudioVolume volume)
            {
                return volume.SetMute(muted, ref ownChanges);
            });
        }

        private delegate int VolumeChange(ISimpleAudioVolume volume);

        private static int Apply(string appId, bool fresh, VolumeChange change)
        {
            int changed = 0;
            try
            {
                if (fresh) Refresh();
                else RefreshIfStale();
                List<Session> matches = Match(appId);
                if (matches.Count == 0)
                {
                    Refresh();
                    matches = Match(appId);
                }
                foreach (var session in matches)
                {
                    if (session.Volume != null && change(session.Volume) >= 0) changed++;
                }
            }
            catch (Exception error)
            {
                LastError = error.Message;
                Refresh();
            }
            return changed;
        }

        /// <summary>One line per audio session, for -Diagnose.</summary>
        public static string Describe()
        {
            Refresh();
            var builder = new StringBuilder();
            foreach (var session in sessions)
            {
                int state;
                float level = -1f;
                bool muted = false;
                session.Control.GetState(out state);
                if (session.Volume != null)
                {
                    session.Volume.GetMasterVolume(out level);
                    session.Volume.GetMute(out muted);
                }
                string device = AudioRouting.DeviceOf(session.ProcessId);
                builder.Append("  ").Append(session.Process).Append(" (pid ").Append(session.ProcessId).Append(")")
                    .Append(state == SessionActive ? " active" : " idle")
                    .Append(", volume ").Append(Math.Round(level * 100)).Append("%")
                    .Append(muted ? ", muted" : "")
                    .Append(string.IsNullOrEmpty(device) ? "" : ", sent to " + device)
                    .AppendLine();
            }
            if (builder.Length == 0) builder.AppendLine("  (no app is using audio)");
            return builder.ToString();
        }
    }

    // --- Output devices ----------------------------------------------------------------------------

    public static class AudioDevices
    {
        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        private const int RenderFlow = 0;
        private const int CaptureFlow = 1;
        private const int ActiveDevices = 1;
        private const int ReadOnly = 0;           // STGM_READ
        private const ushort StringType = 31;     // VT_LPWSTR
        private const ushort BlobType = 65;       // VT_BLOB
        private const int ExtensibleFormat = 0xFFFE;
        private static PropertyKey friendlyName = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 14);
        // The format Windows uses with the device (Sound settings > Properties > Advanced).
        private static PropertyKey deviceFormat = new PropertyKey("F19F064D-082C-4E27-BC73-6882A1BB8E4C", 0);

        public static string LastError { get; private set; }

        private sealed class Endpoint
        {
            public string Id;
            public string Name = "";
            public int Bits;
        }

        /// <summary>Id and name of every active output device.</summary>
        public static List<KeyValuePair<string, string>> Outputs()
        {
            var found = new List<KeyValuePair<string, string>>();
            foreach (var endpoint in Endpoints(RenderFlow, false)) found.Add(new KeyValuePair<string, string>(endpoint.Id, endpoint.Name));
            return found;
        }

        /// <summary>
        /// Bits per sample VB-CABLE carries the sound in: the smaller of its two sides ("CABLE
        /// Input" and "CABLE Output"), usually 16 or 24. 0 when a side is missing or unreadable.
        /// </summary>
        public static int CableBits()
        {
            int input = 0;
            int output = 0;
            foreach (var endpoint in Endpoints(RenderFlow, true))
            {
                if (IsCable(endpoint.Name, "CABLE Input")) input = endpoint.Bits;
            }
            foreach (var endpoint in Endpoints(CaptureFlow, true))
            {
                if (IsCable(endpoint.Name, "CABLE Output")) output = endpoint.Bits;
            }
            return Math.Min(input, output);
        }

        private static bool IsCable(string name, string side)
        {
            return name.IndexOf(side, StringComparison.OrdinalIgnoreCase) >= 0 &&
                name.IndexOf("VB-Audio", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static List<Endpoint> Endpoints(int flow, bool withBits)
        {
            var found = new List<Endpoint>();
            IMMDeviceEnumerator enumerator = null;
            IMMDeviceCollection devices = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass();
                Com.Check(enumerator.EnumAudioEndpoints(flow, ActiveDevices, out devices), "EnumAudioEndpoints");
                int count;
                Com.Check(devices.GetCount(out count), "IMMDeviceCollection.GetCount");
                for (int i = 0; i < count; i++)
                {
                    IMMDevice device = null;
                    IPropertyStore store = null;
                    try
                    {
                        string id;
                        if (devices.Item(i, out device) < 0 || device == null || device.GetId(out id) < 0) continue;
                        var endpoint = new Endpoint();
                        endpoint.Id = id;
                        if (device.OpenPropertyStore(ReadOnly, out store) >= 0 && store != null)
                        {
                            PropVariant value;
                            if (store.GetValue(ref friendlyName, out value) >= 0)
                            {
                                if (value.Type == StringType && value.Pointer != IntPtr.Zero) endpoint.Name = Marshal.PtrToStringUni(value.Pointer);
                                PropVariantClear(ref value);
                            }
                            if (withBits) endpoint.Bits = BitsOf(store);
                        }
                        found.Add(endpoint);
                    }
                    finally
                    {
                        Com.Release(store);
                        Com.Release(device);
                    }
                }
                LastError = null;
            }
            catch (Exception error)
            {
                LastError = error.Message;
            }
            finally
            {
                Com.Release(devices);
                Com.Release(enumerator);
            }
            return found;
        }

        /// <summary>Bits per sample of the device's format (a WAVEFORMATEX blob), or 0.</summary>
        private static int BitsOf(IPropertyStore store)
        {
            PropVariant value;
            if (store.GetValue(ref deviceFormat, out value) < 0) return 0;
            try
            {
                return value.Type == BlobType ? BitsOfBlob(value) : 0;
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }

        internal static int BitsOfBlob(PropVariant value)
        {
            int size = value.Size;
            IntPtr data = IntPtr.Size == 8 ? value.Reserved : new IntPtr(value.Word12);
            if (data == IntPtr.Zero || size < 16) return 0;
            int tag = (ushort)Marshal.ReadInt16(data, 0);
            int bits = (ushort)Marshal.ReadInt16(data, 14);
            int extra = size >= 18 ? (ushort)Marshal.ReadInt16(data, 16) : 0;
            // WAVE_FORMAT_EXTENSIBLE: 24-bit sound in 32-bit slots says so here.
            if (tag == ExtensibleFormat && extra >= 22 && size >= 20)
            {
                int valid = (ushort)Marshal.ReadInt16(data, 18);
                if (valid > 0) bits = valid;
            }
            return bits;
        }

        /// <summary>Id of VB-CABLE's playback side ("CABLE Input"), or null when it isn't there.</summary>
        public static string FindCableInput()
        {
            foreach (var output in Outputs())
            {
                if (IsCable(output.Value, "CABLE Input")) return output.Key;
            }
            return null;
        }

        public static string NameOf(string id)
        {
            foreach (var output in Outputs()) if (output.Key == id) return output.Value;
            return null;
        }
    }

    // --- Sending one app to another output device --------------------------------------------------

    // Windows' own per-app output setting. Not a documented API: EarTrumpet and SoundSwitch use
    // it too. 19 methods come before the ones used here; their order must not change.
    [ComImport, Guid("AB3D4648-E242-459F-B02F-541C70306324"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface IAudioPolicyConfig21H2
    {
        void Reserved01(); void Reserved02(); void Reserved03(); void Reserved04(); void Reserved05();
        void Reserved06(); void Reserved07(); void Reserved08(); void Reserved09(); void Reserved10();
        void Reserved11(); void Reserved12(); void Reserved13(); void Reserved14(); void Reserved15();
        void Reserved16(); void Reserved17(); void Reserved18(); void Reserved19();
        [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
        [PreserveSig] int GetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, out IntPtr deviceId);
        [PreserveSig] int ClearAllPersistedApplicationDefaultEndpoints();
    }

    // The same interface on Windows 10 before build 21390.
    [ComImport, Guid("2A59116D-6C4F-45E0-A74F-707E3FEF9258"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface IAudioPolicyConfigDownlevel
    {
        void Reserved01(); void Reserved02(); void Reserved03(); void Reserved04(); void Reserved05();
        void Reserved06(); void Reserved07(); void Reserved08(); void Reserved09(); void Reserved10();
        void Reserved11(); void Reserved12(); void Reserved13(); void Reserved14(); void Reserved15();
        void Reserved16(); void Reserved17(); void Reserved18(); void Reserved19();
        [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
        [PreserveSig] int GetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, out IntPtr deviceId);
        [PreserveSig] int ClearAllPersistedApplicationDefaultEndpoints();
    }

    public static class AudioRouting
    {
        [DllImport("combase.dll")]
        private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

        [DllImport("combase.dll", CharSet = CharSet.Unicode)]
        private static extern int WindowsCreateString(string source, int length, out IntPtr value);

        [DllImport("combase.dll")]
        private static extern int WindowsDeleteString(IntPtr value);

        [DllImport("combase.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr WindowsGetStringRawBuffer(IntPtr value, out int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(int access, bool inherit, int processId);

        [DllImport("kernel32.dll")]
        private static extern int WaitForSingleObject(IntPtr handle, int milliseconds);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private const string ClassName = "Windows.Media.Internal.AudioPolicyConfig";
        private const string DevicePrefix = @"\\?\SWD#MMDEVAPI#";
        private const string RenderSuffix = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
        private const int RenderFlow = 0;
        private const int WatchAccess = 0x00100000 | 0x1000;   // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION

        private sealed class Routed
        {
            public string AppId;
            public IntPtr Handle;
        }

        private static IAudioPolicyConfig21H2 modern;
        private static IAudioPolicyConfigDownlevel downlevel;
        private static bool triedFactory;
        // Process id -> what was routed. The open handle keeps the id from being reused, so the
        // route can still be undone right after the app quits.
        private static readonly Dictionary<int, Routed> routed = new Dictionary<int, Routed>();

        public static string LastError { get; private set; }

        public static bool Available
        {
            get { return Factory(); }
        }

        /// <summary>"21H2" or "pre-21H2": which interface this Windows answered to.</summary>
        public static string Variant
        {
            get { return modern != null ? "21H2" : downlevel != null ? "pre-21H2" : ""; }
        }

        private static bool Factory()
        {
            if (modern != null || downlevel != null) return true;
            if (triedFactory) return false;
            triedFactory = true;
            IntPtr name = IntPtr.Zero;
            try
            {
                Com.Check(WindowsCreateString(ClassName, ClassName.Length, out name), "WindowsCreateString");
                object factory;
                Guid iid = typeof(IAudioPolicyConfig21H2).GUID;
                if (RoGetActivationFactory(name, ref iid, out factory) >= 0 && factory != null)
                {
                    modern = (IAudioPolicyConfig21H2)factory;
                    return true;
                }
                iid = typeof(IAudioPolicyConfigDownlevel).GUID;
                if (RoGetActivationFactory(name, ref iid, out factory) >= 0 && factory != null)
                {
                    downlevel = (IAudioPolicyConfigDownlevel)factory;
                    return true;
                }
                LastError = "this version of Windows doesn't let apps choose another app's output device";
                return false;
            }
            catch (Exception error)
            {
                LastError = error.Message;
                return false;
            }
            finally
            {
                if (name != IntPtr.Zero) WindowsDeleteString(name);
            }
        }

        /// <summary>Sends a process's sound to an output device (an endpoint id), or back to the default (null).</summary>
        private static int Set(int processId, string endpointId)
        {
            IntPtr value = IntPtr.Zero;
            try
            {
                if (endpointId != null)
                {
                    string path = DevicePrefix + endpointId + RenderSuffix;
                    Com.Check(WindowsCreateString(path, path.Length, out value), "WindowsCreateString");
                }
                int result = 0;
                // Both roles, as Windows' own settings page does: eConsole (0) and eMultimedia (1).
                for (int role = 0; role <= 1; role++)
                {
                    int hr = modern != null
                        ? modern.SetPersistedDefaultAudioEndpoint((uint)processId, RenderFlow, role, value)
                        : downlevel.SetPersistedDefaultAudioEndpoint((uint)processId, RenderFlow, role, value);
                    if (hr < 0) result = hr;
                }
                return result;
            }
            finally
            {
                if (value != IntPtr.Zero) WindowsDeleteString(value);
            }
        }

        /// <summary>The output device a process is sent to, or "" for the default.</summary>
        public static string DeviceOf(int processId)
        {
            if (!Factory()) return "";
            IntPtr value = IntPtr.Zero;
            try
            {
                int hr = modern != null
                    ? modern.GetPersistedDefaultAudioEndpoint((uint)processId, RenderFlow, 1, out value)
                    : downlevel.GetPersistedDefaultAudioEndpoint((uint)processId, RenderFlow, 1, out value);
                if (hr < 0 || value == IntPtr.Zero) return "";
                int length;
                IntPtr raw = WindowsGetStringRawBuffer(value, out length);
                string path = raw == IntPtr.Zero ? "" : Marshal.PtrToStringUni(raw, length);
                // "\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{guid}#{...}" -> the endpoint id, then its name.
                string id = path;
                if (id.StartsWith(DevicePrefix)) id = id.Substring(DevicePrefix.Length);
                int suffix = id.IndexOf('#');
                if (suffix > 0) id = id.Substring(0, suffix);
                return AudioDevices.NameOf(id) ?? id;
            }
            catch
            {
                return "";
            }
            finally
            {
                if (value != IntPtr.Zero) WindowsDeleteString(value);
            }
        }

        /// <summary>
        /// Sends the app's sound to the device. Anything routed before for another app goes back
        /// to the default first. Returns how many of the app's processes were routed.
        /// </summary>
        public static int Route(string appId, string endpointId)
        {
            LastError = null;
            if (string.IsNullOrEmpty(appId) || string.IsNullOrEmpty(endpointId) || !Factory()) return 0;
            var others = new List<string>();
            foreach (var entry in routed.Values) if (entry.AppId != appId && !others.Contains(entry.AppId)) others.Add(entry.AppId);
            foreach (string other in others) Unroute(other);

            int count = 0;
            foreach (int processId in AudioApps.ProcessIds(appId))
            {
                if (routed.ContainsKey(processId))
                {
                    count++;
                    continue;
                }
                int hr = Set(processId, endpointId);
                if (hr < 0)
                {
                    LastError = "Windows refused to move the app's sound (0x" + hr.ToString("X8") + ")";
                    continue;
                }
                routed[processId] = new Routed { AppId = appId, Handle = OpenProcess(WatchAccess, false, processId) };
                count++;
            }
            return count;
        }

        /// <summary>Sends the app's sound back to the default device. Returns how many processes changed.</summary>
        public static int Unroute(string appId)
        {
            if (string.IsNullOrEmpty(appId) || !Factory()) return 0;
            int count = 0;
            var done = new List<int>();
            foreach (var entry in routed)
            {
                if (entry.Value.AppId != appId) continue;
                if (Set(entry.Key, null) >= 0) count++;
                if (entry.Value.Handle != IntPtr.Zero) CloseHandle(entry.Value.Handle);
                done.Add(entry.Key);
            }
            foreach (int processId in done) routed.Remove(processId);
            // Routed by an earlier run of the overlay: undo it for the app's running processes.
            foreach (int processId in AudioApps.ProcessIds(appId))
            {
                if (done.Contains(processId)) continue;
                if (Set(processId, null) >= 0) count++;
            }
            return count;
        }

        public static int UnrouteAll()
        {
            var apps = new List<string>();
            foreach (var entry in routed.Values) if (!apps.Contains(entry.AppId)) apps.Add(entry.AppId);
            int count = 0;
            foreach (string appId in apps) count += Unroute(appId);
            return count;
        }

        /// <summary>
        /// Apps whose routed process has quit since the last call. Their route is undone while the
        /// process id is still reserved by the handle, so the app starts on the default device next time.
        /// </summary>
        public static string[] TakeExited()
        {
            var exited = new List<string>();
            var done = new List<int>();
            foreach (var entry in routed)
            {
                IntPtr handle = entry.Value.Handle;
                if (handle == IntPtr.Zero || WaitForSingleObject(handle, 0) != 0) continue;
                try { Set(entry.Key, null); } catch { }
                CloseHandle(handle);
                done.Add(entry.Key);
                if (!exited.Contains(entry.Value.AppId)) exited.Add(entry.Value.AppId);
            }
            foreach (int processId in done) routed.Remove(processId);
            return exited.ToArray();
        }

        public static string[] RoutedApps()
        {
            var apps = new List<string>();
            foreach (var entry in routed.Values) if (!apps.Contains(entry.AppId)) apps.Add(entry.AppId);
            return apps.ToArray();
        }
    }
}
