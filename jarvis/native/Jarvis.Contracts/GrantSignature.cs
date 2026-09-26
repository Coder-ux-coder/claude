using System.Security.Cryptography;
using System.Text;

namespace Jarvis.Contracts;

/// <summary>
/// Executor-side grant check (12 §17.6): the Coordinator signs the invocation, capability,
/// the exact bytes of the params, expiry, idempotency key and revisions with a key shared over
/// the authenticated pipe. The executor hashes the params text exactly as received, so no
/// cross-language JSON canonicalisation is needed.
/// </summary>
public static class GrantSignature
{
    public static string ParamsSha256(string rawParamsJson) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rawParamsJson))).ToLowerInvariant();

    public static string Payload(string invocationId, string capability, string paramsSha256, string expiresAt, string idempotencyKey, long taskRevision, long policyRevision) =>
        string.Join('\n', invocationId, capability, paramsSha256, expiresAt, idempotencyKey, taskRevision, policyRevision);

    public static string Sign(byte[] key, string payload) => Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();

    /// <summary>Returns null when valid, or the reason it is not.</summary>
    public static string? Verify(byte[] key, NepInvoke inv, DateTimeOffset now)
    {
        if (inv.Grant is null) return "no grant";
        if (!DateTimeOffset.TryParse(inv.Grant.ExpiresAt, out var exp)) return "bad expiry";
        if (exp <= now) return "grant expired";
        var payload = Payload(inv.InvocationId, inv.Capability, ParamsSha256(inv.Params.GetRawText()), inv.Grant.ExpiresAt, inv.IdempotencyKey, inv.TaskRevision, inv.PolicyRevision);
        var expected = Convert.FromHexString(Sign(key, payload));
        byte[] given;
        try { given = Convert.FromHexString(inv.Grant.Signature); } catch (FormatException) { return "bad signature"; }
        return CryptographicOperations.FixedTimeEquals(expected, given) ? null : "signature mismatch";
    }
}
