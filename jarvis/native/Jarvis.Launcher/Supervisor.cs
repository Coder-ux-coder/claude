using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jarvis.Launcher;

public sealed class ComponentSpec
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("command")] public string Command { get; set; } = "";
    [JsonPropertyName("args")] public List<string> Args { get; set; } = new();
    [JsonPropertyName("safe_mode_arg")] public string? SafeModeArg { get; set; }
    [JsonPropertyName("critical")] public bool Critical { get; set; } = true;
    /// <summary>Pipe the component serves; the next component starts only once it exists (start order, 01 §4.5).</summary>
    [JsonPropertyName("ready_pipe")] public string? ReadyPipe { get; set; }
}

public sealed class LauncherConfig
{
    [JsonPropertyName("components")] public List<ComponentSpec> Components { get; set; } = new();
    public static LauncherConfig Load(string path) => JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(path)) ?? new LauncherConfig();
}

/// <summary>A started child, abstracted so the supervision logic is testable.</summary>
public interface IChild { Task<int> Exited { get; } void Stop(); }
public interface IChildStarter { IChild Start(ComponentSpec spec, IReadOnlyList<string> args, string sessionSecret); }

public sealed class ProcessStarter : IChildStarter
{
    public IChild Start(ComponentSpec spec, IReadOnlyList<string> args, string sessionSecret)
    {
        var psi = new ProcessStartInfo(spec.Command) { UseShellExecute = false, RedirectStandardInput = true, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        var p = Process.Start(psi) ?? throw new InvalidOperationException($"{spec.Name} did not start");
        // The per-boot secret goes over the child's stdin, never the command line or environment (01 §4.2).
        p.StandardInput.WriteLine(sessionSecret);
        p.StandardInput.Flush();
        return new ProcChild(p);
    }
    private sealed class ProcChild(Process p) : IChild
    {
        public Task<int> Exited { get; } = p.WaitForExitAsync().ContinueWith(_ => p.ExitCode);
        public void Stop() { try { p.StandardInput.Close(); if (!p.WaitForExit(10_000)) p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } }
    }
}

/// <summary>
/// Launcher supervision (01 §4.4–4.5): starts Exec Host, Coordinator, Session Agent and Console
/// in order; restarts with exponential backoff; three Coordinator crashes in ten minutes start it
/// in safe mode (UI and memory browsing, no dispatch, alarms still delivered).
/// </summary>
public sealed class Supervisor
{
    private readonly LauncherConfig _config;
    private readonly IChildStarter _starter;
    private readonly Func<DateTimeOffset> _now;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Dictionary<string, List<DateTimeOffset>> _crashes = new();
    public string SessionSecret { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public event Action<string>? Log;
    public bool CoreInSafeMode { get; private set; }

    public Supervisor(LauncherConfig config, IChildStarter starter, Func<DateTimeOffset>? now = null, Func<TimeSpan, CancellationToken, Task>? delay = null)
    { _config = config; _starter = starter; _now = now ?? (() => DateTimeOffset.UtcNow); _delay = delay ?? Task.Delay; }

    public static TimeSpan Backoff(int consecutiveFailures) => TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Max(0, consecutiveFailures - 1))));

    public bool ShouldEnterSafeMode(string name)
    {
        if (!_crashes.TryGetValue(name, out var list)) return false;
        var window = _now() - TimeSpan.FromMinutes(10);
        list.RemoveAll(t => t < window);
        return list.Count >= 3;
    }

    /// <summary>Waits for a component's pipe; overridable for tests.</summary>
    public Func<string, CancellationToken, Task<bool>> WaitForPipe { get; set; } = async (name, ct) =>
    {
        var path = OperatingSystem.IsWindows() ? $@"\\.\pipe\{name}" : Path.Combine(Path.GetTempPath(), $"CoreFxPipe_{name}");
        for (var i = 0; i < 150 && !ct.IsCancellationRequested; i++) { if (File.Exists(path)) return true; await Task.Delay(100, ct); }
        return false;
    };

    /// <summary>Starts components in order (Exec Host, Coordinator, Session Agent, Console), each after the previous is ready.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var loops = new List<Task>();
        foreach (var c in _config.Components)
        {
            loops.Add(SuperviseAsync(c, ct));
            if (c.ReadyPipe != null && !await WaitForPipe(c.ReadyPipe, ct)) Log?.Invoke($"{c.Name} did not become ready; continuing");
        }
        await Task.WhenAll(loops);
    }

    private async Task SuperviseAsync(ComponentSpec spec, CancellationToken ct)
    {
        var failures = 0;
        while (!ct.IsCancellationRequested)
        {
            var safe = spec.SafeModeArg != null && ShouldEnterSafeMode(spec.Name);
            if (spec.Name == "core") CoreInSafeMode = safe;
            var args = safe ? spec.Args.Append(spec.SafeModeArg!).ToList() : spec.Args;
            Log?.Invoke($"starting {spec.Name}{(safe ? " in SAFE MODE" : "")}");
            IChild child;
            try { child = _starter.Start(spec, args, SessionSecret); }
            catch (Exception e) { Log?.Invoke($"{spec.Name} failed to start: {e.Message}"); failures++; await _delay(Backoff(failures), ct); continue; }
            var started = _now();
            using (ct.Register(child.Stop))
            {
                var code = await child.Exited;
                if (ct.IsCancellationRequested) return;
                Log?.Invoke($"{spec.Name} exited with {code}");
                if (code == 0 && !spec.Critical) return;
                if (!_crashes.TryGetValue(spec.Name, out var list)) _crashes[spec.Name] = list = new();
                list.Add(_now());
                failures = _now() - started > TimeSpan.FromMinutes(5) ? 1 : failures + 1;
            }
            try { await _delay(Backoff(failures), ct); } catch (OperationCanceledException) { return; }
        }
    }
}

/// <summary>At-logon start (01 §4.1): a Task Scheduler logon trigger for this user.</summary>
public static class LogonTask
{
    public const string TaskName = "JARVIS Launcher";
    public static IReadOnlyList<string> CreateArgs(string launcherPath) =>
        ["/Create", "/TN", TaskName, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", $"\"{launcherPath}\""];
    public static IReadOnlyList<string> DeleteArgs() => ["/Delete", "/TN", TaskName, "/F"];
}
