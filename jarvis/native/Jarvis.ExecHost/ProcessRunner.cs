using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jarvis.Contracts;

namespace Jarvis.ExecHost;

/// <summary>ProcessRequest (05 §11.10). Secrets arrive separately (never in argv) and only as environment values.</summary>
public sealed class ProcessRequest
{
    [JsonPropertyName("program")] public string Program { get; set; } = "";
    [JsonPropertyName("args")] public List<string> Args { get; set; } = new();
    [JsonPropertyName("cwd")] public string Cwd { get; set; } = "";
    [JsonPropertyName("env_allowlist")] public List<string> EnvAllowlist { get; set; } = new();
    [JsonPropertyName("timeout_s")] public double TimeoutS { get; set; } = 60;
    [JsonPropertyName("max_output_bytes")] public int MaxOutputBytes { get; set; } = 1_000_000;
    [JsonPropertyName("tier")] public string Tier { get; set; } = "T1";
    [JsonPropertyName("job_limits")] public JobLimits JobLimits { get; set; } = new();
    [JsonPropertyName("script_hash")] public string? ScriptHash { get; set; }
}

public sealed class JobLimits
{
    [JsonPropertyName("memory_mb")] public long? MemoryMb { get; set; }
    [JsonPropertyName("cpu_percent")] public int? CpuPercent { get; set; }
    [JsonPropertyName("max_processes")] public int? MaxProcesses { get; set; }
}

public sealed record ProcessOutcome(int? ExitCode, string Output, bool Truncated, long TotalBytes, long DurationMs, bool TimedOut, bool Cancelled, bool InJob);

/// <summary>
/// Runs one structured process request. On Windows each invocation gets its own Job Object
/// with kill-on-close, memory and process-count limits and no breakaway; a timeout or cancel
/// terminates the whole tree. Elsewhere the tree is killed with Process.Kill(entireProcessTree).
/// </summary>
public static class ProcessRunner
{
    public static void Validate(ProcessRequest r)
    {
        if (r.Tier != "T1") throw new JarvisException(ErrorCodes.UnsupportedOperation, $"{r.Tier} runs through the Workshop or an elevated batch");
        if (!Path.IsPathFullyQualified(r.Program)) throw new JarvisException(ErrorCodes.InvalidInput, "program must be a resolved absolute path");
        if (!File.Exists(r.Program)) throw new JarvisException(ErrorCodes.InvalidInput, "program not found");
        if (!Path.IsPathFullyQualified(r.Cwd) || !Directory.Exists(r.Cwd)) throw new JarvisException(ErrorCodes.InvalidInput, "cwd must be an existing absolute folder");
        if (r.TimeoutS <= 0 || r.TimeoutS > 24 * 3600) throw new JarvisException(ErrorCodes.InvalidInput, "timeout out of range");
        if (r.ScriptHash is { } h)
        {
            var script = r.Args.FirstOrDefault(a => File.Exists(a));
            if (script is null || Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(script))).ToLowerInvariant() != h.ToLowerInvariant())
                throw new JarvisException(ErrorCodes.PreconditionChanged, "the script changed since it was approved");
        }
    }

    public static async Task<ProcessOutcome> RunAsync(ProcessRequest r, IReadOnlyDictionary<string, string> secrets, CancellationToken cancel)
    {
        Validate(r);
        var psi = new ProcessStartInfo(r.Program) { WorkingDirectory = r.Cwd, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, CreateNoWindow = true };
        foreach (var a in r.Args) psi.ArgumentList.Add(a);
        psi.Environment.Clear();
        // Windows processes need SystemRoot and windir to start at all; everything else is explicit.
        var allow = OperatingSystem.IsWindows() ? r.EnvAllowlist.Concat(["SystemRoot", "windir"]).Distinct() : r.EnvAllowlist;
        foreach (var k in allow) { var v = Environment.GetEnvironmentVariable(k); if (v != null) psi.Environment[k] = v; }
        foreach (var (k, v) in secrets) psi.Environment[k] = v;

        var sw = Stopwatch.StartNew();
        using var proc = new Process { StartInfo = psi };
        var head = new MemoryStream(); var tail = new Queue<byte[]>(); long tailBytes = 0, total = 0; var gate = new object();
        void Capture(string? line)
        {
            if (line is null) return;
            var b = Encoding.UTF8.GetBytes(line + "\n");
            lock (gate)
            {
                total += b.Length;
                if (head.Length < r.MaxOutputBytes / 2) head.Write(b, 0, (int)Math.Min(b.Length, r.MaxOutputBytes / 2 - head.Length));
                else { tail.Enqueue(b); tailBytes += b.Length; while (tailBytes > r.MaxOutputBytes / 2 && tail.Count > 1) tailBytes -= tail.Dequeue().Length; }
            }
        }
        proc.OutputDataReceived += (_, e) => Capture(e.Data);
        proc.ErrorDataReceived += (_, e) => Capture(e.Data);
        if (!proc.Start()) throw new JarvisException(ErrorCodes.InternalError, "process failed to start");
        using var job = OperatingSystem.IsWindows() ? WindowsJob.CreateFor(proc, r.JobLimits) : null;
        proc.StandardInput.Close();
        proc.BeginOutputReadLine(); proc.BeginErrorReadLine();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(r.TimeoutS));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, cancel);
        var timedOut = false; var cancelled = false;
        try { await proc.WaitForExitAsync(linked.Token); }
        catch (OperationCanceledException)
        {
            timedOut = timeout.IsCancellationRequested; cancelled = cancel.IsCancellationRequested;
            job?.Terminate();
            try { proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            await proc.WaitForExitAsync(CancellationToken.None);
        }
        proc.WaitForExit();   // flush async readers
        string text;
        lock (gate)
        {
            var h = Encoding.UTF8.GetString(head.ToArray());
            text = total > r.MaxOutputBytes ? h + $"\n…[{total - head.Length - tailBytes} bytes truncated]…\n" + string.Concat(tail.Select(b => Encoding.UTF8.GetString(b))) : h + string.Concat(tail.Select(b => Encoding.UTF8.GetString(b)));
        }
        foreach (var s in secrets.Values.Where(v => v.Length >= 6)) text = text.Replace(s, "[redacted-secret]");
        return new ProcessOutcome(timedOut || cancelled ? null : proc.ExitCode, text, total > r.MaxOutputBytes, total, sw.ElapsedMilliseconds, timedOut, cancelled, job != null);
    }
}

