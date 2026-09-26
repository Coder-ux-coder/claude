using System.Drawing;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Jarvis.Contracts;

namespace Jarvis.SessionAgent;

/// <summary>
/// Session Agent v0 (13 §18.3 M1), in your desktop session, on the raw Win32 API: a hidden
/// top-level window receives hotkeys (emergency stop handled locally first, push-to-talk),
/// lock/unlock (WTS session notifications) and suspend/resume (power broadcasts); it shows
/// tray notifications and captures the screen on request. No input injection until M2.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class Agent
{
    private const uint WM_HOTKEY = 0x0312, WM_WTSSESSION_CHANGE = 0x02B1, WM_POWERBROADCAST = 0x0218, WM_DESTROY = 0x0002;
    private const int HOTKEY_STOP = 1, HOTKEY_PTT = 2;
    private const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;
    private readonly string _secret;
    private JsonRpcChannel? _core;
    private volatile bool _halted;
    private IntPtr _hwnd;
    private readonly WndProcDelegate _proc;
    private Timer? _pttPoll;

    public Agent(string secret) { _secret = secret; _proc = WndProc; }

    public int Run()
    {
        var hInst = GetModuleHandle(null);
        var wc = new WNDCLASSEX { cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(), lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc), hInstance = hInst, lpszClassName = "JarvisSessionAgent" };
        if (RegisterClassEx(ref wc) == 0) return 3;
        _hwnd = CreateWindowEx(0, "JarvisSessionAgent", "JARVIS Session Agent", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, hInst, IntPtr.Zero);   // top-level, never shown: receives broadcasts
        if (_hwnd == IntPtr.Zero) return 4;
        if (!RegisterHotKey(_hwnd, HOTKEY_STOP, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, 0x13))   // Ctrl+Alt+Shift+Pause
            Console.Error.WriteLine("jarvis-session: the emergency-stop hotkey is taken by another app; use the tray or Console stop");
        if (!RegisterHotKey(_hwnd, HOTKEY_PTT, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x20))                // Ctrl+Alt+Space (hold)
            Console.Error.WriteLine("jarvis-session: the push-to-talk hotkey is taken by another app");
        WTSRegisterSessionNotification(_hwnd, 0 /* NOTIFY_FOR_THIS_SESSION */);
        Tray.Add(_hwnd);
        _ = Task.Run(ConnectLoopAsync);
        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
        Tray.Remove(_hwnd);
        return 0;
    }

    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        switch (msg)
        {
            case WM_HOTKEY when wParam == HOTKEY_STOP:
                _halted = true;   // local first: stop immediately, then tell the Coordinator (04 §10.15)
                Tray.Balloon(_hwnd, "JARVIS", "Emergency stop: all automation halted.");
                _ = Notify("hotkey.emergency_stop", new { at = DateTimeOffset.UtcNow });
                break;
            case WM_HOTKEY when wParam == HOTKEY_PTT:
                _ = Notify("hotkey.ptt_down", new { });
                _pttPoll?.Dispose();
                _pttPoll = new Timer(_ => { if ((GetAsyncKeyState(0x20) & 0x8000) == 0) { _pttPoll?.Dispose(); _pttPoll = null; _ = Notify("hotkey.ptt_up", new { }); } }, null, 30, 30);
                break;
            case WM_WTSSESSION_CHANGE:
            {
                var ev = (int)wParam switch { 7 => "session.lock", 8 => "session.unlock", 1 or 3 => "session.connect", 2 or 4 => "session.disconnect", _ => null };
                if (ev != null) _ = Notify(ev, new { at = DateTimeOffset.UtcNow });
                break;
            }
            case WM_POWERBROADCAST:
            {
                var ev = (int)wParam switch { 4 => "power.suspend", 0x12 => "power.resume", _ => null };
                if (ev != null) _ = Notify(ev, new { at = DateTimeOffset.UtcNow });
                break;
            }
            case WM_DESTROY: PostQuitMessage(0); break;
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    private async Task Notify(string method, object payload)
    {
        try { if (_core != null) await _core.NotifyAsync(method, payload); } catch (IOException) { _core = null; }
    }

    private async Task ConnectLoopAsync()
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var pipe = new NamedPipeClientStream(".", Handshake.PipeName("core"), PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.ConnectAsync(5000);
                var ch = new JsonRpcChannel(pipe) { OnRequest = HandleAsync };
                var run = ch.RunAsync(CancellationToken.None);
                await ch.CallAsync("hello", new { protocol_version = Nep.ProtocolVersion, component = "session", secret = _secret });
                _core = ch; attempt = 0;
                await run;              // returns when the Coordinator goes away
                _core = null;
            }
            catch (Exception) { _core = null; }
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, 1 << Math.Min(attempt, 5))));
        }
    }

    private Task<object?> HandleAsync(string method, JsonElement p, CancellationToken ct)
    {
        switch (method)
        {
            case "notify.toast":
                Tray.Balloon(_hwnd, p.GetProperty("title").GetString() ?? "JARVIS", p.GetProperty("body").GetString() ?? "");
                return Task.FromResult<object?>(new { shown = true });
            case "capture.screen":
            {
                if (_halted) throw new JarvisException(ErrorCodes.Cancelled, "emergency stop is active");
                var w = GetSystemMetrics(0), h = GetSystemMetrics(1);
                using var bmp = new Bitmap(w, h);
                using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);
                return Task.FromResult<object?>(new { width = w, height = h, png_b64 = Convert.ToBase64String(ms.ToArray()), captured_at = DateTimeOffset.UtcNow });
            }
            case "session.resume_automation": _halted = false; return Task.FromResult<object?>(new { ok = true });
            case "ping": return Task.FromResult<object?>(new { ok = true, halted = _halted });
            default: throw new JarvisException(ErrorCodes.UnsupportedOperation, $"session agent v0 does not serve {method}");
        }
    }

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WNDCLASSEX { public uint cbSize, style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string? lpszMenuName; public string lpszClassName; public IntPtr hIconSm; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int ptX, ptY; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassEx(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowEx(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("wtsapi32.dll")] private static extern bool WTSRegisterSessionNotification(IntPtr hWnd, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);
}

/// <summary>Notification-area icon and balloons through Shell_NotifyIcon.</summary>
[SupportedOSPlatform("windows")]
internal static class Tray
{
    private const uint NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2, NIF_ICON = 0x2, NIF_TIP = 0x4, NIF_INFO = 0x10;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATA
    {
        public uint cbSize; public IntPtr hWnd; public uint uID, uFlags, uCallbackMessage; public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip; public uint dwState, dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo; public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle; public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIcon(uint msg, ref NOTIFYICONDATA data);
    [DllImport("user32.dll")] private static extern IntPtr LoadIcon(IntPtr inst, IntPtr name);
    private static NOTIFYICONDATA Data(IntPtr hwnd) => new() { cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(), hWnd = hwnd, uID = 1, szTip = "JARVIS", szInfo = "", szInfoTitle = "" };
    public static void Add(IntPtr hwnd) { var d = Data(hwnd); d.uFlags = NIF_ICON | NIF_TIP; d.hIcon = LoadIcon(IntPtr.Zero, (IntPtr)32516 /* IDI_INFORMATION */); Shell_NotifyIcon(NIM_ADD, ref d); }
    public static void Balloon(IntPtr hwnd, string title, string body) { var d = Data(hwnd); d.uFlags = NIF_INFO; d.szInfoTitle = title.Length > 63 ? title[..63] : title; d.szInfo = body.Length > 255 ? body[..255] : body; d.dwInfoFlags = 1; Shell_NotifyIcon(NIM_MODIFY, ref d); }
    public static void Remove(IntPtr hwnd) { var d = Data(hwnd); Shell_NotifyIcon(NIM_DELETE, ref d); }
}

internal static class Program
{
    private static int Main()
    {
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("jarvis-session runs only on Windows"); return 2; }
        var secret = Console.In.ReadLine() ?? Environment.GetEnvironmentVariable("JARVIS_DEV_SESSION_SECRET");
        if (string.IsNullOrEmpty(secret)) return 2;
        return new Agent(secret).Run();
    }
}
