/**
 * Main.gs — the functions a human runs by name, and the triggers that run them
 * afterwards without anybody's involvement.
 *
 * Start here: run setup() once, then never open the editor again.
 */

var PROP_LAST_DIGEST = 'LAST_DIGEST_DATE';

/**
 * One-time installation. Safe to run twice — it repairs rather than duplicates.
 */
function setup() {
  var sheetId = Store.bootstrap();
  resetConfigCache_();
  var cfg = getConfig();
  var created = ensureLabels_(cfg);
  installTriggers();

  var lines = [
    'Setup complete.',
    '',
    'State spreadsheet : ' + Store.url(),
    'Labels created    : ' + (created.length ? created.join(', ') : 'none (already present)'),
    'Mailbox           : ' + ownEmail_(),
    'Timezone          : ' + cfg.timezone,
    'Office hours      : ' + cfg.workingStartHour + ':00-' + cfg.workingEndHour + ':00 on days ' +
      cfg.workingDays.join(','),
    'Response deadline : ' + cfg.slaWorkingHours + ' working hours (' +
      cfg.slaWorkingHoursOfficial + ' for official & financial)',
    'Model             : ' + cfg.model + ' at ' + cfg.effort + ' effort',
    'Digest            : ' + (cfg.digestEnabled ? 'daily at ' + cfg.digestHour + ':00' : 'off'),
    '',
    PropertiesService.getScriptProperties().getProperty(PROP_API_KEY)
      ? 'API key           : present'
      : 'API key           : MISSING — add ' + PROP_API_KEY +
        ' under Project Settings > Script Properties before the first scan.',
    '',
    'Next: run previewScan() to see what it would do without changing anything.'
  ];
  console.log(lines.join('\n'));
  Store.log('INFO', 'setup', '', 'sheet=' + sheetId);
  return lines.join('\n');
}

/** Time-driven triggers. Removes its own duplicates first. */
function installTriggers() {
  removeAllTriggers();
  ScriptApp.newTrigger('runScan').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('hourlyTick').timeBased().everyHours(1).create();
  console.log('triggers installed: runScan/15min, hourlyTick/1h');
}

function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/**
 * Hourly: keep the clock honest on threads the search window has dropped, and
 * send the digest when the local hour comes round.
 */
function hourlyTick() {
  var cfg = getConfig();
  runSlaSweep();

  if (!cfg.digestEnabled) return;
  var nowLocal = localParts_(new Date(), cfg.timezone);
  if (nowLocal.hour !== cfg.digestHour) return;

  var today = [nowLocal.year, pad2_(nowLocal.month), pad2_(nowLocal.day)].join('-');
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_LAST_DIGEST) === today) return;

  sendDigest();
  props.setProperty(PROP_LAST_DIGEST, today);
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// ---------------------------------------------------------------------------
// Manual controls
// ---------------------------------------------------------------------------

/** Decide everything, change nothing. The safe first run. */
function previewScan() {
  resetConfigCache_();
  var cfg = getConfig();
  var saved = cfg.dryRun;
  cfg.dryRun = true;
  try {
    var stats = runScan();
    console.log('DRY RUN — no labels were changed.\n' + JSON.stringify(stats, null, 2));
    return stats;
  } finally {
    cfg.dryRun = saved;
  }
}

/** Re-read every thread in the window, ignoring fingerprints. Costs real money. */
function rescanEverything() {
  resetConfigCache_();
  return runScan({ force: true });
}

/** Send the digest now, whatever the hour. */
function sendDigestNow() {
  resetConfigCache_();
  return sendDigest();
}

/** Force one thread through the model. Accepts a thread id or a Gmail URL. */
function reclassifyThread(threadIdOrUrl) {
  var cfg = getConfig();
  var id = String(threadIdOrUrl || '').trim();
  var m = id.match(/[#/]([0-9a-fA-F]{8,})$/);
  if (m) id = m[1];
  var thread = GmailApp.getThreadById(id);
  if (!thread) throw new Error('No thread with id ' + id);

  var stats = { scanned: 0, classified: 0, unchanged: 0, corrections: 0,
                labelled: 0, errors: 0, clockOnly: 0 };
  processThread_(thread, cfg, Store.recentCorrections(cfg.correctionExamples),
    Date.now(), stats, { force: true });
  console.log(JSON.stringify(stats));
  return Store.get(id);
}

/** A one-screen health check. Run this when something looks wrong. */
function status() {
  var cfg = getConfig();
  var recs = Store.allRecords();
  var now = Date.now();
  var by = {};
  var overdue = 0, review = 0, errors = 0;
  recs.forEach(function (r) {
    by[r.category] = (by[r.category] || 0) + 1;
    if (r.overdue) overdue++;
    if (r.needsReview) review++;
    if (r.lastError) errors++;
  });

  var triggers = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  });

  var report = [
    'Mailbox            : ' + ownEmail_(),
    'Tracked threads    : ' + recs.length,
    'By state           : ' + JSON.stringify(by),
    'Overdue now        : ' + overdue,
    'Awaiting review    : ' + review,
    'Threads with error : ' + errors,
    'Triggers           : ' + (triggers.length ? triggers.join(', ') : 'NONE INSTALLED'),
    'API key            : ' + (PropertiesService.getScriptProperties()
      .getProperty(PROP_API_KEY) ? 'present' : 'MISSING'),
    'Dry run            : ' + cfg.dryRun,
    'Spreadsheet        : ' + Store.url(),
    'Local time         : ' + Utilities.formatDate(new Date(now), cfg.timezone,
      'yyyy-MM-dd HH:mm') + ' ' + cfg.timezone
  ].join('\n');
  console.log(report);
  return report;
}

/** Remove every label this system created. Leaves the ledger intact. */
function uninstallLabels() {
  var cfg = getConfig();
  managedLabels_(cfg).forEach(function (name) {
    var l = GmailApp.getUserLabelByName(name);
    if (l) l.deleteLabel();
  });
  console.log('workflow labels removed');
}