/// <summary>Windows Job Object: kill-on-close, no breakaway, memory and process limits.</summary>
internal sealed class WindowsJob : IDisposable
{
    private readonly IntPtr _handle;
    private WindowsJob(IntPtr h) { _handle = h; }

    public static WindowsJob? CreateFor(Process p, JobLimits limits)
    {
        if (!OperatingSystem.IsWindows()) return null;
        var h = Native.CreateJobObject(IntPtr.Zero, null);
        if (h == IntPtr.Zero) throw new JarvisException(ErrorCodes.InternalError, "CreateJobObject failed");
        var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (limits.MemoryMb is { } mb) { info.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_JOB_MEMORY; info.JobMemoryLimit = (UIntPtr)(ulong)(mb * 1024 * 1024); }
        if (limits.MaxProcesses is { } n) { info.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS; info.BasicLimitInformation.ActiveProcessLimit = (uint)n; }
        var size = Marshal.SizeOf(info);
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!Native.SetInformationJobObject(h, Native.JobObjectExtendedLimitInformation, ptr, (uint)size)) throw new JarvisException(ErrorCodes.InternalError, "SetInformationJobObject failed");
        }
        finally { Marshal.FreeHGlobal(ptr); }
        // A child spawned in the instant before assignment could escape the job; Kill(entireProcessTree) remains the second layer.
        if (!Native.AssignProcessToJobObject(h, p.Handle)) throw new JarvisException(ErrorCodes.InternalError, "AssignProcessToJobObject failed");
        return new WindowsJob(h);
    }

    public void Terminate() { if (OperatingSystem.IsWindows()) Native.TerminateJobObject(_handle, 1); }
    public void Dispose() { if (OperatingSystem.IsWindows()) Native.CloseHandle(_handle); }   // kill-on-close ends any survivors

    private static class Native
    {
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200, JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
        public const int JobObjectExtendedLimitInformation = 9;
        [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attrs, string? name);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    }
}
