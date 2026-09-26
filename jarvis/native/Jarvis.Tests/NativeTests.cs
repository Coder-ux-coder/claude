using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jarvis.Contracts;
using Jarvis.ExecHost;
using Jarvis.Launcher;
using Xunit;

namespace Jarvis.Tests;

public class GrantSignatureTests
{
    private static readonly byte[] Key = Convert.FromHexString("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

    private static NepInvoke Inv(string rawParams, string sig, string expires) => new()
    {
        InvocationId = "inv_1", Capability = "tool:shell.run@1.0.0", Params = JsonDocument.Parse(rawParams).RootElement.Clone(), IdempotencyKey = "idk_1",
        TaskRevision = 2, PolicyRevision = 5, Deadline = DateTimeOffset.UtcNow.AddMinutes(1).ToString("o"), Grant = new NepGrant("grt_1", sig, "fp", expires),
    };

    [Fact]
    public void SignsExactParamBytesAndRejectsTampering()
    {
        var raw = "{\"args\":[\"status\"],\"program\":\"/usr/bin/git\"}";
        var exp = DateTimeOffset.UtcNow.AddMinutes(5).ToString("o");
        var sig = GrantSignature.Sign(Key, GrantSignature.Payload("inv_1", "tool:shell.run@1.0.0", GrantSignature.ParamsSha256(raw), exp, "idk_1", 2, 5));
        Assert.Null(GrantSignature.Verify(Key, Inv(raw, sig, exp), DateTimeOffset.UtcNow));
        Assert.Equal("signature mismatch", GrantSignature.Verify(Key, Inv("{\"args\":[\"push\"],\"program\":\"/usr/bin/git\"}", sig, exp), DateTimeOffset.UtcNow));
        Assert.Equal("grant expired", GrantSignature.Verify(Key, Inv(raw, sig, exp), DateTimeOffset.UtcNow.AddMinutes(10)));
        Assert.Equal("signature mismatch", GrantSignature.Verify(new byte[32], Inv(raw, sig, exp), DateTimeOffset.UtcNow));
        Assert.Equal("bad signature", GrantSignature.Verify(Key, Inv(raw, "zz", exp), DateTimeOffset.UtcNow));
    }

    [Fact]
    public void HandshakeComparesInConstantTime()
    {
        Assert.True(Handshake.SecretMatches("abc", "abc"));
        Assert.False(Handshake.SecretMatches("abc", "abd"));
        Assert.False(Handshake.SecretMatches("abc", null));
    }
}

public class ProcessRunnerTests
{
    private static string Sh => File.Exists("/bin/sh") ? "/bin/sh" : throw new SkipException();
    private sealed class SkipException : Exception { }
    private static ProcessRequest Req(params string[] args) => new() { Program = "/bin/sh", Args = ["-c", .. args], Cwd = Path.GetTempPath(), TimeoutS = 10, MaxOutputBytes = 4000 };

    [Fact]
    public async Task RunsWithStructuredArgvAndCleanEnvironment()
    {
        _ = Sh;
        Environment.SetEnvironmentVariable("JARVIS_TEST_LEAK", "should-not-appear");
        var o = await ProcessRunner.RunAsync(Req("echo hello; echo ${JARVIS_TEST_LEAK:-clean}"), new Dictionary<string, string>(), CancellationToken.None);
        Assert.Equal(0, o.ExitCode);
        Assert.Contains("hello", o.Output);
        Assert.Contains("clean", o.Output);
    }

    [Fact]
    public async Task SecretsOnlyAsEnvAndRedactedFromOutput()
    {
        _ = Sh;
        var o = await ProcessRunner.RunAsync(Req("echo token=$API_TOKEN"), new Dictionary<string, string> { ["API_TOKEN"] = "sk-HYPOTHETICAL-123456" }, CancellationToken.None);
        Assert.DoesNotContain("sk-HYPOTHETICAL-123456", o.Output);
        Assert.Contains("[redacted-secret]", o.Output);
    }

    [Fact]
    public async Task TimeoutKillsTheWholeTree()
    {
        _ = Sh;
        var marker = Path.Combine(Path.GetTempPath(), $"jv-child-{Guid.NewGuid():N}");
        var r = Req($"(sleep 3; touch {marker}) & sleep 30");
        r.TimeoutS = 1;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var o = await ProcessRunner.RunAsync(r, new Dictionary<string, string>(), CancellationToken.None);
        Assert.True(o.TimedOut);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(8));
        await Task.Delay(3500);
        Assert.False(File.Exists(marker), "a background child survived the kill");
    }

