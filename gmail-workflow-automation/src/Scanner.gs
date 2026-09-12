/**
 * Scanner.gs — the run loop.
 *
 * Three things this file is careful about, because each is a way a mailbox
 * automation quietly goes wrong:
 *
 *  1. It never pays to re-read an unchanged thread. A fingerprint over the
 *     message count and the last message identity gates every model call.
 *  2. It never overrules a human. If somebody moved a label by hand, that is
 *     the answer until the thread receives a new message.
 *  3. It never runs past its wall clock. Apps Script kills a long execution
 *     mid-write; this loop stops itself first and lets the next trigger resume.
 */

function runScan(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('another run holds the lock; exiting');
    return { skipped: 'locked' };
  }
  var started = Date.now();
  var cfg = getConfig();
  var stats = {
    scanned: 0, classified: 0, unchanged: 0, corrections: 0,
    labelled: 0, errors: 0, clockOnly: 0, stoppedEarly: false
  };

  try {
    ensureLabels_(cfg);
    var corrections = Store.recentCorrections(cfg.correctionExamples);
    var threads = GmailApp.search(cfg.searchQuery, 0, cfg.maxThreadsPerScan);
    var now = Date.now();

    for (var i = 0; i < threads.length; i++) {
      if (Date.now() - started > cfg.runBudgetMs) {
        stats.stoppedEarly = true;
        Store.log('INFO', 'run_budget_reached', '',
          'stopped after ' + stats.scanned + ' of ' + threads.length + ' threads');
        break;
      }
      if (stats.classified >= cfg.maxClassificationsPerScan) {
        stats.stoppedEarly = true;
        Store.log('INFO', 'classification_cap_reached', '',
          'cap ' + cfg.maxClassificationsPerScan + ' reached');
        break;
      }
      try {
        processThread_(threads[i], cfg, corrections, now, stats, opts);
      } catch (e) {
        stats.errors++;
        Store.log('ERROR', 'thread_failed', safeThreadId_(threads[i]),
          String(e && e.stack ? e.stack : e));
      }
      stats.scanned++;
    }

    maybePrune_(cfg);
    Store.log('INFO', 'scan_complete', '', JSON.stringify(stats));
  } finally {
    lock.releaseLock();
  }
  console.log(JSON.stringify(stats));
  return stats;
}

function safeThreadId_(thread) {
  try { return thread.getId(); } catch (e) { return '?'; }
}

function processThread_(thread, cfg, corrections, now, stats, opts) {
  var threadId = thread.getId();
  var prev = Store.get(threadId);
  var fingerprint = fingerprintOf_(thread);
  var currentNames = currentLabelNames_(thread);
  var unchanged = !!prev && prev.fingerprint === fingerprint;

  // ---- 1. Did a human overrule us? ---------------------------------------
  // Only meaningful while the thread itself has not moved: if new mail arrived,
  // the labels may simply be stale rather than deliberate.
  if (unchanged && prev.category) {
    var humanCat = humanCategoryFromLabels_(currentNames, cfg);
    if (humanCat && humanCat !== prev.category) {
      var rec = adoptHumanCategory_(prev, humanCat, now, cfg);
      Store.recordCorrection(threadId, prev.subject, prev.category, humanCat, prev.summary);
      applyLabels_(thread, rec, cfg);
      Store.put(rec);
      stats.corrections++;
      Store.log('INFO', 'human_correction', threadId,
        prev.category + ' -> ' + humanCat);
      return;
    }
  }

  // ---- 2. Nothing happened: run the clock, not the model ------------------
  // A human's verdict outranks a forced rescan too. "We stop overruling that
  // thread until a new message arrives" has to mean it, or it is not a promise.
  if (unchanged && (!opts.force || prev.humanLocked)) {
    if (prev.humanLocked || prev.category) {
      var ticked = refreshOverdue_(prev, now);
      var plan = labelPlan_(currentNames, prev, cfg);
      if (ticked || plan.add.length || plan.remove.length) {
        applyLabels_(thread, prev, cfg);
        prev.lastProcessedAt = new Date(now).toISOString();
        Store.put(prev);
        stats.labelled++;
        stats.clockOnly++;
      }
      stats.unchanged++;
      return;
    }
  }

  // ---- 3. The thread moved: ask the model --------------------------------
  var msgs = threadToMessages_(thread, cfg);
  if (!msgs.length) return;
  var transcript = renderTranscript_(msgs, cfg);
  var last = msgs[msgs.length - 1];

  var ctx = {
    threadId: threadId,
    subject: thread.getFirstMessageSubject(),
    permalink: thread.getPermalink(),
    counterparty: counterpartyOf_(msgs),
    messageCount: msgs.length,
    firstDateIso: msgs[0].date.toISOString(),
    lastDateIso: last.date.toISOString(),
    lastDirection: last.direction,
    nowIso: new Date(now).toISOString(),
    nowMs: now,
    lastInboundMs: lastInboundMs_(msgs),
    fingerprint: fingerprint,
    previousCategory: prev ? prev.category : '',
    previousCommitment: prev ? prev.commitment : ''
  };

  var result = classifyThread_(ctx, transcript, cfg, corrections);
  stats.classified++;

  if (!result.ok) {
    stats.errors++;
    var fallback = failureRecord_(prev, ctx, result.error);
    applyLabels_(thread, fallback, cfg);
    Store.put(fallback);
    Store.log('ERROR', 'classify_failed', threadId, result.error);
    return;
  }

  var rec = decideState_(prev, result.verdict, ctx, cfg);
  var change = applyLabels_(thread, rec, cfg);
  Store.put(rec);
  stats.labelled++;

  Store.log('INFO', 'classified', threadId, [
    rec.category,
    'conf=' + rec.confidence.toFixed(2),
    rec.needsReview ? 'review(' + rec._reason + ')' : '',
    rec.overdue ? 'overdue' : '',
    change.add.length ? '+' + change.add.join(',') : '',
    change.remove.length ? '-' + change.remove.join(',') : '',
    usageLine_(result.usage)
  ].filter(String).join(' '));
}

