import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimClock, type EffectClass, type TaskMode } from "@jarvis/shared";
import { createContext } from "../../src/context.js";
import { TaskEngine, type NewTaskInput } from "../../src/tasks/task-engine.js";
import { ActionService } from "../../src/tasks/actions.js";
import { LeaseManager } from "../../src/tasks/leases.js";
import { MemoryService } from "../../src/memory/memory-service.js";
import { EpisodicStore } from "../../src/memory/episodic.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { CapabilityRegistry } from "../../src/registry/registry.js";
import { CredentialVault } from "../../src/vault/vault.js";
import { EvidenceStore, Verifier } from "../../src/verifier/verifier.js";
import { Broker } from "../../src/broker/broker.js";
import { FilesExecutor } from "../../src/executors/files.js";
import { ShellExecutor } from "../../src/executors/shell.js";
import { BUILTIN_CAPABILITIES } from "../../src/executors/builtins.js";
import { MailSim, MAIL_DESCRIPTOR } from "../sim/mail-sim.js";
import { BookingSim, BOOKING_DESCRIPTOR } from "../sim/booking-sim.js";
import { contract } from "./fixtures.js";

export function coreHarness() {
  const clock = new SimClock("2026-10-01T09:00:00Z");
  const ctx = createContext({ clock });
  const tasks = new TaskEngine(ctx), actions = new ActionService(ctx), leases = new LeaseManager(ctx);
  tasks.actions = actions; tasks.leases = leases;
  const memory = new MemoryService(ctx), episodic = new EpisodicStore(ctx);
  memory.entities.ensureOwner("HYPOTHETICAL Owner");
  const conv = episodic.startConversation("console");
  const policy = new PolicyEngine(ctx, {
    messageTrust: id => episodic.getMessage(id)?.trust as "owner_verified" | undefined,
    memoryRecordTrusted: id => { const r = memory.get(id); return !!r && r.status === "active" && r.provenance.source_trust === "owner_verified"; },
  });
  const registry = new CapabilityRegistry(ctx);
  const vault = new CredentialVault(null, ctx.keys, clock);
  const evidence = new EvidenceStore(ctx);
  const verifier = new Verifier(ctx, evidence);
  const broker = new Broker(ctx, tasks, actions, leases, policy, registry, memory, vault, evidence, verifier);
  const dir = mkdtempSync(join(tmpdir(), "jv-core-"));
  const files = new FilesExecutor(join(dir, "recovery-bin"), join(dir, "trash"));
  const mail = new MailSim(), booking = new BookingSim();
  for (const d of [...BUILTIN_CAPABILITIES, MAIL_DESCRIPTOR, BOOKING_DESCRIPTOR]) registry.register(d, { via: "builtin" });
  broker.registerExecutor(files); broker.registerExecutor(new ShellExecutor()); broker.registerExecutor(mail); broker.registerExecutor(booking);
  const ownerSays = (text: string) => episodic.addMessage({ conversation_id: conv.id, author: "owner", channel: "console", trust: "owner_verified", modality: "text", text });
  /** Creates a running task whose origin cites the given owner message. */
  const task = (mode: TaskMode, effects: EffectClass[], extra: Partial<NewTaskInput> = {}, messageText = "HYPOTHETICAL request") => {
    const m = ownerSays(messageText);
    const c = contract(mode, effects, { origin: { channel: "console_text", conversation_id: conv.id, message_ids: [m.id], owner_verified: true },
      scope: { resources: [{ path_prefix: join(dir, "work") }], accounts: [], exclusions: [] }, ...extra });
    const t = tasks.create(c);
    tasks.transition(t.task_id, "planned"); tasks.transition(t.task_id, "running");
    return { task: tasks.require(t.task_id), message_id: m.id };
  };
  return { ctx, clock, tasks, actions, leases, memory, episodic, policy, registry, vault, evidence, verifier, broker, files, mail, booking, dir, conv, ownerSays, task };
}