    [Fact]
    public async Task OutputIsBounded()
    {
        _ = Sh;
        var o = await ProcessRunner.RunAsync(Req("i=0; while [ $i -lt 2000 ]; do echo line-$i-xxxxxxxxxxxxxxxx; i=$((i+1)); done"), new Dictionary<string, string>(), CancellationToken.None);
        Assert.True(o.Truncated);
        Assert.Contains("bytes truncated", o.Output);
        Assert.Contains("line-0-", o.Output);
        Assert.Contains("line-1999-", o.Output);
    }

    [Fact]
    public void ValidationRejectsRelativeProgramsAndT2()
    {
        Assert.Equal(ErrorCodes.InvalidInput, Assert.Throws<JarvisException>(() => ProcessRunner.Validate(new ProcessRequest { Program = "ls", Cwd = Path.GetTempPath() })).Code);
        Assert.Equal(ErrorCodes.UnsupportedOperation, Assert.Throws<JarvisException>(() => ProcessRunner.Validate(new ProcessRequest { Program = "/bin/sh", Cwd = Path.GetTempPath(), Tier = "T2" })).Code);
    }

    [Fact]
    public void RecycleFallbackKeepsARestoreManifest()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        var f = Path.Combine(dir, "note.txt"); File.WriteAllText(f, "x");
        var where = RecycleBin.Delete(f, Path.Combine(dir, "trash"));
        Assert.False(File.Exists(f));
        Assert.True(File.Exists(where));
        Assert.Contains("note.txt", File.ReadAllText(where + ".restore.json"));
    }
}

public class SupervisorTests
{
    private sealed class FakeChild : IChild
    {
        public TaskCompletionSource<int> Tcs { get; } = new();
        public Task<int> Exited => Tcs.Task;
        public void Stop() => Tcs.TrySetResult(0);
    }
    private sealed class FakeStarter : IChildStarter
    {
        public List<(string name, IReadOnlyList<string> args, string secret)> Starts { get; } = new();
        public Queue<Func<FakeChild>> Script { get; } = new();
        public IChild Start(ComponentSpec spec, IReadOnlyList<string> args, string secret)
        {
            Starts.Add((spec.Name, args, secret));
            var c = Script.Count > 0 ? Script.Dequeue()() : new FakeChild();
            return c;
        }
    }

    [Fact]
    public async Task ThreeCoreCrashesInTenMinutesStartSafeMode()
    {
        var now = DateTimeOffset.Parse("2026-10-01T09:00:00Z");
        var starter = new FakeStarter();
        for (var i = 0; i < 3; i++) starter.Script.Enqueue(() => { var c = new FakeChild(); c.Tcs.SetResult(1); return c; });
        var cts = new CancellationTokenSource();
        var sup = new Supervisor(new LauncherConfig { Components = [new ComponentSpec { Name = "core", Command = "node", Args = ["main.js"], SafeModeArg = "--safe-mode" }] }, starter,
            () => { now = now.AddSeconds(30); return now; }, (_, _) => Task.CompletedTask);
        var run = sup.RunAsync(cts.Token);
        for (var i = 0; i < 50 && starter.Starts.Count < 4; i++) await Task.Delay(20);
        cts.Cancel();
        await run;
        Assert.True(starter.Starts.Count >= 4);
        Assert.DoesNotContain("--safe-mode", starter.Starts[2].args);
        Assert.Contains("--safe-mode", starter.Starts[3].args);
        Assert.True(sup.CoreInSafeMode);
        Assert.All(starter.Starts, s => Assert.Equal(64, s.secret.Length));
    }

    [Fact]
    public async Task StartsInOrderWaitingForEachPipe()
    {
        var starter = new FakeStarter();
        var cfg = new LauncherConfig { Components = [
            new ComponentSpec { Name = "exec", Command = "x", ReadyPipe = "p-exec" }, new ComponentSpec { Name = "core", Command = "y", ReadyPipe = "p-core" },
            new ComponentSpec { Name = "session", Command = "z" }, new ComponentSpec { Name = "console", Command = "w", Critical = false } ] };
        var waited = new List<string>();
        var sup = new Supervisor(cfg, starter) { WaitForPipe = (n, _) => { waited.Add(n); Assert.Equal(waited.Count, starter.Starts.Count); return Task.FromResult(true); } };
        using var cts = new CancellationTokenSource();
        var run = sup.RunAsync(cts.Token);
        for (var i = 0; i < 50 && starter.Starts.Count < 4; i++) await Task.Delay(20);
        cts.Cancel(); await run;
        Assert.Equal(["exec", "core", "session", "console"], starter.Starts.Select(s => s.name).Take(4));
        Assert.Equal(["p-exec", "p-core"], waited);
    }

