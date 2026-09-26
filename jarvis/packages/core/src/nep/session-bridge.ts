import type { CoreContext } from "../context.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { LeaseManager } from "../tasks/leases.js";
import type { Broker } from "../broker/broker.js";

export interface SessionBridgeHooks {
  onPushToTalk?(down: boolean): void;
  onResume?(): void;                 // clock-jump detection, reconciliation, missed runs (Scheduler, Phase 7)
}

/**
 * Applies Session Agent events to the core (01 §4.4): lock revokes the desktop input lease
 * and makes desktop capabilities unavailable while background work continues; the
 * emergency-stop hotkey halts dispatch; suspend and resume drive recovery.
 */
export class SessionBridge {
  state: "unlocked" | "locked" | "asleep_expected" | "offline" = "unlocked";
  constructor(private ctx: CoreContext, private registry: CapabilityRegistry, private leases: LeaseManager, private broker: Broker, private hooks: SessionBridgeHooks = {}) {}

  handle(method: string, _params: unknown): void {
    switch (method) {
      case "session.lock": case "session.disconnect":
        this.state = "locked";
        this.leases.revoke(l => l.resource.startsWith("desktop:"), "lock");
        this.registry.onNodeAvailability("locked");
        break;
      case "session.unlock": case "session.connect":
        this.state = "unlocked";
        this.registry.onNodeAvailability("unlocked");
        break;
      case "power.suspend":
        this.state = "asleep_expected";
        this.leases.revoke(l => l.resource.startsWith("desktop:"), "lock");
        this.registry.onNodeAvailability("asleep_expected");
        break;
      case "power.resume":
        this.state = "locked";   // Windows usually resumes to the lock screen; unlock arrives separately
        this.registry.onNodeAvailability("locked");
        this.hooks.onResume?.();
        break;
      case "hotkey.emergency_stop":
        this.broker.halt("emergency-stop hotkey");
        this.leases.revoke(l => l.resource.startsWith("desktop:"), "emergency_stop");
        break;
      case "hotkey.ptt_down": this.hooks.onPushToTalk?.(true); break;
      case "hotkey.ptt_up": this.hooks.onPushToTalk?.(false); break;
      default: return;
    }
    this.ctx.events.append({ type: "session.event", summary: method, data: { method, state: this.state } });
  }
}
