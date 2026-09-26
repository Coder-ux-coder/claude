import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, session, type IpcMainInvokeEvent } from "electron";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { componentPipe, pipePath } from "@jarvis/core/rpc";
import { CoordinatorLink } from "../bridge/coordinator-link.js";
import { WhisperCppAdapter } from "./whisper.js";

/**
 * Console main process (09 §14.1; 12 §17.1 Electron hardening): contextIsolation, a
 * sandboxed renderer without Node, no navigation away from the bundled page, and only the
 * microphone permission. Every Coordinator call goes through this process over the
 * per-user pipe with the Launcher's session secret.
 */
const RENDERER = join(import.meta.dirname, "..", "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER).href;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

async function readSecret(): Promise<string> {
  if (process.env.JARVIS_DEV_SESSION_SECRET) return process.env.JARVIS_DEV_SESSION_SECRET;
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolve, reject) => {
    rl.once("line", l => resolve(l.trim()));
    rl.once("close", () => reject(new Error("no session secret on stdin")));
  });
}

function appDir(): string { return join(process.env.LOCALAPPDATA ?? app.getPath("appData"), "Jarvis"); }

function trustedSender(e: IpcMainInvokeEvent): boolean {
  return !!e.senderFrame && e.senderFrame.url.split("#")[0] === RENDERER_URL;
}

function createWindow(showNow: boolean): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100, height: 780, show: showNow, title: "JARVIS",
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true },
  });
  w.removeMenu();
  w.webContents.on("will-navigate", e => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-attach-webview", e => e.preventDefault());
  w.on("close", e => { if (!quitting) { e.preventDefault(); w.hide(); } });        // closing hides to the tray
  void w.loadFile(RENDERER);
  return w;
}

async function start(): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const secret = await readSecret();
  await app.whenReady();
  // Only the microphone (push-to-talk), only for our page.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === "media" && wc.getURL().split("#")[0] === RENDERER_URL));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && origin.startsWith("file://"));

  const link = new CoordinatorLink(pipePath(componentPipe("core")), secret);
  const stt = new WhisperCppAdapter({
    binary: process.env.JARVIS_WHISPER_BIN ?? join(appDir(), "app", "current", "whisper", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"),
    model: process.env.JARVIS_WHISPER_MODEL ?? join(appDir(), "models", "ggml-base.en.bin"),
  });

  ipcMain.handle("jarvis:call", async (e, method: unknown, params: unknown) => {
    if (!trustedSender(e)) throw new Error("untrusted sender");
    if (typeof method !== "string") throw new Error("method must be a string");
    try { return { result: await link.call(method, params) }; }
    catch (err) { return { error: { code: (err as { code?: string }).code ?? "internal_error", message: (err as Error).message } }; }
  });
  ipcMain.handle("jarvis:transcribe", async (e, wav: unknown) => {
    if (!trustedSender(e)) throw new Error("untrusted sender");
    if (!(wav instanceof Uint8Array)) return { error: { code: "invalid_input", message: "audio must be bytes" } };
    try { return { result: await stt.transcribe(wav) }; }
    catch (err) { return { error: { code: (err as { code?: string }).code ?? "internal_error", message: (err as Error).message } }; }
  });

  win = createWindow(!process.argv.includes("--tray"));
  link.onEvent(ev => win?.webContents.send("jarvis:event", ev));
  link.onConnection(s => win?.webContents.send("jarvis:connection", s));
  void link.start().catch(err => win?.webContents.send("jarvis:connection", "reconnecting") ?? console.error(err));

  tray = new Tray(nativeImage.createFromPath(join(import.meta.dirname, "..", "renderer", "icon.png")));
  tray.setToolTip("JARVIS");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open JARVIS", click: () => { win?.show(); win?.focus(); } },
    { type: "separator" },
    { label: "Stop everything", click: () => { void link.call("emergency.stop", {}).catch(() => {}); } },
    { label: "Quit Console", click: () => { quitting = true; link.stop(); app.quit(); } },
  ]));
  tray.on("click", () => { win?.show(); win?.focus(); });
  app.on("second-instance", () => { win?.show(); win?.focus(); });
  // The Launcher closes stdin to stop us.
  process.stdin.on("end", () => { quitting = true; link.stop(); app.quit(); });
}

void start().catch(e => { console.error(`jarvis-console: ${(e as Error).message}`); app.exit(1); });
