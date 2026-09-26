// One browser view and one phone view for the whole app. Whoever shows it
// (a page or the side panel) "claims" it; the previous place lets go.

import { bus } from './ui.js';
import { LiveBrowser, LivePhone } from './live.js';

let browserView = null;
let phoneView = null;

export const liveBrowser = () => (browserView ||= new LiveBrowser());
export const livePhone = () => (phoneView ||= new LivePhone());

export function mountLive(kind, container, owner) {
  bus.emit('live:claim', { kind, owner });
  const view = kind === 'browser' ? liveBrowser() : livePhone();
  view.mount(container);
  return () => {
    if (view.root.parentNode === container) view.unmount();
  };
}
