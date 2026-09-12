/**
 * Transcript.gs — turn a Gmail thread into the smallest text that still
 * contains the whole story.
 *
 * Quoted history is the single largest source of waste in email automation: a
 * ten-message thread re-quotes itself ten times over, and a naive integration
 * pays the model to read the same paragraph repeatedly. Stripping quotes,
 * signatures and legal footers typically removes 60-80% of the characters and
 * loses nothing, because the thread is assembled message by message anyway.
 */

var QUOTE_MARKERS = [
  /^\s*On .{6,120}\s+wrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*From:\s.+$/i,
  /^\s*_{10,}\s*$/,
  /^\s*تم الإرسال/i
];

var SIGNATURE_MARKERS = [
  /^--\s*$/,
  /^\s*Sent from my (iPhone|iPad|Android|Samsung|BlackBerry|mobile)/i,
  /^\s*Get Outlook for (iOS|Android)/i,
  /^\s*This (e-?mail|message) (and any attachments )?(is|are) confidential/i,
  /^\s*DISCLAIMER\s*:?\s*$/i,
  /^\s*CONFIDENTIALITY NOTICE/i,
  /^\s*Please consider the environment/i
];

function matchesAny_(line, patterns) {
  for (var i = 0; i < patterns.length; i++) if (patterns[i].test(line)) return true;
  return false;
}

/**
 * Pure: reduce one message body to its new content.
 * Cuts at the first quote or signature marker and drops ">"-prefixed lines.
 */
function stripQuotedAndSignature_(body) {
  var lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (matchesAny_(line, QUOTE_MARKERS)) break;
    if (matchesAny_(line, SIGNATURE_MARKERS)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncate_(s, max, note) {
  s = String(s || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n[... ' + (s.length - max) + ' characters trimmed' +
    (note ? ' ' + note : '') + ' ...]';
}

/**
 * Pure: render an array of normalised messages into the transcript the model
 * reads. Older messages are compressed to one line; the most recent ones —
 * where the actual next step lives — are kept in full.
 *
 * @param msgs [{from, fromName, date, direction:'OUT'|'IN', body}]
 */
function renderTranscript_(msgs, cfg) {
  var n = msgs.length;
  var fullFrom = Math.max(0, n - cfg.transcriptFullMessages);
  var out = [];
  for (var i = 0; i < n; i++) {
    var m = msgs[i];
    var who = (m.direction === 'OUT' ? 'US' : 'THEM') + ' (' + (m.fromName || m.from) + ')';
    var when = m.date instanceof Date ? m.date.toISOString() : String(m.date);
    // The first message always stays in full: it is where the original ask is.
    if (i < fullFrom && i !== 0) {
      var oneLine = m.body.replace(/\s+/g, ' ').slice(0, 180);
      out.push('[' + (i + 1) + '] ' + when + ' ' + who + ' (earlier) — ' + oneLine);
    } else {
      out.push('[' + (i + 1) + '] ' + when + ' ' + who + '\n' +
        truncate_(m.body, cfg.transcriptMaxCharsPerMessage));
    }
  }
  return truncate_(out.join('\n\n'), cfg.transcriptMaxTotalChars, '(middle of thread)');
}

/** Gmail-facing: normalise a GmailThread into the shape renderTranscript_ wants. */
function threadToMessages_(thread, cfg) {
  return thread.getMessages().map(function (m) {
    var from = m.getFrom();
    return {
      from: extractEmail_(from),
      fromName: displayName_(from),
      date: m.getDate(),
      direction: isOurAddress_(from, cfg) ? 'OUT' : 'IN',
      body: stripQuotedAndSignature_(m.getPlainBody())
    };
  });
}

/** The counterparty: the most recent external correspondent on the thread. */
function counterpartyOf_(msgs) {
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].direction === 'IN') return msgs[i].fromName || msgs[i].from;
  }
  return msgs.length ? (msgs[0].fromName || msgs[0].from) : '';
}

/** Timestamp of the last message from outside — when our clock should start. */
function lastInboundMs_(msgs) {
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].direction === 'IN') return msgs[i].date.getTime();
  }
  return 0;
}

/**
 * A thread's identity for change detection. Same fingerprint means nothing has
 * happened since we last looked, so there is nothing to pay a model to re-read.
 */
function fingerprintOf_(thread) {
  var msgs = thread.getMessages();
  var last = msgs[msgs.length - 1];
  return msgs.length + ':' + (last ? last.getId() : '') + ':' +
    (last ? last.getDate().getTime() : 0);
}
