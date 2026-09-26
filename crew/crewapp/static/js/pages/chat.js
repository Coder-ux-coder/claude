// The Assistant: a conversation that streams word by word, uses the browser and
// the phone, makes files you can preview, reads answers aloud and talks with you.

import { h, icon, btn, iconBtn, api, stream, opened, toast, fail, confirmBox, dialog, store, bus, markdown, ago,
  autosize, isSmall, copyText, bytes } from '../ui.js';
import { dictate, canDictate, canSpeak, speech, conversation, stopDictation } from '../voice.js';

export const EFFORT_LABELS = { low: 'Quick', medium: 'Balanced', high: 'Thorough', xhigh: 'Very thorough', max: 'Maximum' };

export function modelOptions() {
  const ov = store.overview || {};
  const known = Object.fromEntries((ov.known_models || []).map((m) => [m.id, m.label]));
  const allowed = (ov.models && ov.models.allowed && ov.models.allowed.length) ? ov.models.allowed : Object.keys(known);
  return allowed.map((id) => ({ value: id, label: known[id] || id }));
}

const FILE_ICONS = { web: 'globe', doc: 'doc', image: 'image', pdf: 'doc', table: 'table', file: 'doc' };

export function assistant(view, params) {
  const page = new ChatPage(view, params[0]);
  return () => page.destroy();
}

class ChatPage {
  constructor(view, id) {
    this.view = view;
    this.id = id && id !== 'new' ? id : null;
    this.chat = null;
    this.attachments = [];
    this.uploads = 0;
    this.live = null;
    this.es = null;
    this.busy = false;
    this.voice = null;
    this.alive = true;
    this.build();
    const pending = store.pendingChat;
    store.pendingChat = null;
    const talk = store.pendingTalk;
    store.pendingTalk = false;
    (this.id ? this.load() : Promise.resolve(this.renderEmpty())).then(() => {
      if (!this.alive) return;
      if (pending) {
        this.attachments = pending.attachments || [];
        this.renderAtts();
        this.ta.value = pending.text || '';
        this.fit();
        if (pending.text) this.send();
      }
      if (talk) this.talk();
    });
  }

  // ---------------------------------------------------------------- layout

