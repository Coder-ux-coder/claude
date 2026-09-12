/**
 * Workflow.gs — the decision core. Pure functions only; no Gmail, no network.
 *
 * Division of labour, and it is the central design choice of this system:
 *
 *   The model judges intent.  Code judges time.
 *
 * Asking a language model "has this been open too long?" is asking it to do
 * arithmetic it cannot verify and that a clock does perfectly. Asking a clock
 * "whose move is it?" is worse. So the model returns a state, and code decides
 * when that state has gone stale. Every overdue alert in this system is
 * reproducible from a timestamp — no model call is involved, and none can
 * change it.
 */

var CATEGORIES = [
  'NEW_ENQUIRY',
  'COMPANY_NEXT_STEP',
  'CUSTOMER_NEXT_STEP',
  'OFFICIAL_FINANCIAL',
  'COMPLETED'
];

/** States where the ball is in our court, so the clock runs. */
var OUR_MOVE = ['NEW_ENQUIRY', 'COMPANY_NEXT_STEP', 'OFFICIAL_FINANCIAL'];

// ---------------------------------------------------------------------------
// Timezone-aware local time, working in both Apps Script and plain Node.
// ---------------------------------------------------------------------------

function localParts_(date, tz) {
  if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
    var s = Utilities.formatDate(date, tz, 'yyyy-MM-dd-HH-mm-u');
    var p = s.split('-');
    return {
      year: +p[0], month: +p[1], day: +p[2], hour: +p[3], minute: +p[4],
      dow: (+p[5]) % 7                       // Java: 1=Mon..7=Sun -> 0=Sun..6=Sat
    };
  }
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  });
  var out = {};
  fmt.formatToParts(date).forEach(function (part) { out[part.type] = part.value; });
  var dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, dow: dows[out.weekday]
  };
}

/** Local wall-clock (y, m, d, h, min) in tz -> UTC milliseconds. */
function zonedToUtcMs_(y, mo, d, h, mi, tz) {
  var guess = Date.UTC(y, mo - 1, d, h, mi);
  for (var i = 0; i < 2; i++) {
    var p = localParts_(new Date(guess), tz);
    var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess -= (asUtc - Date.UTC(y, mo - 1, d, h, mi));
  }
  return guess;
}

/** The [open, close) window of one local calendar day, or null if a holiday. */
function workingWindowOn_(y, mo, d, cfg) {
  var probe = new Date(zonedToUtcMs_(y, mo, d, 12, 0, cfg.timezone));
  var dow = localParts_(probe, cfg.timezone).dow;
  if (cfg.workingDays.indexOf(dow) === -1) return null;
  var start = zonedToUtcMs_(y, mo, d, cfg.workingStartHour, 0, cfg.timezone);
  var end = zonedToUtcMs_(y, mo, d, cfg.workingEndHour, 0, cfg.timezone);
  return end > start ? { start: start, end: end } : null;
}

function nextLocalDay_(y, mo, d) {
  var t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + 1);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Working milliseconds elapsed between two instants. Evenings, weekends and
 * anything outside the office day do not count — an enquiry that lands at
 * 18:40 on Friday is not late at 09:00 on Monday.
 */
function workingMsBetween_(fromMs, toMs, cfg) {
  if (!(toMs > fromMs)) return 0;
  var p = localParts_(new Date(fromMs), cfg.timezone);
  var cur = { y: p.year, mo: p.month, d: p.day };
  var total = 0;
  for (var guard = 0; guard < 800; guard++) {
    var w = workingWindowOn_(cur.y, cur.mo, cur.d, cfg);
    if (w) {
      var lo = Math.max(fromMs, w.start);
      var hi = Math.min(toMs, w.end);
      if (hi > lo) total += hi - lo;
    }
    if (w && w.end >= toMs) break;
    var nxt = nextLocalDay_(cur.y, cur.mo, cur.d);
    if (zonedToUtcMs_(nxt.y, nxt.mo, nxt.d, 0, 0, cfg.timezone) > toMs) break;
    cur = { y: nxt.y, mo: nxt.mo, d: nxt.d };
  }
  return total;
}

