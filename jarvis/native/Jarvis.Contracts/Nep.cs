using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jarvis.Contracts;

/// <summary>Node Execution Protocol (docs/jarvis/12-stack-and-contracts.md §17.6). Field names match the JSON Schema in jarvis/schemas/nep.</summary>
public static class Nep
{
    public const string ProtocolVersion = "1.0";
}

public sealed record NepGrant(
    [property: JsonPropertyName("decision_id")] string DecisionId,
    [property: JsonPropertyName("signature")] string Signature,
    [property: JsonPropertyName("fingerprint")] string Fingerprint,
    [property: JsonPropertyName("expires_at")] string ExpiresAt);

public sealed record NepLease(
    [property: JsonPropertyName("lease_id")] string LeaseId,
    [property: JsonPropertyName("fencing_token")] long FencingToken);

public sealed class NepInvoke
{
    [JsonPropertyName("invocation_id")] public string InvocationId { get; set; } = "";
    [JsonPropertyName("action_id")] public string? ActionId { get; set; }
    [JsonPropertyName("capability")] public string Capability { get; set; } = "";
    [JsonPropertyName("params")] public JsonElement Params { get; set; }
    [JsonPropertyName("grant")] public NepGrant? Grant { get; set; }
    [JsonPropertyName("lease")] public NepLease? Lease { get; set; }
    [JsonPropertyName("task_revision")] public long TaskRevision { get; set; }
    [JsonPropertyName("policy_revision")] public long PolicyRevision { get; set; }
    [JsonPropertyName("idempotency_key")] public string IdempotencyKey { get; set; } = "";
    [JsonPropertyName("deadline")] public string Deadline { get; set; } = "";
}

/// <summary>Shared error vocabulary (05 §11.6).</summary>
public static class ErrorCodes
{
    public const string InvalidInput = "invalid_input", MissingPermission = "missing_permission", UnsupportedOperation = "unsupported_operation",
        TransientServiceError = "transient_service_error", UncertainExternalEffect = "uncertain_external_effect", Conflict = "conflict",
        Timeout = "timeout", Expired = "expired", Cancelled = "cancelled", InternalError = "internal_error", PreconditionChanged = "precondition_changed",
        ExternalRefusal = "external_refusal";
}

public sealed record StructuredError(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("retryable")] bool Retryable,
    [property: JsonPropertyName("effect_state")] string EffectState,
    [property: JsonPropertyName("source")] ErrorSource Source,
    [property: JsonPropertyName("details")] Dictionary<string, object?>? Details = null);

public sealed record ErrorSource(
    [property: JsonPropertyName("capability_id")] string CapabilityId,
    [property: JsonPropertyName("executor")] string Executor,
    [property: JsonPropertyName("node_id")] string NodeId);

/// <summary>An executor's result; the Coordinator turns it into a ToolResult.</summary>
public sealed class ExecResult
{
    [JsonPropertyName("status")] public string Status { get; set; } = "ok";
    [JsonPropertyName("effect_state")] public string EffectState { get; set; } = "none";
    [JsonPropertyName("output")] public object? Output { get; set; }
    [JsonPropertyName("error")] public StructuredError? Error { get; set; }
    [JsonPropertyName("evidence")] public List<Dictionary<string, object?>> Evidence { get; set; } = new();
}

public sealed class JarvisException(string code, string message, string effectState = "none") : Exception(message)
{
    public string Code { get; } = code;
    public string EffectState { get; } = effectState;
    public StructuredError ToStructured(string capability, string executor) =>
        new(Code, Message, Code is ErrorCodes.TransientServiceError or ErrorCodes.Conflict, EffectState, new ErrorSource(capability, executor, "node_local"));
}
