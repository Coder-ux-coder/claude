using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jarvis.Contracts;

/// <summary>
/// JSON-RPC 2.0 over newline-delimited JSON on any duplex stream (named pipe on Windows,
/// Unix domain socket elsewhere). Handles requests, notifications and responses both ways.
/// </summary>
public sealed class JsonRpcChannel : IAsyncDisposable
{
    private readonly Stream _stream;
    private readonly StreamReader _reader;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> _pending = new();
    private long _nextId;
    public Func<string, JsonElement, CancellationToken, Task<object?>>? OnRequest { get; set; }
    public Func<string, JsonElement, Task>? OnNotification { get; set; }
    public const int MaxLineBytes = 16 * 1024 * 1024;

    public JsonRpcChannel(Stream stream)
    {
        _stream = stream;
        _reader = new StreamReader(stream, new UTF8Encoding(false), false, 65536, leaveOpen: true);
    }

    public async Task SendRawAsync(string json, CancellationToken ct = default)
    {
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        await _writeLock.WaitAsync(ct);
        try { await _stream.WriteAsync(bytes, ct); await _stream.FlushAsync(ct); }
        finally { _writeLock.Release(); }
    }

    public Task NotifyAsync(string method, object? @params, CancellationToken ct = default) =>
        SendRawAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", method, @params }), ct);

    public async Task<JsonNode?> CallAsync(string method, object? @params, CancellationToken ct = default)
    {
        var id = $"c{Interlocked.Increment(ref _nextId)}";
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        await SendRawAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method, @params }), ct);
        using (ct.Register(() => tcs.TrySetCanceled()))
            return await tcs.Task;
    }

    /// <summary>Reads until the stream closes, dispatching messages.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var line = await _reader.ReadLineAsync(ct);
            if (line is null) break;
            if (line.Length == 0) continue;
            if (line.Length > MaxLineBytes) { await ErrorAsync(null, -32600, "message too large"); continue; }
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); } catch (JsonException) { await ErrorAsync(null, -32700, "parse error"); continue; }
            _ = Task.Run(() => DispatchAsync(doc, ct), ct);
        }
        foreach (var p in _pending.Values) p.TrySetException(new IOException("channel closed"));
    }

    private async Task DispatchAsync(JsonDocument doc, CancellationToken ct)
    {
        using (doc)
        {
            var root = doc.RootElement;
            var hasId = root.TryGetProperty("id", out var idEl) && idEl.ValueKind is JsonValueKind.String or JsonValueKind.Number;
            var id = hasId ? idEl.ToString() : null;
            if (root.TryGetProperty("method", out var m))
            {
                var method = m.GetString() ?? "";
                var prms = root.TryGetProperty("params", out var p) ? p.Clone() : default;
                if (!hasId) { if (OnNotification != null) await OnNotification(method, prms); return; }
                try
                {
                    if (OnRequest is null) throw new JarvisException(ErrorCodes.UnsupportedOperation, "no handler");
                    var result = await OnRequest(method, prms, ct);
                    await SendRawAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = idEl, result }), ct);
                }
                catch (JarvisException je)
                {
                    await SendRawAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = idEl, error = new { code = -32000, message = je.Message, data = je.ToStructured(method, "native") } }), ct);
                }
                catch (Exception e)
                {
                    await SendRawAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = idEl, error = new { code = -32603, message = "internal error", data = new StructuredError(ErrorCodes.InternalError, e.GetType().Name, true, "unknown", new ErrorSource(method, "native", "node_local")) } }), ct);
                }
            }
            else if (id != null && _pending.TryRemove(id, out var tcs))
            {
                if (root.TryGetProperty("error", out var err)) tcs.TrySetException(new JarvisException(err.TryGetProperty("data", out var d) && d.TryGetProperty("code", out var c) ? c.GetString() ?? ErrorCodes.InternalError : ErrorCodes.InternalError, err.GetProperty("message").GetString() ?? "error"));
                else tcs.TrySetResult(root.TryGetProperty("result", out var r) ? JsonNode.Parse(r.GetRawText()) : null);
            }
        }
    }

    private Task ErrorAsync(object? id, int code, string message) => SendRawAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, error = new { code, message } }));

    public async ValueTask DisposeAsync() { _reader.Dispose(); await _stream.DisposeAsync(); _writeLock.Dispose(); }
}

/// <summary>Handshake (12 §17.6 "hello"): protocol version plus the Launcher's per-boot session secret.</summary>
public static class Handshake
{
    public static bool SecretMatches(string expected, string? given) =>
        given is not null && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(given));

    /// <summary>Pipe name per component and user; on non-Windows .NET maps it to a Unix domain socket.</summary>
    public static string PipeName(string component) => $"jarvis-{component}-{Environment.UserName}";
}
