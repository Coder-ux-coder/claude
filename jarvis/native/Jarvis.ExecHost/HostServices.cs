using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Jarvis.Contracts;

namespace Jarvis.ExecHost;

/// <summary>Deletes go to the Recycle Bin (05 §11.11), so they are recoverable. Elsewhere: a trash folder with a restore manifest.</summary>
public static class RecycleBin
{
    public static string Delete(string path, string fallbackTrashDir)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full) && !Directory.Exists(full)) throw new JarvisException(ErrorCodes.InvalidInput, "not found");
        if (OperatingSystem.IsWindows())
        {
            var op = new Shell.SHFILEOPSTRUCT { wFunc = Shell.FO_DELETE, pFrom = full + "\0\0", fFlags = Shell.FOF_ALLOWUNDO | Shell.FOF_NOCONFIRMATION | Shell.FOF_SILENT | Shell.FOF_NOERRORUI };
            var rc = Shell.SHFileOperation(ref op);
            if (rc != 0 || op.fAnyOperationsAborted) throw new JarvisException(ErrorCodes.ExternalRefusal, $"the shell refused to recycle the file (code {rc})");
            return "recycle_bin";
        }
        Directory.CreateDirectory(fallbackTrashDir);
        var dest = Path.Combine(fallbackTrashDir, $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Path.GetFileName(full)}");
        if (File.Exists(full)) File.Move(full, dest); else Directory.Move(full, dest);
        File.WriteAllText(dest + ".restore.json", System.Text.Json.JsonSerializer.Serialize(new { original = full, at = DateTimeOffset.UtcNow }));
        return dest;
    }

    private static class Shell
    {
        public const uint FO_DELETE = 3;
        public const ushort FOF_SILENT = 0x4, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40, FOF_NOERRORUI = 0x400;
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct SHFILEOPSTRUCT { public IntPtr hwnd; public uint wFunc; public string pFrom; public string? pTo; public ushort fFlags; [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string? lpszProgressTitle; }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
    }
}

/// <summary>DPAPI (CurrentUser) wraps JARVIS's master key (03 §9.14). Windows only.</summary>
public static class Dpapi
{
    private static readonly byte[] Entropy = "jarvis/master-key/v1"u8.ToArray();
    public static byte[] Protect(byte[] data)
    {
        if (!OperatingSystem.IsWindows()) throw new JarvisException(ErrorCodes.UnsupportedOperation, "DPAPI exists only on Windows");
        return ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser);
    }
    public static byte[] Unprotect(byte[] blob)
    {
        if (!OperatingSystem.IsWindows()) throw new JarvisException(ErrorCodes.UnsupportedOperation, "DPAPI exists only on Windows");
        try { return ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.CurrentUser); }
        catch (CryptographicException) { throw new JarvisException(ErrorCodes.InternalError, "DPAPI could not unwrap the key (different Windows user or profile?)"); }
    }
}
