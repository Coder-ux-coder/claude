import type {
  DuplicateCheck, ExportPreview, ExtractResult, Lead, LeadDraft,
  NextAction, PlatformId, SearchItem, SearchPayload, Stats, ValidateResult,
} from "./types";

/** An error carrying the backend's own plain-language message. */
export class ApiError extends Error {
  status: number;
  field?: string | null;
  code?: string | null;
  lead?: Lead | null;

  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.field = (body?.field as string) ?? null;
    this.code = (body?.code as string) ?? null;
    this.lead = (body?.lead as Lead) ?? null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(
      "Cannot reach the backend. Check that the API window is still running on http://127.0.0.1:8000",
      0,
    );
  }

  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await response.json();
    } catch {
      /* a non-JSON error body is replaced by the readable message below */
    }
    const message =
      (body.message as string) ||
      (typeof body.detail === "string" ? body.detail : "") ||
      `The request failed (HTTP ${response.status}).`;
    throw new ApiError(message, response.status, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  stats: () => request<Stats>("/stats"),

  listLeads: (params: { q?: string; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.status && params.status !== "all") query.set("status", params.status);
    const suffix = query.toString() ? `?${query}` : "";
    return request<{ leads: Lead[] }>(`/leads${suffix}`).then((r) => r.leads);
  },

  getLead: (id: number) => request<Lead>(`/leads/${id}`),

  createLead: (draft: LeadDraft) =>
    post<{ lead: Lead; hints: string[]; next_action: NextAction }>("/leads", draft),

  updateLead: (id: number, patch: Partial<LeadDraft>) =>
    request<{ lead: Lead; demoted: boolean; message: string | null; hints: string[] }>(
      `/leads/${id}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  approve: (id: number) => post<{ lead: Lead }>(`/leads/${id}/approve`, {}).then((r) => r.lead),
  unapprove: (id: number) => post<{ lead: Lead }>(`/leads/${id}/unapprove`, {}).then((r) => r.lead),
  deleteLead: (id: number) => request<{ deleted: number }>(`/leads/${id}`, { method: "DELETE" }),
  bulkDelete: (ids: number[]) => post<{ deleted: number }>("/leads/bulk-delete", { ids }),

  validate: (draft: Partial<LeadDraft>) => post<ValidateResult>("/validate", draft),
  checkDuplicate: (profile_url: string, exclude_id?: number) =>
    post<DuplicateCheck>("/leads/check-duplicate", { profile_url, exclude_id: exclude_id ?? null }),
  nextAction: (draft: LeadDraft) => post<NextAction>("/next-action", draft),

  searches: (platform: PlatformId, topic: string) =>
    request<SearchPayload>(`/searches?platform=${platform}&topic=${encodeURIComponent(topic)}`),
  emailSearches: (profile_url: string) =>
    post<{ identifier: string; searches: SearchItem[] }>("/searches/email", { profile_url }),

  extract: (text: string) => post<ExtractResult>("/extract", { text }),
  exportPreview: () => request<ExportPreview>("/export/preview"),
};
