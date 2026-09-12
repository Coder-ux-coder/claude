/**
 * Store.gs — the system's memory.
 *
 * A single Google Spreadsheet holds everything the script needs to remember
 * between runs. A spreadsheet rather than PropertiesService for three reasons:
 * the properties store caps out around 500 KB (a few thousand threads), a sheet
 * is auditable by the people who own the mailbox, and the "config" tab lets a
 * non-developer retune the system without touching code.
 *
 * Tabs:
 *   state       one row per Gmail thread — the commitment ledger
 *   corrections every time a human overruled the model
 *   log         events and errors
 *   config      key/value overrides for Config.gs
 */

var STATE_HEADERS = [
  'threadId',        // 0  Gmail thread id
  'permalink',       // 1  direct link, used by the digest
  'subject',         // 2
  'counterparty',    // 3  who we are dealing with
  'category',        // 4  current workflow state
  'confidence',      // 5  model confidence for that state
  'summary',         // 6  one line, model-written
  'commitment',      // 7  what we said we would do, if anything
  'openedAt',        // 8  ISO — when the CURRENT category began
  'dueAt',           // 9  ISO — when the clock says it is overdue
  'overdue',         // 10 TRUE/FALSE
  'needsReview',     // 11 TRUE/FALSE
  'fingerprint',     // 12 changes only when the thread changes
  'lastProcessedAt', // 13 ISO
  'humanLocked',     // 14 TRUE = a person set this label; do not overrule
  'lastError'        // 15
];

var CORRECTION_HEADERS = ['at', 'threadId', 'subject', 'modelSaid', 'humanSaid', 'excerpt'];
var LOG_HEADERS = ['at', 'level', 'event', 'threadId', 'detail'];
var CONFIG_HEADERS = ['key', 'value', 'notes'];

