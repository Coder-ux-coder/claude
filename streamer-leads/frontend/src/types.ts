export type LeadStatus = "incomplete" | "ready" | "approved";

export interface Lead {
  id: number;
  profile_url: string;
  url_key: string;
  follower_count: number | null;
  follower_raw: string;
  follower_approximate: boolean;
  email_address: string | null;
  status: LeadStatus;
  created_at: string;
  updated_at: string;
}

export interface Stats {
  total: number;
  incomplete: number;
  ready: number;
  approved: number;
  complete: number;
}

export interface NextAction {
  state: "need_profile" | "need_followers" | "need_email" | "review" | "approved";
  message: string;
}

export interface FieldCheck {
  ok: boolean;
  value: string | number | null;
  message: string | null;
  hints?: string[];
  identifier?: string;
  approximate?: boolean;
  key?: string;
}

export interface ValidateResult {
  profile_url: FieldCheck | null;
  follower_count: FieldCheck | null;
  email_address: FieldCheck | null;
}

export interface DuplicateCheck {
  valid: boolean;
  duplicate: boolean;
  normalized_url?: string;
  identifier?: string;
  hints?: string[];
  lead: Lead | null;
  message: string | null;
}

export interface SearchItem {
  query: string;
  note: string;
  url: string;
}

export interface Topic {
  id: string;
  label: string;
  term: string;
}

export interface PlatformInfo {
  label: string;
  home_url: string;
  home_label: string;
}

export interface SearchPayload {
  platform: PlatformInfo;
  topics: Topic[];
  searches: SearchItem[];
}

export interface FollowerCandidate {
  raw: string;
  value: number;
  approximate: boolean;
  context: string;
}

export interface EmailCandidate {
  email: string;
  context: string;
}

export interface ExtractResult {
  follower_candidates: FollowerCandidate[];
  email_candidates: EmailCandidate[];
  notes: string[];
}

export interface ExportPreview {
  headers: string[];
  rows: string[][];
  counts: Stats;
  approximate_follower_rows: number;
  filename: string;
}

export type PlatformId = "whatnot" | "ebay_live";
export type LeadDraft = { profile_url: string; follower_count: string; email_address: string };