/** A human's label becomes the record, with the clock recomputed to match. */
function adoptHumanCategory_(prev, humanCat, now, cfg) {
  var rec = {};
  for (var k in prev) if (prev.hasOwnProperty(k)) rec[k] = prev[k];
  rec.category = humanCat;
  rec.humanLocked = true;
  rec.needsReview = false;
  rec.confidence = 1;
  rec.lastError = '';
  if (OUR_MOVE.indexOf(humanCat) > -1) {
    var openedMs = Date.parse(rec.openedAt) || now;
    var sla = humanCat === 'OFFICIAL_FINANCIAL' ? cfg.slaWorkingHoursOfficial : cfg.slaWorkingHours;
    rec.dueAt = new Date(addWorkingHours_(openedMs, sla, cfg)).toISOString();
  } else {
    rec.dueAt = '';
  }
  refreshOverdue_(rec, now);
  rec.lastProcessedAt = new Date(now).toISOString();
  return rec;
}

/**
 * What to do when the model could not answer. Never silently drop a thread:
 * an unclassifiable conversation is exactly the kind a person should see.
 */
function failureRecord_(prev, ctx, error) {
  var base = prev || {
    threadId: ctx.threadId, permalink: ctx.permalink, subject: ctx.subject,
    counterparty: ctx.counterparty, category: 'NEW_ENQUIRY', confidence: 0,
    summary: '', commitment: '', openedAt: new Date(ctx.nowMs).toISOString(),
    dueAt: '', overdue: false, humanLocked: false
  };
  var rec = {};
  for (var k in base) if (base.hasOwnProperty(k)) rec[k] = base[k];
  rec.threadId = ctx.threadId;
  rec.permalink = ctx.permalink || rec.permalink;
  rec.subject = ctx.subject || rec.subject;
  rec.needsReview = true;
  rec.lastError = String(error).slice(0, 500);
  rec.lastProcessedAt = new Date(ctx.nowMs).toISOString();
  // Deliberately do NOT store the new fingerprint: the next run retries.
  return rec;
}

/**
 * The clock sweep. Threads drop out of the Gmail search window after a few
 * weeks, but an obligation does not expire because the search query moved on.
 * This walks the ledger instead of the mailbox.
 */
function runSlaSweep() {
  var cfg = getConfig();
  var now = Date.now();
  var records = Store.allRecords();
  var changed = 0, missing = 0;

  records.forEach(function (rec) {
    if (!rec.dueAt || rec.category === 'COMPLETED') return;
    if (!refreshOverdue_(rec, now)) return;
    try {
      var thread = GmailApp.getThreadById(rec.threadId);
      if (!thread) { missing++; return; }
      applyLabels_(thread, rec, cfg);
      rec.lastProcessedAt = new Date(now).toISOString();
      Store.put(rec);
      changed++;
    } catch (e) {
      missing++;
      Store.log('WARN', 'sla_sweep_thread_missing', rec.threadId, String(e));
    }
  });

  Store.log('INFO', 'sla_sweep', '', 'flipped=' + changed + ' missing=' + missing +
    ' tracked=' + records.length);
  return { flipped: changed, missing: missing, tracked: records.length };
}

function maybePrune_(cfg) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_PRUNE_MS') || 0);
  if (Date.now() - last < 24 * 3600 * 1000) return;
  Store.prune(cfg);
  props.setProperty('LAST_PRUNE_MS', String(Date.now()));
}