    [Fact]
    public void ConfigExpandsEnvironmentVariables()
    {
        Environment.SetEnvironmentVariable("JARVIS_TEST_ROOT", "/opt/jarvis-test");
        var c = LauncherConfig.Expand(new LauncherConfig { Components = [new ComponentSpec { Name = "exec", Command = "%JARVIS_TEST_ROOT%/jarvis-exec", Args = ["--pipe", "p-%JARVIS_TEST_ROOT%"], ReadyPipe = "x-%JARVIS_TEST_ROOT%" }] });
        Assert.Equal("/opt/jarvis-test/jarvis-exec", c.Components[0].Command);
        Assert.Equal("p-/opt/jarvis-test", c.Components[0].Args[1]);
        Assert.Equal("x-/opt/jarvis-test", c.Components[0].ReadyPipe);
        var example = LauncherConfig.Load(Path.Combine(AppContext.BaseDirectory, "../../../../Jarvis.Launcher/launcher.example.json"));
        Assert.All(example.Components.Take(2), comp => Assert.NotNull(comp.ReadyPipe));
    }

    [Fact]
    public void BackoffIsExponentialAndCapped()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), Supervisor.Backoff(1));
        Assert.Equal(TimeSpan.FromSeconds(8), Supervisor.Backoff(4));
        Assert.Equal(TimeSpan.FromSeconds(60), Supervisor.Backoff(20));
        Assert.Equal(["/Create", "/TN", "JARVIS Launcher", "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", "\"C:\\x\\jarvis-launcher.exe\""], LogonTask.CreateArgs("C:\\x\\jarvis-launcher.exe"));
    }
}

public class ExecHostServerTests
{
    private const string Secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static readonly byte[] Key = Convert.FromHexString("aa112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

    [Fact]
    public async Task HelloIsRequiredThenSignedInvocationsRun()
    {
        var pipe = $"jarvis-test-{Guid.NewGuid():N}";
        using var cts = new CancellationTokenSource();
        var server = new ExecHostServer(pipe, Secret, Path.Combine(Path.GetTempPath(), "jv-trash"));
        var serve = server.RunAsync(cts.Token);
        var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(5000);
        var ch = new JsonRpcChannel(client);
        _ = ch.RunAsync(cts.Token);
        await Assert.ThrowsAsync<JarvisException>(() => ch.CallAsync("ping", new { }));
        await Assert.ThrowsAsync<JarvisException>(() => ch.CallAsync("hello", new { secret = "wrong" }));
        var hello = await ch.CallAsync("hello", new { protocol_version = "1.0", component = "core", secret = Secret });
        Assert.Equal("jarvis-exec", hello!["host"]!.GetValue<string>());
        await ch.CallAsync("configure", new { grant_key_hex = Convert.ToHexString(Key) });
        var paramsRaw = "{\"args\":[\"-c\",\"echo nep-ok\"],\"cwd\":\"" + Path.GetTempPath().TrimEnd('/') + "\",\"env_allowlist\":[],\"job_limits\":{},\"max_output_bytes\":1000,\"program\":\"/bin/sh\",\"tier\":\"T1\",\"timeout_s\":10}";
        var exp = DateTimeOffset.UtcNow.AddMinutes(5).ToString("o");
        var sig = GrantSignature.Sign(Key, GrantSignature.Payload("inv_x", "tool:shell.run@1.0.0", GrantSignature.ParamsSha256(paramsRaw), exp, "idk_x", 1, 1));
        var invJson = "{\"invocation_id\":\"inv_x\",\"capability\":\"tool:shell.run@1.0.0\",\"params\":" + paramsRaw + ",\"grant\":{\"decision_id\":\"grt\",\"signature\":\"" + sig + "\",\"fingerprint\":\"f\",\"expires_at\":\"" + exp + "\"},\"task_revision\":1,\"policy_revision\":1,\"idempotency_key\":\"idk_x\",\"deadline\":\"" + DateTimeOffset.UtcNow.AddMinutes(1).ToString("o") + "\"}";
        var res = await ch.CallAsync("nep.invoke", JsonNode.Parse(invJson));
        Assert.Equal("ok", res!["status"]!.GetValue<string>());
        Assert.Contains("nep-ok", res["output"]!["output"]!.GetValue<string>());
        var again = await ch.CallAsync("nep.invoke", JsonNode.Parse(invJson));
        Assert.Equal(res.ToJsonString(), again!.ToJsonString());   // idempotent re-delivery
        var status = await ch.CallAsync("nep.status", new { invocation_id = "inv_x" });
        Assert.Equal("done", status!["state"]!.GetValue<string>());
        var tampered = invJson.Replace("echo nep-ok", "echo pwned").Replace("inv_x", "inv_y");
        var ex = await Assert.ThrowsAsync<JarvisException>(() => ch.CallAsync("nep.invoke", JsonNode.Parse(tampered)));
        Assert.Equal(ErrorCodes.MissingPermission, ex.Code);
        cts.Cancel();
    }
}
