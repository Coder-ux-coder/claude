import { createRoot } from "react-dom/client";
import type { JarvisApi } from "../shared/api.js";
import { App } from "./App.js";
import { createWebApi } from "./web-api.js";

declare global { interface Window { jarvis?: JarvisApi } }

// Electron injects window.jarvis through its preload; in a browser, the dev bridge token
// comes in the URL fragment (never sent to the server in the request line) and is then removed.
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) history.replaceState(null, "", location.pathname);
const api = window.jarvis ?? (token ? createWebApi(token) : null);
const root = createRoot(document.getElementById("root")!);
root.render(api ? <App api={api} /> : <p className="banner error">Not connected: open the Console from JARVIS.</p>);
