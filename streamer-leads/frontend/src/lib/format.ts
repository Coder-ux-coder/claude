/** Small display helpers shared across the workspace. */

export const NOT_ENTERED = "Not entered";

export function formatFollowers(lead: {
  follower_count: number | null;
  follower_approximate: boolean;
}): string {
  if (lead.follower_count === null) return NOT_ENTERED;
  const number = lead.follower_count.toLocaleString("en-US");
  // An abbreviated entry such as "1.2K" is a rounded figure, and is shown as one.
  return lead.follower_approximate ? `≈ ${number}` : number;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

export function shortUrl(url: string, max = 52): string {
  const trimmed = url.replace(/^https?:\/\/(www\.)?/, "");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Open a URL in a new browser tab. Always driven by an explicit click. */
export function openTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is unavailable (or blocked): fall back to a hidden textarea.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export const STATUS_META = {
  incomplete: { label: "Incomplete", className: "bg-amber-500/15 text-amber-300 border border-amber-500/25" },
  ready: { label: "Ready for review", className: "bg-sky-500/15 text-sky-300 border border-sky-500/25" },
  approved: { label: "Approved", className: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25" },
} as const;