/** The instant that is `hours` of office time after `fromMs`. */
function addWorkingHours_(fromMs, hours, cfg) {
  var remaining = hours * 3600000;
  if (remaining <= 0) return fromMs;
  var p = localParts_(new Date(fromMs), cfg.timezone);
  var cur = { y: p.year, mo: p.month, d: p.day };
  for (var guard = 0; guard < 800; guard++) {
    var w = workingWindowOn_(cur.y, cur.mo, cur.d, cfg);
    if (w) {
      var lo = Math.max(fromMs, w.start);
      if (w.end > lo) {
        var avail = w.end - lo;
        if (avail >= remaining) return lo + remaining;
        remaining -= avail;
      }
    }
    var nxt = nextLocalDay_(cur.y, cur.mo, cur.d);
    cur = { y: nxt.y, mo: nxt.mo, d: nxt.d };
  }
  return fromMs + hours * 3600000;   // degenerate config: no working days
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

function extractEmail_(header) {
  var m = String(header || '').match(/<([^>]+)>/);
  var addr = m ? m[1] : String(header || '');
  return addr.trim().toLowerCase();
}

function displayName_(header) {
  var s = String(header || '').trim();
  var m = s.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  var name = m ? m[1].trim() : '';
  return name || extractEmail_(s);
}

function isOurAddress_(header, cfg) {
  var addr = extractEmail_(header);
  if (!addr) return false;
  if ((cfg.ourAliases || []).some(function (a) { return a.toLowerCase() === addr; })) return true;
  var domain = addr.indexOf('@') > -1 ? addr.split('@')[1] : '';
  return (cfg.ourDomains || []).some(function (d) { return d.toLowerCase() === domain; });
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Fold a model verdict into the stored record and return the new state.
 *
 * @param prev    previous record from Store, or null
 * @param verdict {category, confidence, summary, commitment, counterparty}
 * @param ctx     {nowMs, lastInboundMs, permalink, subject, fingerprint}
 * @param cfg     live config
 */
function decideState_(prev, verdict, ctx, cfg) {
  var now = ctx.nowMs;
  var category = verdict.category;
  var confidence = typeof verdict.confidence === 'number' ? verdict.confidence : 0;
  var needsReview = false;
  var reason = '';

  if (CATEGORIES.indexOf(category) === -1) {
    category = prev && prev.category ? prev.category : 'NEW_ENQUIRY';
    needsReview = true;
    reason = 'unrecognised category from model';
  }

  // The RFP's rule, enforced in code rather than trusted to the prompt:
  // an uncertain model may never close a matter. It may only ask to be checked.
  if (category === 'COMPLETED' && confidence < cfg.minConfidenceToComplete) {
    category = (prev && prev.category && prev.category !== 'COMPLETED')
      ? prev.category : 'COMPANY_NEXT_STEP';
    needsReview = true;
    reason = 'not confident enough to close';
  } else if (confidence < cfg.minConfidence) {
    needsReview = true;
    reason = reason || 'low confidence';
  }

  var changed = !prev || prev.category !== category;

  // The commitment clock starts when we BECAME responsible — normally the
  // moment their message landed, not the moment the scanner happened to run.
  // It does not restart on later messages: a customer who chases us three
  // times must not reset our own deadline.
  var openedAtMs;
  if (changed) {
    openedAtMs = (OUR_MOVE.indexOf(category) > -1 && ctx.lastInboundMs) ? ctx.lastInboundMs : now;
  } else {
    openedAtMs = Date.parse(prev.openedAt) || now;
  }

  var dueAtMs = null;
  if (OUR_MOVE.indexOf(category) > -1) {
    var sla = category === 'OFFICIAL_FINANCIAL'
      ? cfg.slaWorkingHoursOfficial : cfg.slaWorkingHours;
    dueAtMs = addWorkingHours_(openedAtMs, sla, cfg);
  }

  var overdue = dueAtMs !== null && now > dueAtMs;

  return {
    threadId: ctx.threadId,
    permalink: ctx.permalink || (prev && prev.permalink) || '',
    subject: ctx.subject || (prev && prev.subject) || '',
    counterparty: verdict.counterparty || (prev && prev.counterparty) || '',
    category: category,
    confidence: confidence,
    summary: verdict.summary || '',
    commitment: verdict.commitment || '',
    openedAt: new Date(openedAtMs).toISOString(),
    dueAt: dueAtMs ? new Date(dueAtMs).toISOString() : '',
    overdue: overdue,
    needsReview: needsReview,
    fingerprint: ctx.fingerprint || '',
    lastProcessedAt: new Date(now).toISOString(),
    humanLocked: false,
    lastError: '',
    _reason: reason,
    _categoryChanged: changed
  };
}

/**
 * Re-run the clock on a stored record without calling the model. This is how a
 * thread nobody has touched still turns red at the right hour.
 */
function refreshOverdue_(rec, nowMs) {
  var due = rec.dueAt ? Date.parse(rec.dueAt) : 0;
  var overdue = !!due && nowMs > due;
  var changed = overdue !== rec.overdue;
  rec.overdue = overdue;
  return changed;
}

/** Working hours a record has been outstanding — the digest's "age" column. */
function ageWorkingHours_(rec, nowMs, cfg) {
  var opened = Date.parse(rec.openedAt);
  if (!opened) return 0;
  return workingMsBetween_(opened, nowMs, cfg) / 3600000;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Every label this system owns. Anything else on a thread is left alone. */
function managedLabels_(cfg) {
  return CATEGORIES.map(function (c) { return cfg.labels[c]; })
    .concat([cfg.labels.OVERDUE, cfg.labels.NEEDS_REVIEW]);
}

/** The labels a record should carry: exactly one state, plus any overlays. */
function desiredLabels_(rec, cfg) {
  var want = [];
  if (cfg.labels[rec.category]) want.push(cfg.labels[rec.category]);
  if (rec.overdue) want.push(cfg.labels.OVERDUE);
  if (rec.needsReview) want.push(cfg.labels.NEEDS_REVIEW);
  return want;
}

/** Minimal add/remove set — we never touch a label we do not own. */
function labelPlan_(currentNames, rec, cfg) {
  var managed = managedLabels_(cfg);
  var want = desiredLabels_(rec, cfg);
  var have = (currentNames || []).filter(function (n) { return managed.indexOf(n) > -1; });
  return {
    add: want.filter(function (n) { return have.indexOf(n) === -1; }),
    remove: have.filter(function (n) { return want.indexOf(n) === -1; })
  };
}

/**
 * Read the workflow state a human has expressed by hand-labelling a thread.
 * Returns a category name, or null if the labels are absent or contradictory.
 */
function humanCategoryFromLabels_(currentNames, cfg) {
  var found = [];
  CATEGORIES.forEach(function (c) {
    if ((currentNames || []).indexOf(cfg.labels[c]) > -1) found.push(c);
  });
  return found.length === 1 ? found[0] : null;
}
