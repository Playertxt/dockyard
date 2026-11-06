// Lookout Windows helper.
// Compiled at runtime by PowerShell (Add-Type) and driven over stdin/stdout.
// Protocol: one request per line  "<reqId> <command> <arg1> <arg2> ..."   (text args are base64 UTF-8)
//           one response per line "<reqId> <json>"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Lookout
{
    public static class Helper
    {
        // ------------------------------------------------------------------ Win32
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct PROCESSENTRY32W
        {
            public uint dwSize, cntUsage, th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID, cntThreads, th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_MEMORY_COUNTERS_EX
        {
            public uint cb, PageFaultCount;
            public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
                QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MIB_TCPROW { public uint state, localAddr, localPort, remoteAddr, remotePort; }

        [StructLayout(LayoutKind.Sequential)]
        public struct FILETIME { public uint Low, High; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct RM_PROCESS_INFO
        {
            public RM_UNIQUE_PROCESS Process;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
            public int ApplicationType;
            public uint AppStatus;
            public uint TSSessionId;
            [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int idx);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr value);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
        [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint action, uint param, out RECT r, uint winIni);
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
        [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
        [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern bool K32GetProcessMemoryInfo(IntPtr h, out PROCESS_MEMORY_COUNTERS_EX c, uint cb);
        [DllImport("kernel32.dll")] static extern bool GetProcessIoCounters(IntPtr h, out IO_COUNTERS c);
        [DllImport("kernel32.dll")] static extern bool GetProcessHandleCount(IntPtr h, out uint count);
        [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
        [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr h, uint cls);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
        [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
        [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int retLen);
        [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int cls, int reserved);
        [DllImport("iphlpapi.dll")] static extern uint GetExtendedUdpTable(IntPtr table, ref int size, bool order, int af, int cls, int reserved);
        [DllImport("iphlpapi.dll")] static extern uint SetPerTcpConnectionEStats(ref MIB_TCPROW row, int type, byte[] rw, uint ver, uint size, uint offset);
        [DllImport("iphlpapi.dll")] static extern uint GetPerTcpConnectionEStats(ref MIB_TCPROW row, int type, IntPtr rw, uint rwVer, uint rwSize, IntPtr ros, uint rosVer, uint rosSize, IntPtr rod, uint rodVer, uint rodSize);
        [DllImport("iphlpapi.dll")] static extern uint SetPerTcp6ConnectionEStats(IntPtr row, int type, byte[] rw, uint ver, uint size, uint offset);
        [DllImport("iphlpapi.dll")] static extern uint GetPerTcp6ConnectionEStats(IntPtr row, int type, IntPtr rw, uint rwVer, uint rwSize, IntPtr ros, uint rosVer, uint rosSize, IntPtr rod, uint rodVer, uint rodSize);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
        [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svc);
        [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);

        const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
        const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOPMOST = 0x8, WS_EX_LAYERED = 0x80000;
        const long WS_CHILD = 0x40000000, WS_CAPTION = 0xC00000;
        const uint GW_OWNER = 4;
        const int SW_HIDE = 0, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9, SW_MAXIMIZE = 3;
        const uint WM_CLOSE = 0x10;
        const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;

        static readonly HashSet<long> hiddenByUs = new HashSet<long>();
        static readonly Dictionary<long, int> alphaByUs = new Dictionary<long, int>();
        static readonly HashSet<long> layeredByUs = new HashSet<long>();
        static readonly HashSet<uint> suspendedByUs = new HashSet<uint>();
        static readonly Dictionary<uint, long[]> cpuPrev = new Dictionary<uint, long[]>();
        static readonly HashSet<uint> excludedPids = new HashSet<uint>();
        static readonly HashSet<string> estatsOn = new HashSet<string>();
        static long cpuPrevWall = 0;
        static long[] sysPrev = null;
        static bool? admin = null;
        static StreamWriter output;
        static readonly System.Globalization.CultureInfo IC = System.Globalization.CultureInfo.InvariantCulture;

        // ------------------------------------------------------------------ entry
        public static void Run()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            output.WriteLine("0 {\"ready\":true}");
            string line;
            while ((line = input.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                string result;
                try { result = Handle(parts); }
                catch (Exception e) { result = "{\"error\":" + Q(e.Message) + "}"; }
                output.WriteLine(parts[0] + " " + result);
                if (parts.Length > 1 && parts[1] == "quit") break;
            }
            Cleanup();
        }

        static long L(string[] p, int i) { return p.Length > i ? long.Parse(p[i]) : 0; }
        static int I(string[] p, int i) { return p.Length > i ? int.Parse(p[i]) : 0; }
        static IntPtr H(string[] p, int i) { return new IntPtr(L(p, i)); }
        static string S(string[] p, int i) { return p.Length > i ? Encoding.UTF8.GetString(Convert.FromBase64String(p[i])) : ""; }

        static string Handle(string[] p)
        {
            string cmd = p.Length > 1 ? p[1] : "";
            switch (cmd)
            {
                case "ping": return "{\"pong\":true}";
                case "exclude": for (int i = 2; i < p.Length; i++) excludedPids.Add(uint.Parse(p[i])); return "{\"ok\":true}";
                case "elevated": return "{\"admin\":" + B(IsAdmin()) + "}";
                case "sample": return Sample();
                case "windows": return Windows(p.Length > 2 && p[2] == "1");
                case "win": return WinAction(H(p, 2), p.Length > 3 ? p[3] : "", I(p, 4));
                case "kill": return Kill((uint)L(p, 2));
                case "killtree": return KillTree((uint)L(p, 2));
                case "priority": return SetPriority((uint)L(p, 2), p.Length > 3 ? p[3] : "normal");
                case "suspend": return Suspend((uint)L(p, 2), true);
                case "resume": return Suspend((uint)L(p, 2), false);
                case "resumeall": return ResumeAll();
                case "details": return Details((uint)L(p, 2));
                case "describe": return Describe(p);
                case "conns": return Connections();
                case "whofile": return WhoFile(S(p, 2));
                case "launch": return Launch(S(p, 2), S(p, 3));
                case "unhideall": return UnhideAll();
                case "quit": Cleanup(); return "{\"bye\":true}";
            }
            return "{\"error\":\"unknown command\"}";
        }

        static void Cleanup()
        {
            try { UnhideAll(); } catch { }
            try { ResumeAll(); } catch { }
        }

        // ------------------------------------------------------------------ JSON
        static string B(bool b) { return b ? "true" : "false"; }
        static string N(double d) { return d.ToString("0.##", IC); }
        static string Ok(bool b) { return "{\"ok\":" + B(b) + "}"; }
        static string Err(string msg) { return "{\"ok\":false,\"reason\":" + Q(msg) + "}"; }
        static string Q(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.Append("\\u" + ((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        static bool IsAdmin()
        {
            if (admin.HasValue) return admin.Value;
            try { admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
            catch { admin = false; }
            return admin.Value;
        }

        // ------------------------------------------------------------------ processes
        static List<PROCESSENTRY32W> Snapshot()
        {
            var list = new List<PROCESSENTRY32W>();
            IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return list;
            var e = new PROCESSENTRY32W();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snap, ref e))
                do { list.Add(e); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W)); } while (Process32NextW(snap, ref e));
            CloseHandle(snap);
            return list;
        }

        static string PriorityName(uint c)
        {
            switch (c)
            {
                case 0x40: return "idle";
                case 0x4000: return "below";
                case 0x20: return "normal";
                case 0x8000: return "above";
                case 0x80: return "high";
                case 0x100: return "realtime";
            }
            return "";
        }

        static long FileTimeToUnixMs(long ft) { return ft <= 0 ? 0 : (ft - 116444736000000000L) / 10000; }

        class WinInfo { public int count; public bool hung; public string title; }

        // Visible app windows per process (for "not responding" and window counts).
        static Dictionary<uint, WinInfo> WindowsByPid()
        {
            var map = new Dictionary<uint, WinInfo>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsAppWindow(h)) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                ResolveHost(h, ref pid);
                WinInfo wi;
                if (!map.TryGetValue(pid, out wi)) map[pid] = wi = new WinInfo();
                wi.count++;
                if (IsHungAppWindow(h)) wi.hung = true;
                if (wi.title == null) wi.title = WindowTitle(h);
                return true;
            }, IntPtr.Zero);
            return map;
        }

        static string Sample()
        {
            var list = Snapshot();
            var wins = WindowsByPid();
            long wall = DateTime.UtcNow.Ticks;
            double wallDelta = cpuPrevWall > 0 ? (wall - cpuPrevWall) : 0;
            int cpus = Environment.ProcessorCount;
            uint mySession;
            ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out mySession);
            var next = new Dictionary<uint, long[]>();
            var sb = new StringBuilder(64 * 1024);

            // whole-system CPU
            double sysCpu = 0;
            long idle, kern, usr;
            if (GetSystemTimes(out idle, out kern, out usr))
            {
                if (sysPrev != null)
                {
                    double dIdle = idle - sysPrev[0], dTotal = (kern - sysPrev[1]) + (usr - sysPrev[2]);
                    if (dTotal > 0) sysCpu = Math.Max(0, Math.Min(100, (1 - dIdle / dTotal) * 100));
                }
                sysPrev = new long[] { idle, kern, usr };
            }

            // network totals
            long rx = 0, tx = 0;
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
                    var st = ni.GetIPStatistics();
                    rx += st.BytesReceived;
                    tx += st.BytesSent;
                }
            }
            catch { }

            sb.Append("{\"t\":").Append(FileTimeToUnixMs(DateTime.UtcNow.ToFileTimeUtc()))
              .Append(",\"cpus\":").Append(cpus)
              .Append(",\"cpu\":").Append(N(sysCpu))
              .Append(",\"rx\":").Append(rx).Append(",\"tx\":").Append(tx)
              .Append(",\"admin\":").Append(B(IsAdmin()))
              .Append(",\"procs\":[");
            bool first = true;
            foreach (var e in list)
            {
                uint pid = e.th32ProcessID;
                if (pid == 0) continue;
                double cpu = -1;
                long ws = -1, priv = -1, start = 0;
                ulong io = 0, ior = 0, iow = 0;
                uint handles = 0;
                string pri = "", exe = "";
                IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
                if (h != IntPtr.Zero)
                {
                    long cr, ex, k, u;
                    if (GetProcessTimes(h, out cr, out ex, out k, out u))
                    {
                        start = FileTimeToUnixMs(cr);
                        long total = k + u;
                        next[pid] = new long[] { cr, total };
                        long[] prev;
                        if (wallDelta > 0 && cpuPrev.TryGetValue(pid, out prev) && prev[0] == cr)
                            cpu = Math.Max(0, Math.Min(100, (total - prev[1]) * 100.0 / (wallDelta * cpus)));
                        else cpu = 0;
                    }
                    PROCESS_MEMORY_COUNTERS_EX mc;
                    if (K32GetProcessMemoryInfo(h, out mc, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS_EX))))
                    {
                        ws = (long)mc.WorkingSetSize.ToUInt64();
                        priv = (long)mc.PrivateUsage.ToUInt64();
                    }
                    IO_COUNTERS ioc;
                    if (GetProcessIoCounters(h, out ioc)) { ior = ioc.ReadBytes; iow = ioc.WriteBytes; io = ioc.ReadBytes + ioc.WriteBytes + ioc.OtherBytes; }
                    GetProcessHandleCount(h, out handles);
                    pri = PriorityName(GetPriorityClass(h));
                    var path = new StringBuilder(1024);
                    int size = path.Capacity;
                    if (QueryFullProcessImageNameW(h, 0, path, ref size)) exe = path.ToString();
                    CloseHandle(h);
                }
                uint session;
                bool user = ProcessIdToSessionId(pid, out session) && session == mySession && session != 0;
                WinInfo wi;
                wins.TryGetValue(pid, out wi);
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"pid\":").Append(pid)
                  .Append(",\"ppid\":").Append(e.th32ParentProcessID)
                  .Append(",\"name\":").Append(Q(e.szExeFile))
                  .Append(",\"exe\":").Append(Q(exe))
                  .Append(",\"start\":").Append(start)
                  .Append(",\"threads\":").Append(e.cntThreads)
                  .Append(",\"handles\":").Append(handles)
                  .Append(",\"cpu\":").Append(N(cpu))
                  .Append(",\"mem\":").Append(ws)
                  .Append(",\"priv\":").Append(priv)
                  .Append(",\"io\":").Append(io)
                  .Append(",\"ior\":").Append(ior)
                  .Append(",\"iow\":").Append(iow)
                  .Append(",\"priority\":").Append(Q(pri))
                  .Append(",\"user\":").Append(B(user))
                  .Append(",\"suspended\":").Append(B(suspendedByUs.Contains(pid)))
                  .Append(",\"self\":").Append(B(excludedPids.Contains(pid)))
                  .Append(",\"windows\":").Append(wi == null ? 0 : wi.count)
                  .Append(",\"hung\":").Append(B(wi != null && wi.hung))
                  .Append(",\"title\":").Append(Q(wi == null ? null : wi.title))
                  .Append('}');
            }
            cpuPrev.Clear();
            foreach (var kv in next) cpuPrev[kv.Key] = kv.Value;
            cpuPrevWall = wall;
            suspendedByUs.RemoveWhere(x => !next.ContainsKey(x));
            sb.Append("]}");
            return sb.ToString();
        }

        static string CommandLine(uint pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                int len;
                NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len); // ProcessCommandLineInformation
                if (len <= 0 || len > 1 << 20) return null;
                IntPtr buf = Marshal.AllocHGlobal(len);
                try
                {
                    if (NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
                    int chars = (ushort)Marshal.ReadInt16(buf) / 2;
                    IntPtr str = Marshal.ReadIntPtr(buf, IntPtr.Size);
                    return str == IntPtr.Zero ? "" : Marshal.PtrToStringUni(str, chars);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally { CloseHandle(h); }
        }

        static string Details(uint pid)
        {
            string cmd = CommandLine(pid);
            string exe = "";
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h != IntPtr.Zero)
            {
                var path = new StringBuilder(1024);
                int size = path.Capacity;
                if (QueryFullProcessImageNameW(h, 0, path, ref size)) exe = path.ToString();
                CloseHandle(h);
            }
            return "{\"pid\":" + pid + ",\"cmd\":" + Q(cmd) + ",\"exe\":" + Q(exe) + "}";
        }

        // File description / company for a batch of exe paths (base64 args).
        static string Describe(string[] p)
        {
            var sb = new StringBuilder("{\"items\":[");
            for (int i = 2; i < p.Length; i++)
            {
                string path = S(p, i);
                string desc = "", company = "", product = "", version = "";
                try
                {
                    if (File.Exists(path))
                    {
                        var v = FileVersionInfo.GetVersionInfo(path);
                        desc = v.FileDescription ?? ""; company = v.CompanyName ?? ""; product = v.ProductName ?? ""; version = v.FileVersion ?? "";
                    }
                }
                catch { }
                if (i > 2) sb.Append(',');
                sb.Append("{\"path\":").Append(Q(path)).Append(",\"desc\":").Append(Q(desc.Trim())).Append(",\"company\":").Append(Q(company.Trim()))
                  .Append(",\"product\":").Append(Q(product.Trim())).Append(",\"version\":").Append(Q(version.Trim())).Append('}');
            }
            return sb.Append("]}").ToString();
        }

        static string Kill(uint pid)
        {
            if (pid == 0 || pid == 4) return Err("That's a core Windows process.");
            if (excludedPids.Contains(pid)) return Err("Lookout won't end itself.");
            IntPtr h = OpenProcess(0x1, false, pid); // PROCESS_TERMINATE
            if (h == IntPtr.Zero) return Err("Access denied. Try Restart as administrator.");
            bool ok = TerminateProcess(h, 1);
            int errno = Marshal.GetLastWin32Error();
            CloseHandle(h);
            return ok ? "{\"ok\":true}" : Err("Windows refused (error " + errno + ").");
        }

        static string KillTree(uint root)
        {
            var list = Snapshot();
            var kids = new Dictionary<uint, List<uint>>();
            foreach (var e in list)
            {
                if (e.th32ProcessID == e.th32ParentProcessID) continue;
                List<uint> l;
                if (!kids.TryGetValue(e.th32ParentProcessID, out l)) kids[e.th32ParentProcessID] = l = new List<uint>();
                l.Add(e.th32ProcessID);
            }
            var order = new List<uint>();
            var seen = new HashSet<uint>();
            var stack = new Stack<uint>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                uint x = stack.Pop();
                if (!seen.Add(x)) continue;
                order.Add(x);
                List<uint> l;
                if (kids.TryGetValue(x, out l)) foreach (var c in l) stack.Push(c);
            }
            order.Reverse();
            int killed = 0, failed = 0;
            foreach (var x in order)
            {
                if (excludedPids.Contains(x)) { failed++; continue; }
                if (Kill(x).StartsWith("{\"ok\":true")) killed++; else failed++;
            }
            return "{\"ok\":" + B(killed > 0) + ",\"killed\":" + killed + ",\"failed\":" + failed + (killed == 0 ? ",\"reason\":\"Access denied.\"" : "") + "}";
        }

        static string SetPriority(uint pid, string name)
        {
            uint cls;
            switch (name)
            {
                case "idle": cls = 0x40; break;
                case "below": cls = 0x4000; break;
                case "above": cls = 0x8000; break;
                case "high": cls = 0x80; break;
                default: cls = 0x20; break;
            }
            IntPtr h = OpenProcess(0x200, false, pid); // PROCESS_SET_INFORMATION
            if (h == IntPtr.Zero) return Err("Access denied.");
            bool ok = SetPriorityClass(h, cls);
            CloseHandle(h);
            return ok ? "{\"ok\":true}" : Err("Windows refused.");
        }

        static string Suspend(uint pid, bool suspend)
        {
            if (excludedPids.Contains(pid)) return Err("Lookout won't pause itself.");
            IntPtr h = OpenProcess(0x800, false, pid); // PROCESS_SUSPEND_RESUME
            if (h == IntPtr.Zero) return Err("Access denied.");
            int st = suspend ? NtSuspendProcess(h) : NtResumeProcess(h);
            CloseHandle(h);
            if (st != 0) return Err("Windows refused (status " + st + ").");
            if (suspend) suspendedByUs.Add(pid); else suspendedByUs.Remove(pid);
            return "{\"ok\":true}";
        }

        static string ResumeAll()
        {
            int n = 0;
            foreach (var pid in new List<uint>(suspendedByUs)) if (Suspend(pid, false).StartsWith("{\"ok\":true")) n++;
            suspendedByUs.Clear();
            return "{\"ok\":true,\"resumed\":" + n + "}";
        }

        static string Launch(string cmd, string cwd)
        {
            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            PROCESS_INFORMATION pi;
            if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd)) cwd = null;
            // CREATE_NEW_CONSOLE so console apps get their own window; GUI apps ignore it.
            bool ok = CreateProcessW(null, new StringBuilder(cmd, cmd.Length + 1), IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, cwd, ref si, out pi);
            if (!ok) return Err("Couldn't start it (error " + Marshal.GetLastWin32Error() + ").");
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return "{\"ok\":true,\"pid\":" + pi.dwProcessId + "}";
        }

        // ------------------------------------------------------------------ who is using a file
        static string WhoFile(string path)
        {
            var files = new List<string>();
            if (Directory.Exists(path))
            {
                try
                {
                    var stack = new Stack<string>();
                    stack.Push(path);
                    while (stack.Count > 0 && files.Count < 3000)
                    {
                        string d = stack.Pop();
                        try { foreach (var f in Directory.GetFiles(d)) { files.Add(f); if (files.Count >= 3000) break; } } catch { }
                        try { foreach (var s in Directory.GetDirectories(d)) stack.Push(s); } catch { }
                    }
                }
                catch { }
            }
            else if (File.Exists(path)) files.Add(path);
            else return Err("That file or folder doesn't exist.");
            if (files.Count == 0) return "{\"ok\":true,\"files\":0,\"procs\":[]}";

            uint handle;
            var key = new StringBuilder(64);
            int rc = RmStartSession(out handle, 0, key);
            if (rc != 0) return Err("Restart Manager failed (" + rc + ").");
            try
            {
                var sb = new StringBuilder("{\"ok\":true,\"files\":" + files.Count + ",\"procs\":[");
                bool first = true;
                for (int start = 0; start < files.Count; start += 500)
                {
                    var chunk = files.GetRange(start, Math.Min(500, files.Count - start)).ToArray();
                    rc = RmRegisterResources(handle, (uint)chunk.Length, chunk, 0, null, 0, null);
                    if (rc != 0) return Err("Couldn't check those files (" + rc + ").");
                }
                uint needed, count = 0, reasons = 0;
                RM_PROCESS_INFO[] info = null;
                rc = RmGetList(handle, out needed, ref count, null, ref reasons);
                if (rc == 234) // ERROR_MORE_DATA
                {
                    count = needed;
                    info = new RM_PROCESS_INFO[needed];
                    rc = RmGetList(handle, out needed, ref count, info, ref reasons);
                }
                if (rc != 0 && rc != 234) return Err("Couldn't list users of that file (" + rc + ").");
                if (info != null)
                {
                    for (int i = 0; i < count; i++)
                    {
                        var r = info[i];
                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append("{\"pid\":").Append(r.Process.dwProcessId)
                          .Append(",\"app\":").Append(Q(r.strAppName))
                          .Append(",\"service\":").Append(Q(r.strServiceShortName))
                          .Append(",\"type\":").Append(r.ApplicationType).Append('}');
                    }
                }
                return sb.Append("]}").ToString();
            }
            finally { RmEndSession(handle); }
        }

        // ------------------------------------------------------------------ network connections
        static int Port(uint p) { return (int)(((p & 0xFF) << 8) | ((p >> 8) & 0xFF)); }
        static string Ip4(uint a) { return (a & 0xFF) + "." + ((a >> 8) & 0xFF) + "." + ((a >> 16) & 0xFF) + "." + ((a >> 24) & 0xFF); }
        static string Ip6(byte[] b)
        {
            try { return new System.Net.IPAddress(b).ToString(); } catch { return "?"; }
        }

        static IntPtr Table(bool tcp, int af, int cls)
        {
            int size = 0;
            if (tcp) GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, cls, 0);
            else GetExtendedUdpTable(IntPtr.Zero, ref size, false, af, cls, 0);
            for (int tries = 0; tries < 4; tries++)
            {
                size += 4096;
                IntPtr buf = Marshal.AllocHGlobal(size);
                uint rc = tcp ? GetExtendedTcpTable(buf, ref size, false, af, cls, 0) : GetExtendedUdpTable(buf, ref size, false, af, cls, 0);
                if (rc == 0) return buf;
                Marshal.FreeHGlobal(buf);
                if (rc != 122) break; // ERROR_INSUFFICIENT_BUFFER
            }
            return IntPtr.Zero;
        }

        static readonly string[] TcpStates = { "", "closed", "listen", "syn-sent", "syn-received", "established", "fin-wait-1", "fin-wait-2", "close-wait", "closing", "last-ack", "time-wait", "delete-tcb" };

        // Per-connection byte counters (TCP only, needs administrator).
        static bool Estats4(MIB_TCPROW row, string key, out ulong inB, out ulong outB)
        {
            inB = outB = 0;
            if (!estatsOn.Contains(key))
            {
                SetPerTcpConnectionEStats(ref row, 1, new byte[] { 1 }, 0, 1, 0);
                estatsOn.Add(key);
            }
            IntPtr rod = Marshal.AllocHGlobal(96);
            try
            {
                if (GetPerTcpConnectionEStats(ref row, 1, IntPtr.Zero, 0, 0, IntPtr.Zero, 0, 0, rod, 0, 96) != 0) return false;
                outB = (ulong)Marshal.ReadInt64(rod, 0);
                inB = (ulong)Marshal.ReadInt64(rod, 16);
                return true;
            }
            finally { Marshal.FreeHGlobal(rod); }
        }

        static bool Estats6(IntPtr row, string key, out ulong inB, out ulong outB)
        {
            inB = outB = 0;
            if (!estatsOn.Contains(key))
            {
                SetPerTcp6ConnectionEStats(row, 1, new byte[] { 1 }, 0, 1, 0);
                estatsOn.Add(key);
            }
            IntPtr rod = Marshal.AllocHGlobal(96);
            try
            {
                if (GetPerTcp6ConnectionEStats(row, 1, IntPtr.Zero, 0, 0, IntPtr.Zero, 0, 0, rod, 0, 96) != 0) return false;
                outB = (ulong)Marshal.ReadInt64(rod, 0);
                inB = (ulong)Marshal.ReadInt64(rod, 16);
                return true;
            }
            finally { Marshal.FreeHGlobal(rod); }
        }

        static string Connections()
        {
            bool adm = IsAdmin();
            var sb = new StringBuilder(32 * 1024);
            sb.Append("{\"admin\":").Append(B(adm)).Append(",\"conns\":[");
            bool first = true;
            var live = new HashSet<string>();

            // TCP over IPv4: rows of 6 DWORDs.
            IntPtr t = Table(true, 2, 5);
            if (t != IntPtr.Zero)
            {
                int n = Marshal.ReadInt32(t);
                for (int i = 0; i < n; i++)
                {
                    IntPtr r = new IntPtr(t.ToInt64() + 4 + i * 24);
                    var row = new MIB_TCPROW
                    {
                        state = (uint)Marshal.ReadInt32(r, 0),
                        localAddr = (uint)Marshal.ReadInt32(r, 4),
                        localPort = (uint)Marshal.ReadInt32(r, 8),
                        remoteAddr = (uint)Marshal.ReadInt32(r, 12),
                        remotePort = (uint)Marshal.ReadInt32(r, 16)
                    };
                    uint pid = (uint)Marshal.ReadInt32(r, 20);
                    string la = Ip4(row.localAddr), ra = Ip4(row.remoteAddr);
                    int lp = Port(row.localPort), rp = Port(row.remotePort);
                    ulong inB = 0, outB = 0;
                    bool have = false;
                    string key = "4|" + la + ":" + lp + "|" + ra + ":" + rp;
                    if (adm && row.state == 5) { live.Add(key); have = Estats4(row, key, out inB, out outB); }
                    if (!first) sb.Append(',');
                    first = false;
                    AppendConn(sb, pid, "tcp", la, lp, ra, rp, row.state < TcpStates.Length ? TcpStates[row.state] : "", have, inB, outB);
                }
                Marshal.FreeHGlobal(t);
            }

            // TCP over IPv6: 16+4+4+16+4+4+4+4 = 56 bytes per row.
            t = Table(true, 23, 5);
            if (t != IntPtr.Zero)
            {
                int n = Marshal.ReadInt32(t);
                IntPtr row6 = Marshal.AllocHGlobal(52);
                for (int i = 0; i < n; i++)
                {
                    IntPtr r = new IntPtr(t.ToInt64() + 4 + i * 56);
                    byte[] lab = new byte[16], rab = new byte[16];
                    Marshal.Copy(r, lab, 0, 16);
                    Marshal.Copy(new IntPtr(r.ToInt64() + 24), rab, 0, 16);
                    uint lscope = (uint)Marshal.ReadInt32(r, 16), lport = (uint)Marshal.ReadInt32(r, 20);
                    uint rscope = (uint)Marshal.ReadInt32(r, 40), rport = (uint)Marshal.ReadInt32(r, 44);
                    uint state = (uint)Marshal.ReadInt32(r, 48), pid = (uint)Marshal.ReadInt32(r, 52);
                    string la = Ip6(lab), ra = Ip6(rab);
                    int lp = Port(lport), rp = Port(rport);
                    ulong inB = 0, outB = 0;
                    bool have = false;
                    string key = "6|" + la + ":" + lp + "|" + ra + ":" + rp;
                    if (adm && state == 5)
                    {
                        // MIB_TCP6ROW: State, LocalAddr[16], LocalScopeId, LocalPort, RemoteAddr[16], RemoteScopeId, RemotePort
                        Marshal.WriteInt32(row6, 0, (int)state);
                        Marshal.Copy(lab, 0, new IntPtr(row6.ToInt64() + 4), 16);
                        Marshal.WriteInt32(row6, 20, (int)lscope);
                        Marshal.WriteInt32(row6, 24, (int)lport);
                        Marshal.Copy(rab, 0, new IntPtr(row6.ToInt64() + 28), 16);
                        Marshal.WriteInt32(row6, 44, (int)rscope);
                        Marshal.WriteInt32(row6, 48, (int)rport);
                        live.Add(key);
                        have = Estats6(row6, key, out inB, out outB);
                    }
                    if (!first) sb.Append(',');
                    first = false;
                    AppendConn(sb, pid, "tcp6", la, lp, ra, rp, state < TcpStates.Length ? TcpStates[state] : "", have, inB, outB);
                }
                Marshal.FreeHGlobal(row6);
                Marshal.FreeHGlobal(t);
            }

            // UDP (IPv4: 12-byte rows, IPv6: 28-byte rows)
            t = Table(false, 2, 1);
            if (t != IntPtr.Zero)
            {
                int n = Marshal.ReadInt32(t);
                for (int i = 0; i < n; i++)
                {
                    IntPtr r = new IntPtr(t.ToInt64() + 4 + i * 12);
                    if (!first) sb.Append(',');
                    first = false;
                    AppendConn(sb, (uint)Marshal.ReadInt32(r, 8), "udp", Ip4((uint)Marshal.ReadInt32(r, 0)), Port((uint)Marshal.ReadInt32(r, 4)), "", 0, "", false, 0, 0);
                }
                Marshal.FreeHGlobal(t);
            }
            t = Table(false, 23, 1);
            if (t != IntPtr.Zero)
            {
                int n = Marshal.ReadInt32(t);
                for (int i = 0; i < n; i++)
                {
                    IntPtr r = new IntPtr(t.ToInt64() + 4 + i * 28);
                    byte[] lab = new byte[16];
                    Marshal.Copy(r, lab, 0, 16);
                    if (!first) sb.Append(',');
                    first = false;
                    AppendConn(sb, (uint)Marshal.ReadInt32(r, 24), "udp6", Ip6(lab), Port((uint)Marshal.ReadInt32(r, 20)), "", 0, "", false, 0, 0);
                }
                Marshal.FreeHGlobal(t);
            }
            estatsOn.RemoveWhere(k => !live.Contains(k));
            return sb.Append("]}").ToString();
        }

        static void AppendConn(StringBuilder sb, uint pid, string proto, string la, int lp, string ra, int rp, string state, bool have, ulong inB, ulong outB)
        {
            sb.Append("{\"pid\":").Append(pid).Append(",\"proto\":\"").Append(proto).Append('"')
              .Append(",\"la\":").Append(Q(la)).Append(",\"lp\":").Append(lp)
              .Append(",\"ra\":").Append(Q(ra)).Append(",\"rp\":").Append(rp)
              .Append(",\"state\":\"").Append(state).Append('"');
            if (have) sb.Append(",\"in\":").Append(inB).Append(",\"out\":").Append(outB);
            sb.Append('}');
        }

        // ------------------------------------------------------------------ windows
        static string ExePath(uint pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return "";
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            string path = QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString() : "";
            CloseHandle(h);
            return path;
        }

        static string ClassName(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetClassNameW(h, sb, sb.Capacity);
            return sb.ToString();
        }

        static string WindowTitle(IntPtr h)
        {
            int len = GetWindowTextLengthW(h);
            var title = new StringBuilder(len + 2);
            GetWindowTextW(h, title, title.Capacity);
            return title.ToString();
        }

        static bool IsCloaked(IntPtr h)
        {
            int cloaked;
            try { if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0) return cloaked != 0; } catch { }
            return false;
        }

        static bool ShellClass(string cls)
        {
            return cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "IME" || cls == "MSCTFIME UI";
        }

        // A window that would appear on the taskbar.
        static bool IsAppWindow(IntPtr h)
        {
            if (!IsWindowVisible(h)) return false;
            if (GetWindowTextLengthW(h) == 0) return false;
            long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
            long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
            if ((style & WS_CHILD) != 0) return false;
            bool appWindow = (ex & WS_EX_APPWINDOW) != 0;
            if ((ex & WS_EX_TOOLWINDOW) != 0 && !appWindow) return false;
            if ((ex & WS_EX_NOACTIVATE) != 0 && !appWindow) return false;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero && !appWindow) return false;
            if (IsCloaked(h)) return false;
            return !ShellClass(ClassName(h));
        }

        // UWP apps are hosted by ApplicationFrameHost; find the real process.
        static string ResolveHost(IntPtr h, ref uint pid)
        {
            string exe = ExePath(pid);
            if (!exe.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return exe;
            uint hostPid = pid, found = pid;
            EnumChildWindows(h, delegate (IntPtr c, IntPtr l2)
            {
                uint cpid;
                GetWindowThreadProcessId(c, out cpid);
                if (cpid != hostPid) { found = cpid; return false; }
                return true;
            }, IntPtr.Zero);
            pid = found;
            return ExePath(pid);
        }

        static int Alpha(IntPtr h, long ex)
        {
            int a;
            if (alphaByUs.TryGetValue(h.ToInt64(), out a)) return a * 255 / 100;
            if ((ex & WS_EX_LAYERED) == 0) return 255;
            uint key, flags; byte alpha;
            if (GetLayeredWindowAttributes(h, out key, out alpha, out flags) && (flags & 2) != 0) return alpha;
            return 255;
        }

        // includeInvisible: also report hidden windows that look like normal app windows (for the hidden-window finder).
        static string Windows(bool includeInvisible)
        {
            var sb = new StringBuilder(32 * 1024);
            sb.Append("{\"foreground\":").Append(GetForegroundWindow().ToInt64()).Append(",\"windows\":[");
            bool first = true;
            var seen = new HashSet<long>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                long key = h.ToInt64();
                bool ours = hiddenByUs.Contains(key);
                bool visible = IsWindowVisible(h);
                if (GetWindowTextLengthW(h) == 0) return true;
                long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
                if ((style & WS_CHILD) != 0) return true;
                string cls = ClassName(h);
                if (ShellClass(cls)) return true;
                long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
                bool cloaked = IsCloaked(h);
                bool owned = GetWindow(h, GW_OWNER) != IntPtr.Zero;
                bool tool = (ex & WS_EX_TOOLWINDOW) != 0;
                bool appLike = (style & WS_CAPTION) == WS_CAPTION && !owned && !tool;
                if (!visible && !ours && !(includeInvisible && appLike)) return true;
                if (cloaked && !ours) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (excludedPids.Contains(pid)) return true;
                string exe = ResolveHost(h, ref pid);
                RECT r;
                GetWindowRect(h, out r);
                bool iconic = IsIconic(h);
                bool offscreen = visible && !iconic && MonitorFromRect(ref r, 0) == IntPtr.Zero;
                seen.Add(key);
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"id\":").Append(key)
                  .Append(",\"title\":").Append(Q(WindowTitle(h)))
                  .Append(",\"pid\":").Append(pid)
                  .Append(",\"exe\":").Append(Q(exe))
                  .Append(",\"cls\":").Append(Q(cls))
                  .Append(",\"visible\":").Append(B(visible))
                  .Append(",\"ours\":").Append(B(ours))
                  .Append(",\"taskbar\":").Append(B(!ours && IsAppWindow(h)))
                  .Append(",\"appLike\":").Append(B(appLike))
                  .Append(",\"minimized\":").Append(B(iconic))
                  .Append(",\"maximized\":").Append(B(IsZoomed(h)))
                  .Append(",\"topmost\":").Append(B((ex & WS_EX_TOPMOST) != 0))
                  .Append(",\"hung\":").Append(B(IsHungAppWindow(h)))
                  .Append(",\"offscreen\":").Append(B(offscreen))
                  .Append(",\"alpha\":").Append(Alpha(h, ex))
                  .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
                  .Append(",\"w\":").Append(r.Right - r.Left).Append(",\"h\":").Append(r.Bottom - r.Top)
                  .Append('}');
                return true;
            }, IntPtr.Zero);
            hiddenByUs.RemoveWhere(k => !seen.Contains(k) && !IsWindow(new IntPtr(k)));
            return sb.Append("]}").ToString();
        }

        static string WinAction(IntPtr h, string action, int arg)
        {
            if (!IsWindow(h)) return Err("That window has closed.");
            switch (action)
            {
                case "focus": return Ok(Activate(h));
                case "minimize": return Ok(ShowWindow(h, SW_MINIMIZE));
                case "maximize": return Ok(ShowWindow(h, SW_MAXIMIZE));
                case "restore": return Ok(ShowWindow(h, SW_RESTORE));
                case "close": return Ok(PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero));
                case "topmost":
                    {
                        bool now = (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & WS_EX_TOPMOST) != 0;
                        bool want = arg == 1 ? true : arg == 0 ? false : !now;
                        SetWindowPos(h, new IntPtr(want ? -1 : -2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                        bool got = (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & WS_EX_TOPMOST) != 0;
                        if (got != want) return Err("Windows didn't allow that right now. Click Lookout's window first so it's in front, then try again.");
                        return "{\"ok\":true,\"topmost\":" + B(want) + "}";
                    }
                case "opacity": return Ok(Opacity(h, arg));
                case "hide": hiddenByUs.Add(h.ToInt64()); ShowWindow(h, SW_HIDE); return Ok(true);
                case "show": hiddenByUs.Remove(h.ToInt64()); ShowWindow(h, SW_SHOW); return Ok(Activate(h));
                case "bringback": return Ok(BringBack(h));
            }
            return Err("Unknown action.");
        }

        static bool Opacity(IntPtr h, int pct)
        {
            long key = h.ToInt64();
            long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
            if (pct >= 100)
            {
                alphaByUs.Remove(key);
                if (layeredByUs.Remove(key)) SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(ex & ~WS_EX_LAYERED));
                else if ((ex & WS_EX_LAYERED) != 0) SetLayeredWindowAttributes(h, 0, 255, 2);
                return true;
            }
            pct = Math.Max(15, pct);
            if ((ex & WS_EX_LAYERED) == 0)
            {
                SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(ex | WS_EX_LAYERED));
                layeredByUs.Add(key);
            }
            alphaByUs[key] = pct;
            return SetLayeredWindowAttributes(h, 0, (byte)(pct * 255 / 100), 2);
        }

        // Makes a lost window usable again: shown, opaque, restored and centred on the main screen.
        static bool BringBack(IntPtr h)
        {
            hiddenByUs.Remove(h.ToInt64());
            if (!IsWindowVisible(h)) ShowWindow(h, SW_SHOW);
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
            if (Alpha(h, ex) < 255) { alphaByUs.Remove(h.ToInt64()); SetLayeredWindowAttributes(h, 0, 255, 2); }
            RECT r, wa;
            GetWindowRect(h, out r);
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (!SystemParametersInfoW(0x30, 0, out wa, 0)) { wa.Left = 0; wa.Top = 0; wa.Right = 1280; wa.Bottom = 720; }
            int waW = wa.Right - wa.Left, waH = wa.Bottom - wa.Top;
            bool tiny = w < 120 || hh < 80;
            if (tiny) { w = Math.Min(900, waW); hh = Math.Min(600, waH); }
            w = Math.Min(w, waW); hh = Math.Min(hh, waH);
            bool off = MonitorFromRect(ref r, 0) == IntPtr.Zero;
            if (off || tiny)
                SetWindowPos(h, IntPtr.Zero, wa.Left + (waW - w) / 2, wa.Top + (waH - hh) / 2, w, hh, SWP_NOZORDER | SWP_NOACTIVATE);
            return Activate(h);
        }

        static string UnhideAll()
        {
            int n = 0;
            foreach (long k in new List<long>(hiddenByUs)) { IntPtr h = new IntPtr(k); if (IsWindow(h)) { ShowWindow(h, SW_SHOW); n++; } }
            hiddenByUs.Clear();
            foreach (long k in new List<long>(alphaByUs.Keys)) { IntPtr h = new IntPtr(k); if (IsWindow(h)) Opacity(h, 100); }
            alphaByUs.Clear();
            return "{\"ok\":true,\"shown\":" + n + "}";
        }

        static bool Activate(IntPtr h)
        {
            if (!IsWindow(h)) return false;
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE); else ShowWindow(h, SW_SHOW);
            keybd_event(0x12, 0, 0, UIntPtr.Zero); // a tap of Alt lets us take the foreground legally
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            IntPtr fg = GetForegroundWindow();
            uint dummy;
            uint fgThread = GetWindowThreadProcessId(fg, out dummy);
            uint me = GetCurrentThreadId();
            bool attached = false;
            if (fgThread != me && fgThread != 0) attached = AttachThreadInput(me, fgThread, true);
            BringWindowToTop(h);
            bool ok = SetForegroundWindow(h);
            if (attached) AttachThreadInput(me, fgThread, false);
            return ok;
        }
    }
}
