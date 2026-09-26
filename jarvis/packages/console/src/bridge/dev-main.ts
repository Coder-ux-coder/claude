import { join } from "node:path";
import { componentPipe, pipePath } from "@jarvis/core/rpc";
import { CoordinatorLink } from "./coordinator-link.js";
import { DevBridge } from "./dev-bridge.js";
import { WhisperCppAdapter } from "../main/whisper.js";

/**
 * Runs the Console in an ordinary browser for development:
 *   JARVIS_DEV_SESSION_SECRET=… node dist/bridge/dev-main.js
 * then open the printed URL (loopback only; the token is in the URL fragment).
 */
const secret = process.env.JARVIS_DEV_SESSION_SECRET;
if (!secret || secret.length < 32) { console.error("set JARVIS_DEV_SESSION_SECRET (the Coordinator's session secret)"); process.exit(2); }
const link = new CoordinatorLink(pipePath(componentPipe("core")), secret);
const stt = process.env.JARVIS_WHISPER_BIN && process.env.JARVIS_WHISPER_MODEL ? new WhisperCppAdapter({ binary: process.env.JARVIS_WHISPER_BIN, model: process.env.JARVIS_WHISPER_MODEL }) : null;
const bridge = new DevBridge({ link, staticDir: join(import.meta.dirname, "..", "renderer"), stt, port: Number(process.env.JARVIS_DEV_PORT ?? 0) });
await bridge.listen();
void link.start().catch(e => console.error(`coordinator: ${(e as Error).message}`));
console.log(`JARVIS Console (dev): ${bridge.url}`);