var Store = (function () {

  var _ss = null;
  var _stateIndex = null;   // threadId -> {row: <1-based sheet row>, rec: {}}

  function ss() {
    if (_ss) return _ss;
    var id = PropertiesService.getScriptProperties().getProperty(PROP_SHEET_ID);
    if (!id) throw new Error('State spreadsheet not created yet. Run setup() once.');
    _ss = SpreadsheetApp.openById(id);
    return _ss;
  }

  function sheet(name, headers) {
    var s = ss().getSheetByName(name);
    if (!s) {
      s = ss().insertSheet(name);
      s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      s.setFrozenRows(1);
    }
    return s;
  }

  /** Create the spreadsheet on first run and seed the config tab. */
  function bootstrap(title) {
    var props = PropertiesService.getScriptProperties();
    var existing = props.getProperty(PROP_SHEET_ID);
    if (existing) {
      try { SpreadsheetApp.openById(existing); return existing; } catch (e) { /* recreate */ }
    }
    var created = SpreadsheetApp.create(title || 'Gmail Workflow Automation — State');
    props.setProperty(PROP_SHEET_ID, created.getId());
    _ss = created;
    // Remove the default empty sheet once real tabs exist.
    sheet('state', STATE_HEADERS);
    sheet('corrections', CORRECTION_HEADERS);
    sheet('log', LOG_HEADERS);
    var cfg = sheet('config', CONFIG_HEADERS);
    if (cfg.getLastRow() < 2) {
      var seed = [
        ['slaWorkingHours', DEFAULT_CONFIG.slaWorkingHours, 'Working hours before OUR action is overdue'],
        ['slaWorkingHoursOfficial', DEFAULT_CONFIG.slaWorkingHoursOfficial, 'Tighter clock for government / bank / tax mail'],
        ['workingDays', DEFAULT_CONFIG.workingDays.join(','), '0=Sun 1=Mon ... 6=Sat'],
        ['workingStartHour', DEFAULT_CONFIG.workingStartHour, 'Office opens (local hour)'],
        ['workingEndHour', DEFAULT_CONFIG.workingEndHour, 'Office closes (local hour)'],
        ['timezone', DEFAULT_CONFIG.timezone, 'IANA timezone'],
        ['digestHour', DEFAULT_CONFIG.digestHour, 'Local hour the daily summary is sent'],
        ['digestRecipients', '', 'Comma-separated. Blank = mailbox owner'],
        ['searchQuery', DEFAULT_CONFIG.searchQuery, 'Which mail the system looks at'],
        ['minConfidence', DEFAULT_CONFIG.minConfidence, 'Below this -> Needs Review'],
        ['minConfidenceToComplete', DEFAULT_CONFIG.minConfidenceToComplete, 'Closing a thread needs more certainty than keeping it open'],
        ['maxClassificationsPerScan', DEFAULT_CONFIG.maxClassificationsPerScan, 'Cost fuse: AI calls per run'],
        ['model', DEFAULT_CONFIG.model, 'Anthropic model id'],
        ['effort', DEFAULT_CONFIG.effort, 'low | medium | high | xhigh | max'],
        ['dryRun', 'FALSE', 'TRUE = decide and log, but change no labels']
      ];
      cfg.getRange(2, 1, seed.length, 3).setValues(seed);
      cfg.setColumnWidth(1, 230); cfg.setColumnWidth(3, 420);
    }
    var def = created.getSheetByName('Sheet1');
    if (def) created.deleteSheet(def);
    return created.getId();
  }

  function readConfigRows() {
    var s = ss().getSheetByName('config');
    if (!s || s.getLastRow() < 2) return [];
    return s.getRange(2, 1, s.getLastRow() - 1, 2).getValues();
  }

  /** Load the whole state tab into memory once per run. */
  function loadState() {
    if (_stateIndex) return _stateIndex;
    var s = sheet('state', STATE_HEADERS);
    _stateIndex = {};
    if (s.getLastRow() < 2) return _stateIndex;
    var values = s.getRange(2, 1, s.getLastRow() - 1, STATE_HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var rec = rowToRecord_(values[i]);
      if (rec.threadId) _stateIndex[rec.threadId] = { row: i + 2, rec: rec };
    }
    return _stateIndex;
  }

  function get(threadId) {
    var idx = loadState();
    return idx[threadId] ? idx[threadId].rec : null;
  }

  /** Insert or update one thread's row. Writes immediately — a run may be cut short. */
  function put(rec) {
    var idx = loadState();
    var s = sheet('state', STATE_HEADERS);
    var row = recordToRow_(rec);
    if (idx[rec.threadId]) {
      var at = idx[rec.threadId].row;
      s.getRange(at, 1, 1, STATE_HEADERS.length).setValues([row]);
      idx[rec.threadId].rec = rec;
    } else {
      s.appendRow(row);
      idx[rec.threadId] = { row: s.getLastRow(), rec: rec };
    }
  }

  function allRecords() {
    var idx = loadState();
    return Object.keys(idx).map(function (k) { return idx[k].rec; });
  }

  function recordCorrection(threadId, subject, modelSaid, humanSaid, excerpt) {
    sheet('corrections', CORRECTION_HEADERS).appendRow(
      [new Date().toISOString(), threadId, subject || '', modelSaid || '', humanSaid || '',
       String(excerpt || '').slice(0, 500)]);
  }

  /** Most recent corrections, newest first — replayed to the model as examples. */
  function recentCorrections(limit) {
    var s = ss().getSheetByName('corrections');
    if (!s || s.getLastRow() < 2) return [];
    var n = Math.min(limit || 10, s.getLastRow() - 1);
    var start = s.getLastRow() - n + 1;
    return s.getRange(start, 1, n, CORRECTION_HEADERS.length).getValues()
      .map(function (r) {
        return { at: r[0], threadId: r[1], subject: r[2], modelSaid: r[3], humanSaid: r[4], excerpt: r[5] };
      })
      .reverse();
  }

  function log(level, event, threadId, detail) {
    try {
      sheet('log', LOG_HEADERS).appendRow(
        [new Date().toISOString(), level, event, threadId || '',
         typeof detail === 'string' ? detail.slice(0, 4000) : JSON.stringify(detail || '').slice(0, 4000)]);
    } catch (e) {
      console.error('log write failed: ' + e);
    }
  }

  /** Drop rows older than the retention windows so the sheet stays fast. */
  function prune(cfg) {
    var cutLog = Date.now() - cfg.logRetentionDays * 86400000;
    pruneByDate_(ss().getSheetByName('log'), 0, cutLog);
    var cutState = Date.now() - cfg.stateRetentionDays * 86400000;
    var s = ss().getSheetByName('state');
    if (!s || s.getLastRow() < 2) return;
    var vals = s.getRange(2, 1, s.getLastRow() - 1, STATE_HEADERS.length).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      var cat = vals[i][4];
      var last = Date.parse(vals[i][13]);
      if (cat === 'COMPLETED' && last && last < cutState) s.deleteRow(i + 2);
    }
    _stateIndex = null;
  }

  function pruneByDate_(s, col, cutMs) {
    if (!s || s.getLastRow() < 2) return;
    var vals = s.getRange(2, col + 1, s.getLastRow() - 1, 1).getValues();
    var firstKeep = 0;
    while (firstKeep < vals.length) {
      var t = Date.parse(vals[firstKeep][0]);
      if (!t || t >= cutMs) break;
      firstKeep++;
    }
    if (firstKeep > 0) s.deleteRows(2, firstKeep);
  }

  function rowToRecord_(r) {
    return {
      threadId: String(r[0] || ''),
      permalink: String(r[1] || ''),
      subject: String(r[2] || ''),
      counterparty: String(r[3] || ''),
      category: String(r[4] || ''),
      confidence: Number(r[5]) || 0,
      summary: String(r[6] || ''),
      commitment: String(r[7] || ''),
      openedAt: String(r[8] || ''),
      dueAt: String(r[9] || ''),
      overdue: r[10] === true || r[10] === 'TRUE',
      needsReview: r[11] === true || r[11] === 'TRUE',
      fingerprint: String(r[12] || ''),
      lastProcessedAt: String(r[13] || ''),
      humanLocked: r[14] === true || r[14] === 'TRUE',
      lastError: String(r[15] || '')
    };
  }

  function recordToRow_(x) {
    return [
      x.threadId || '', x.permalink || '', x.subject || '', x.counterparty || '',
      x.category || '', x.confidence || 0, x.summary || '', x.commitment || '',
      x.openedAt || '', x.dueAt || '',
      x.overdue ? 'TRUE' : 'FALSE', x.needsReview ? 'TRUE' : 'FALSE',
      x.fingerprint || '', x.lastProcessedAt || '',
      x.humanLocked ? 'TRUE' : 'FALSE', x.lastError || ''
    ];
  }

  return {
    bootstrap: bootstrap,
    readConfigRows: readConfigRows,
    get: get,
    put: put,
    allRecords: allRecords,
    recordCorrection: recordCorrection,
    recentCorrections: recentCorrections,
    log: log,
    prune: prune,
    url: function () { return ss().getUrl(); },
    _rowToRecord: rowToRecord_,
    _recordToRow: recordToRow_
  };
})();
