using Jarvis.Contracts;
using Jarvis.ExecHost;

// jarvis-exec: started by the Launcher, which writes the per-boot session secret as the first line of stdin.
var pipe = Handshake.PipeName("exec");
string? secret = Environment.GetEnvironmentVariable("JARVIS_DEV_SESSION_SECRET");
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--pipe" && i + 1 < args.Length) pipe = args[++i];
    if (args[i] == "--version") { Console.WriteLine(ExecHostServer.Version); return 0; }
}
secret ??= Console.In.ReadLine();
if (string.IsNullOrWhiteSpace(secret) || secret.Length < 32) { Console.Error.WriteLine("jarvis-exec: missing session secret"); return 2; }
var trash = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jarvis", "trash");
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
AppDomain.CurrentDomain.ProcessExit += (_, _) => cts.Cancel();
Console.Error.WriteLine($"jarvis-exec {ExecHostServer.Version} listening on {pipe}");
await new ExecHostServer(pipe, secret, trash).RunAsync(cts.Token);
return 0;
