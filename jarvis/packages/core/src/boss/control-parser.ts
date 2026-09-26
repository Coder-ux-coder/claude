/**
 * Deterministic control-command parser (02 §7.3): "stop", "pause", "cancel that",
 * "stop talking", "resume". Applied before any model call, so control never waits on
 * a model and cannot be misread by one.
 */
export type ControlCommand =
  | { op: "emergency_stop" } | { op: "stop_speaking" }
  | { op: "pause" | "resume" | "cancel"; target: "focus" | "all" };

const NORM = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

export function parseControl(text: string): ControlCommand | null {
  const t = NORM(text);
  if (/^(jarvis )?(emergency stop|stop everything|stop all automation|halt)$/.test(t)) return { op: "emergency_stop" };
  if (/^(stop talking|be quiet|quiet|shush|stop speaking|shut up)$/.test(t)) return { op: "stop_speaking" };
  if (/^(stop|pause)( it| that| this| the task)?$/.test(t)) return { op: "pause", target: "focus" };
  if (/^(pause|stop) (all|everything)( tasks)?$/.test(t)) return { op: "pause", target: "all" };
  if (/^(resume|continue|carry on|go ahead)( it| that| the task)?$/.test(t)) return { op: "resume", target: "focus" };
  if (/^(cancel|abort|nevermind|never mind|forget it)( it| that| this| the task)?$/.test(t)) return { op: "cancel", target: "focus" };
  return null;
}
