using System.Diagnostics;
using Jarvis.Launcher;

// jarvis-launcher [--config launcher.json] [--install-logon-task | --uninstall-logon-task]
var configPath = Path.Combine(AppContext.BaseDirectory, "launcher.json");
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--config" when i + 1 < args.Length: configPath = args[++i]; break;
        case "--install-logon-task" or "--uninstall-logon-task":
        {
            if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("logon tasks exist only on Windows"); return 2; }
            var a = args[i] == "--install-logon-task" ? LogonTask.CreateArgs(Environment.ProcessPath!) : LogonTask.DeleteArgs();
            var psi = new ProcessStartInfo("schtasks.exe") { UseShellExecute = false };
            foreach (var x in a) psi.ArgumentList.Add(x);
            using var p = Process.Start(psi)!;
            p.WaitForExit();
            return p.ExitCode;
        }
        case "--version": Console.WriteLine("0.1.0"); return 0;
    }
}
if (!File.Exists(configPath)) { Console.Error.WriteLine($"no launcher config at {configPath}"); return 2; }
var sup = new Supervisor(LauncherConfig.Load(configPath), new ProcessStarter());
sup.Log += m => Console.Error.WriteLine($"[launcher {DateTimeOffset.Now:HH:mm:ss}] {m}");
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
await sup.RunAsync(cts.Token);
return 0;