  build() {
    const ov = store.overview || {};
    const app = ov.app || {};
    this.title = h('h2', null, 'New conversation');
    this.model = h('select', { class: 'mini', 'aria-label': 'Model', title: 'Which model answers' },
      modelOptions().map((o) => h('option', { value: o.value }, o.label)));
    this.model.value = app.chat_model || 'claude-opus-5-5';
    this.effort = h('select', { class: 'mini', 'aria-label': 'Effort', title: 'How hard it thinks' },
      (ov.efforts || Object.keys(EFFORT_LABELS)).map((e) => h('option', { value: e }, EFFORT_LABELS[e] || e)));
    this.effort.value = app.chat_effort || 'high';
    this.teamBtn = h('button', { class: 'btn sm', type: 'button', title: 'Build this with the team', onclick: () => this.toTeam() }, icon('users'), h('span', { class: 'label' }, 'Build this with the team'));
    this.moreBtn = iconBtn('dots', 'More', () => this.more());
    const head = h('div', { class: 'chat-head' }, this.title,
      h('div', { class: 'tools' }, this.model, this.effort,
        canDictate && canSpeak ? iconBtn('wave', 'Talk — a voice conversation', () => this.talk()) : null,
        iconBtn('globe', 'Show the browser', () => bus.emit('panel:open', 'browser')),
        this.teamBtn, this.moreBtn));
    this.list = h('div', { class: 'chat-list' });
    this.scroller = h('div', { class: 'chat-scroll' }, this.list);

    this.ta = h('textarea', { rows: 1, placeholder: 'Message the assistant…', 'aria-label': 'Message' });
    this.fit = autosize(this.ta, 0.35);
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!e.shiftKey && !isSmall()))) { e.preventDefault(); this.send(); }
    });
    this.ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData && e.clipboardData.files || [])];
      if (files.length) { e.preventDefault(); files.forEach((f) => this.upload(f)); }
    });
    this.atts = h('div', { class: 'atts' });
    this.fileIn = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: (e) => { [...e.target.files].forEach((f) => this.upload(f)); e.target.value = ''; } });
    this.mic = iconBtn('mic', 'Speak instead of typing', () => dictate(this.ta, this.mic));
    this.mic.classList.add('mic');
    if (!canDictate) this.mic.classList.add('hidden');
    this.sendBtn = btn('', () => (this.busy ? this.stop() : this.send()), { cls: 'primary icon', ic: 'send', title: 'Send' });
    const composer = h('div', { class: 'composer' }, this.atts, this.ta,
      h('div', { class: 'tools' }, iconBtn('clip', 'Attach files or pictures', () => this.fileIn.click()), this.fileIn,
        h('span', { class: 'grow muted small hint' }, isSmall() ? '' : 'Enter to send · Shift+Enter for a new line'), this.mic, this.sendBtn));
    this.root = h('div', { class: 'chat' }, head, this.scroller, h('div', { class: 'chat-foot' }, composer));
    this.view.append(this.root);
    this.view.style.overflow = 'hidden';

    // Drag and drop files anywhere on the conversation
    let depth = 0;
    const zone = h('div', { class: 'dropzone hidden' }, 'Drop to attach');
    this.root.style.position = 'relative';
    this.root.append(zone);
    this.root.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; zone.classList.remove('hidden'); } });
    this.root.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.add('hidden'); } });
    this.root.addEventListener('dragover', (e) => e.preventDefault());
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.add('hidden');
      [...(e.dataTransfer.files || [])].forEach((f) => this.upload(f));
    });
  }

  renderEmpty() {
    const ideas = ['What can you do for me?', 'Find the latest notification on industrial electricity tariffs in Punjab',
      'Open the Punjab Board of Investment website and summarise the incentives page', 'Write a speech opening for an investors’ dinner'];
    this.list.replaceChildren(h('div', { class: 'chat-empty' },
      h('span', { class: 'mark' }, icon('logo')),
      h('h2', null, 'How can I help?'),
      h('p', { class: 'muted', style: { margin: 0, maxWidth: '520px' } }, 'I can research, write, read your files and pictures, browse the web in the side panel, and use your phone when you ask.'),
      h('div', { class: 'chips', style: { justifyContent: 'center' } }, ideas.map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { this.ta.value = t; this.fit(); this.ta.focus(); } }, t)))));
    setTimeout(() => this.ta.focus(), 50);
  }

  async load() {
    try {
      this.chat = await api('/api/chats/' + this.id);
    } catch (e) {
      if (e.status === 404) { toast('That conversation is gone.'); location.hash = '#/assistant'; return; }
      fail(e);
      return;
    }
    if (!this.alive) return;
    this.title.textContent = this.chat.title;
    if (this.chat.model && [...this.model.options].some((o) => o.value === this.chat.model)) this.model.value = this.chat.model;
    if (this.chat.effort) this.effort.value = this.chat.effort;
    this.list.replaceChildren();
    for (const m of this.chat.messages) this.list.append(m.role === 'user' ? this.userBubble(m.text, m.meta.attachments || []) : this.answerBubble(m.text, m.meta));
    if (!this.chat.messages.length) this.renderEmpty();
    await this.ensureStream();
    if (this.chat.busy) {
      this.setBusy(true);
      this.startLive(this.chat.partial, this.chat.tools);
    }
    this.scrollDown(true);
  }

  // ---------------------------------------------------------------- bubbles

  userBubble(text, atts) {
    return h('div', { class: 'bubble user' },
      atts && atts.length ? h('div', { class: 'atts' }, atts.map((a) => h('span', { class: 'att' }, icon('clip'), h('span', null, String(a.name || a.path || a).split('/').pop())))) : null,
      h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, text));
  }

  answerBubble(text, meta = {}) {
    const md = h('div', { class: 'md', html: markdown(text) });
    const b = h('div', { class: 'bubble assistant' + (meta.error ? ' error' : '') },
      meta.tools && meta.tools.length ? h('div', { class: 'toolchips' }, meta.tools.map((t) => h('span', { class: 'pill' }, icon('check'), t))) : null,
      md,
      meta.files && meta.files.length ? this.fileCards(meta.files) : null,
      h('div', { class: 'acts' },
        canSpeak ? iconBtn('volume', 'Read aloud', () => speech.speak(text)) : null,
        iconBtn('copy', 'Copy', () => copyText(text)),
        meta.seconds ? h('span', { class: 'meta-line', style: { alignSelf: 'center', marginLeft: '6px' } }, `${Math.round(meta.seconds)} s`) : null));
    return b;
  }

  fileCards(files) {
    return h('div', { class: 'files' }, files.map((f) => h('button', {
      class: 'filecard', type: 'button', onclick: () => bus.emit('panel:preview', f),
    }, icon(FILE_ICONS[f.kind] || 'doc'), h('span', null, f.name.split('/').pop()), h('span', { class: 'muted small' }, f.kind === 'web' ? 'Open preview' : 'Open'))));
  }

  startLive(partial = '', tools = []) {
    if (this.live) return;
    const chips = h('div', { class: 'toolchips' });
    const md = h('div', { class: 'md' });
    const typing = h('div', { class: 'typing' }, h('i'), h('i'), h('i'));
    const el = h('div', { class: 'bubble assistant' }, chips, typing, md);
    this.live = { el, chips, md, typing, text: '', tools: [], raf: 0 };
    (tools || []).forEach((t) => this.addTool(t));
    this.list.append(el);
    if (partial) this.addDelta(partial);
    this.scrollDown(true);
  }

  addTool(label) {
    const L = this.live;
    if (!L || L.tools[L.tools.length - 1] === label) return;
    L.tools.push(label);
    [...L.chips.children].forEach((c) => c.classList.remove('live'));
    L.chips.append(h('span', { class: 'pill live' }, label));
    if (!isSmall()) {
      if (label === 'Using the browser') bus.emit('panel:open', 'browser');
      if (label === 'Using your phone') bus.emit('panel:open', 'phone');
    }
    if (label === 'Using your computer' && !L.warned) {
      L.warned = true;
      toast('The assistant is using your computer. To stop it, push the mouse pointer into the top-left corner.', { ms: 8000 });
    }
    this.scrollDown();
  }

  addDelta(text) {
    const L = this.live;
    if (!L) return;
    L.text += text;
    L.typing.classList.add('hidden');
    if (!L.raf) {
      L.raf = requestAnimationFrame(() => {
        L.raf = 0;
        L.md.innerHTML = markdown(L.text) + '<span class="cursor"></span>';
        this.scrollDown();
      });
    }
  }

  finishLive(d) {
    const meta = d.meta || {};
    const text = d.text || '';
    if (this.live) {
      cancelAnimationFrame(this.live.raf);
      this.live.el.replaceWith(this.answerBubble(text, meta));
      this.live = null;
    } else {
      this.list.append(this.answerBubble(text, meta));
    }
    this.setBusy(false);
    this.scrollDown();
    if (this.voice) {
      const v = this.voice;
      this.voice = null;
      if (meta.error) v.onError(text); else v.onDone(text);
    } else if (!meta.error && (store.overview && store.overview.app && store.overview.app.auto_read) && canSpeak) {
      speech.speak(text);
    }
    if (this.chat && this.chat.title === 'New conversation') this.refreshTitle();
    bus.emit('chats');
  }

  async refreshTitle() {
    try { const c = await api('/api/chats/' + this.id); this.chat.title = c.title; this.title.textContent = c.title; } catch (e) { /* ignore */ }
  }

  scrollDown(force = false) {
    const s = this.scroller;
    if (force || s.scrollHeight - s.scrollTop - s.clientHeight < 160) s.scrollTop = s.scrollHeight;
  }

  setBusy(b) {
    this.busy = b;
    this.sendBtn.replaceChildren(icon(b ? 'stop' : 'send'));
    this.sendBtn.title = b ? 'Stop' : 'Send';
    this.sendBtn.setAttribute('aria-label', this.sendBtn.title);
  }

  // ---------------------------------------------------------------- talking to the server

  async ensureChat() {
    if (this.id) return this.id;
    const c = await api('/api/chats', { method: 'POST', body: { model: this.model.value, effort: this.effort.value } });
    this.id = c.id;
    this.chat = c;
    history.replaceState(null, '', '#/assistant/' + c.id);
    bus.emit('chats');
    return this.id;
  }

  async ensureStream() {
    if (this.es || !this.id) return;
    this.es = stream(`/api/chats/${this.id}/events`, {
      start: () => { if (!this.live) this.startLive(); this.setBusy(true); },
      delta: (d) => {
        if (!this.live) this.startLive();
        this.addDelta(d.text || '');
        this.voice && this.voice.onDelta(d.text || '');
      },
      tool: (d) => { if (!this.live) this.startLive(); this.addTool(d.label); },
      done: (d) => this.finishLive(d),
    });
    let drops = 0;
    this.es.onerror = () => {
      // reconnecting: when back, catch up on anything missed
      if (++drops > 1 && this.busy) setTimeout(() => this.resync(), 1500);
    };
    await opened(this.es);
  }

  async resync() {
    if (!this.alive || !this.id) return;
    try {
      const c = await api('/api/chats/' + this.id);
      if (!c.busy && this.busy) {
        const last = c.messages[c.messages.length - 1];
        if (last && last.role === 'assistant') this.finishLive({ text: last.text, meta: last.meta });
      }
    } catch (e) { /* still offline */ }
  }

  async send() {
    if (this.busy) return;
    if (this.uploads) { toast('One moment — still attaching your file.'); return; }
    const text = this.ta.value.trim();
    if (!text && !this.attachments.length) { this.ta.focus(); return; }
    stopDictation();
    speech.stop();
    try {
      await this.ensureChat();
      await this.ensureStream();
    } catch (e) { fail(e); return; }
    if (this.list.querySelector('.chat-empty')) this.list.replaceChildren();
    if (this.title.textContent === 'New conversation' && text) this.title.textContent = text.length > 60 ? text.slice(0, 59) + '…' : text;
    const atts = this.attachments;
    this.list.append(this.userBubble(text || 'Please look at what I attached.', atts));
    this.ta.value = '';
    this.fit();
    this.attachments = [];
    this.renderAtts();
    this.setBusy(true);
    this.startLive();
    try {
      await api(`/api/chats/${this.id}/send`, {
        method: 'POST', body: { text, model: this.model.value, effort: this.effort.value, attachments: atts.map((a) => a.path) },
      });
    } catch (e) {
      if (this.live) this.finishLive({ text: e.message, meta: { error: true } });
      else fail(e);
    }
  }

  async stop() {
    if (!this.id) return;
    try { await api(`/api/chats/${this.id}/stop`, { method: 'POST', body: {} }); } catch (e) { fail(e); }
  }

  async upload(file) {
    if (file.size > 300 * 1024 * 1024) { toast('That file is too large (300 MB at most).', { bad: true }); return; }
    const chip = { name: file.name, path: '', uploading: true };
    this.attachments.push(chip);
    this.uploads++;
    this.renderAtts();
    try {
      await this.ensureChat();
      await this.ensureStream();
      const info = await api(`/api/chats/${this.id}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file });
      Object.assign(chip, info, { uploading: false });
    } catch (e) {
      fail(e);
      this.attachments = this.attachments.filter((a) => a !== chip);
    }
    this.uploads--;
    this.renderAtts();
  }

  renderAtts() {
    this.atts.replaceChildren(...this.attachments.map((a) => h('span', { class: 'att' + (a.uploading ? ' up' : '') },
      icon(a.uploading ? 'reload' : 'clip'), h('span', null, a.name + (a.size ? ` · ${bytes(a.size)}` : '')),
      h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => { this.attachments = this.attachments.filter((x) => x !== a); this.renderAtts(); } }, icon('x')))));
  }

  // ---------------------------------------------------------------- extras

  talk() {
    conversation({
      send: (text, handlers) => {
        if (this.busy) { handlers.onError('Still answering — one moment.'); return; }
        this.voice = handlers;
        this.ta.value = text;
        this.send();
      },
    });
  }

  async toTeam() {
    if (!this.id || !this.chat || !(this.list.querySelector('.bubble.user'))) {
      toast('Describe what you want first; then the team can build it.');
      return;
    }
    const ok = await confirmBox('Build this with the team?',
      'The team will read this conversation and build what you asked for as a project. You can follow along and chat with them.', { ok: 'Start the project' });
    if (!ok) return;
    try {
      const r = await api(`/api/chats/${this.id}/project`, { method: 'POST', body: { mode: 'auto' } });
      bus.emit('runs');
      location.hash = '#/projects/' + r.id;
    } catch (e) { fail(e); }
  }

  async more() {
    const chats = (await api('/api/chats').catch(() => ({ chats: [] }))).chats;
    let close = () => {};
    await dialog({
      title: 'Conversations',
      onOpen: (_, c) => { close = c; },
      body: h('div', { class: 'stack' },
        h('div', { class: 'row wrap' },
          h('a', { class: 'btn sm', href: '#/assistant/new', onclick: () => close(null) }, icon('plus'), 'New conversation'),
          this.id ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => { close(null); this.remove(); } }, icon('trash'), 'Delete this one') : null),
        h('div', { style: { maxHeight: '50vh', overflowY: 'auto' } }, chats.length ? chats.map((c) => h('a', {
          class: 'conv', href: '#/assistant/' + c.id, onclick: () => close(null),
        }, icon('chat'), h('span', null, c.title), h('small', null, ago(c.updated)))) : h('p', { class: 'muted' }, 'No conversations yet.'))),
    });
  }

  async remove() {
    if (!(await confirmBox('Delete this conversation?', 'It disappears from your list. Files it made stay in Crew’s folder on this computer.', { ok: 'Delete', danger: true }))) return;
    try {
      await api('/api/chats/' + this.id, { method: 'DELETE' });
      bus.emit('chats');
      location.hash = '#/assistant/new';
    } catch (e) { fail(e); }
  }

  destroy() {
    this.alive = false;
    if (this.es) this.es.close();
    stopDictation();
    this.view.style.overflow = '';
  }
}
