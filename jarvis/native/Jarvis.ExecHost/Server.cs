using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jarvis.Contracts;

namespace Jarvis.ExecHost;

/// <summary>
/// Exec Host NEP server. Named pipe ACL'd to the current user; every connection must say
/// hello with the Launcher's per-boot secret before any other call. Effectful invocations
/// must carry a grant signed by the Coordinator for exactly these params.
/// </summary>
public sealed class ExecHostServer
{
    private readonly string _pipeName;
    private readonly string _secret;
    private readonly string _trashDir;
    private byte[]? _grantKey;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _inflight = new();
    private readonly ConcurrentDictionary<string, JsonNode?> _results = new();
    private readonly ConcurrentQueue<string> _resultOrder = new();
    public const string Version = "0.1.0";

    public ExecHostServer(string pipeName, string secret, string trashDir) { _pipeName = pipeName; _secret = secret; _trashDir = trashDir; }

    private NamedPipeServerStream CreatePipe()
    {
        if (OperatingSystem.IsWindows())
        {
            var sec = new PipeSecurity();
            var me = WindowsIdentity.GetCurrent().User!;
            sec.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            return NamedPipeServerStreamAcl.Create(_pipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 0, 0, sec);
        }
        return new NamedPipeServerStream(_pipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    }

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var pipe = CreatePipe();
            try { await pipe.WaitForConnectionAsync(ct); }
            catch (OperationCanceledException) { await pipe.DisposeAsync(); break; }
            _ = Task.Run(() => ServeAsync(pipe, ct), ct);
        }
    }

    private async Task ServeAsync(Stream stream, CancellationToken ct)
    {
        var authed = false;
        await using var ch = new JsonRpcChannel(stream);
        ch.OnRequest = async (method, p, token) =>
        {
            if (method == "hello")
            {
                var given = p.TryGetProperty("secret", out var s) ? s.GetString() : null;
                if (!Handshake.SecretMatches(_secret, given)) throw new JarvisException(ErrorCodes.MissingPermission, "handshake failed");
                authed = true;
                return new { protocol_version = Nep.ProtocolVersion, host = "jarvis-exec", version = Version, platform = OperatingSystem.IsWindows() ? "windows" : "other", job_objects = OperatingSystem.IsWindows() };
            }
            if (!authed) throw new JarvisException(ErrorCodes.MissingPermission, "say hello first");
            switch (method)
            {
                case "configure":
                    _grantKey = Convert.FromHexString(p.GetProperty("grant_key_hex").GetString()!);
                    return new { ok = true };
                case "nep.invoke": return await InvokeAsync(p, token);
                case "nep.cancel":
                {
                    var id = p.GetProperty("invocation_id").GetString()!;
                    if (_inflight.TryGetValue(id, out var cts)) { cts.Cancel(); return new { result = "cancelled" }; }
                    return new { result = _results.ContainsKey(id) ? "already_done" : "not_found" };
                }
                case "nep.status":
                {
                    var id = p.GetProperty("invocation_id").GetString()!;
                    if (_inflight.ContainsKey(id)) return new { state = "running" };
                    return _results.TryGetValue(id, out var r) ? new { state = "done", result = r } : new { state = "unknown", result = (JsonNode?)null };
                }
                case "dpapi.protect": return new { data_b64 = Convert.ToBase64String(Dpapi.Protect(Convert.FromBase64String(p.GetProperty("data_b64").GetString()!))) };
                case "dpapi.unprotect": return new { data_b64 = Convert.ToBase64String(Dpapi.Unprotect(Convert.FromBase64String(p.GetProperty("data_b64").GetString()!))) };
                case "ping": return new { ok = true, version = Version };
                default: throw new JarvisException(ErrorCodes.UnsupportedOperation, $"unknown method {method}");
            }
        };
        try { await ch.RunAsync(ct); } catch (IOException) { /* client went away */ } catch (OperationCanceledException) { }
    }

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = false };

    private async Task<object> InvokeAsync(JsonElement p, CancellationToken ct)
    {
        var inv = p.Deserialize<NepInvoke>(Json) ?? throw new JarvisException(ErrorCodes.InvalidInput, "bad invocation");
        if (_results.TryGetValue(inv.InvocationId, out var prior)) return prior!;           // idempotent re-delivery after reconnect
        if (_grantKey is null) throw new JarvisException(ErrorCodes.MissingPermission, "not configured with a grant key");
        var why = GrantSignature.Verify(_grantKey, inv, DateTimeOffset.UtcNow);
        if (why != null) throw new JarvisException(why == "grant expired" ? ErrorCodes.Expired : ErrorCodes.MissingPermission, $"grant rejected: {why}");
        if (DateTimeOffset.TryParse(inv.Deadline, out var dl) && dl <= DateTimeOffset.UtcNow) throw new JarvisException(ErrorCodes.Expired, "deadline passed before start");
        var secrets = p.TryGetProperty("secrets", out var s) && s.ValueKind == JsonValueKind.Object ? s.EnumerateObject().ToDictionary(x => x.Name, x => x.Value.GetString() ?? "") : new Dictionary<string, string>();
        var cap = inv.Capability.Split('@')[0];
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _inflight[inv.InvocationId] = cts;
        try
        {
            ExecResult res;
            switch (cap)
            {
                case "tool:shell.run":
                {
                    var req = inv.Params.Deserialize<ProcessRequest>(Json) ?? throw new JarvisException(ErrorCodes.InvalidInput, "bad process request");
                    var o = await ProcessRunner.RunAsync(req, secrets, cts.Token);
                    var evidence = new Dictionary<string, object?> { ["type"] = "process_exit", ["exit_code"] = o.ExitCode, ["duration_ms"] = o.DurationMs, ["total_bytes"] = o.TotalBytes, ["in_job"] = o.InJob };
                    res = o.Cancelled ? new ExecResult { Status = "error", EffectState = "unknown", Error = new JarvisException(ErrorCodes.Cancelled, "cancelled; process tree killed", "unknown").ToStructured(cap, "jarvis-exec") }
                        : o.TimedOut ? new ExecResult { Status = "error", EffectState = "unknown", Error = new JarvisException(ErrorCodes.Timeout, $"timed out after {req.TimeoutS}s; process tree killed", "unknown").ToStructured(cap, "jarvis-exec") }
                        : new ExecResult { Status = o.ExitCode == 0 ? "ok" : "error", EffectState = o.ExitCode == 0 ? "complete" : "unknown", Output = new { exit_code = o.ExitCode, output = o.Output, truncated = o.Truncated },
                            Error = o.ExitCode == 0 ? null : new JarvisException(ErrorCodes.ExternalRefusal, $"exit code {o.ExitCode}", "unknown").ToStructured(cap, "jarvis-exec") };
                    res.Evidence.Add(evidence);
                    break;
                }
                case "tool:files.delete":
                {
                    var path = inv.Params.GetProperty("path").GetString()!;
                    var where = RecycleBin.Delete(path, _trashDir);
                    res = new ExecResult { Status = "ok", EffectState = "complete", Output = new { path, recoverable_at = where } };
                    res.Evidence.Add(new Dictionary<string, object?> { ["type"] = "file_check", ["gone"] = !File.Exists(path) && !Directory.Exists(path) });
                    break;
                }
                default: throw new JarvisException(ErrorCodes.UnsupportedOperation, $"jarvis-exec does not serve {cap}");
            }
            var node = JsonSerializer.SerializeToNode(res);
            _results[inv.InvocationId] = node;
            _resultOrder.Enqueue(inv.InvocationId);
            while (_resultOrder.Count > 1000 && _resultOrder.TryDequeue(out var old)) _results.TryRemove(old, out _);
            return node!;
        }
        finally { _inflight.TryRemove(inv.InvocationId, out _); }
    }
}
