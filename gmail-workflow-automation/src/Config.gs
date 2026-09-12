/**
 * Config.gs — every tunable in one place.
 *
 * Two layers:
 *   1. DEFAULT_CONFIG below — the shipped defaults, edited by a developer.
 *   2. The "config" tab of the state spreadsheet — edited by the office, no code.
 *
 * The sheet wins. A non-developer can change the SLA, the working day, the
 * digest hour or the model without opening the script editor.
 */

var DEFAULT_CONFIG = {

  // ---- What to look at -------------------------------------------------
  // Gmail search that selects candidate threads. Everything else is derived.
  searchQuery: 'newer_than:21d -in:chats -in:spam -in:trash',
  // Hard ceiling on threads pulled per scan (Gmail caps a single search at 500).
  maxThreadsPerScan: 120,
  // Hard ceiling on AI calls per scan. Unchanged threads never reach the model,
  // so this is a cost fuse, not a throughput limit.
  maxClassificationsPerScan: 40,
  // Stop the run this many milliseconds in, so Apps Script never kills us
  // mid-write. Consumer limit is 6 min; Workspace is 30 min.
  runBudgetMs: 4.5 * 60 * 1000,

  // ---- Who we are ------------------------------------------------------
  // Domains treated as "our company". Used to decide who spoke last.
  // Empty means: infer from the mailbox owner's own domain.
  ourDomains: [],
  // Additional addresses that count as us (shared aliases, group addresses).
  ourAliases: [],

  // ---- Labels ----------------------------------------------------------
  // Numeric prefixes force Gmail's alphabetical sidebar into workflow order.
  labelPrefix: 'Workflow',
  labels: {
    NEW_ENQUIRY:        'Workflow/1 New Enquiry',
    COMPANY_NEXT_STEP:  'Workflow/2 We Must Act',
    CUSTOMER_NEXT_STEP: 'Workflow/3 Waiting On Customer',
    OFFICIAL_FINANCIAL: 'Workflow/4 Official & Financial',
    COMPLETED:          'Workflow/5 Done',
    // Overlays — these coexist with a state label above.
    OVERDUE:            'Workflow/! Overdue',
    NEEDS_REVIEW:       'Workflow/? Needs Review'
  },

  // ---- The clock -------------------------------------------------------
  // Overdue is decided by code, not by the model. See Workflow.gs.
  timezone: 'Asia/Karachi',
  workingDays: [1, 2, 3, 4, 5],      // 0 = Sunday .. 6 = Saturday
  workingStartHour: 9,                // 09:00 local
  workingEndHour: 17,                 // 17:00 local
  // Our own obligations go overdue after this many *working* hours.
  slaWorkingHours: 16,
  // Official & financial mail runs on a tighter clock.
  slaWorkingHoursOfficial: 8,

  // ---- Confidence gates ------------------------------------------------
  // Below this, the thread gets "Needs Review" instead of the model's answer.
  minConfidence: 0.65,
  // Closing a thread needs more confidence than keeping it open. This is the
  // RFP's "if the AI is uncertain, leave it visible" rule, enforced in code.
  minConfidenceToComplete: 0.85,

  // ---- Visibility ------------------------------------------------------
  // Pull an overdue thread back into the inbox if it was archived. This is
  // what makes "read" stop meaning "handled" on every device at once.
  resurfaceOverdueToInbox: true,
  // Star threads we owe an action on.
  starCompanyNextStep: false,
  // Mark overdue threads Important.
  markOverdueImportant: true,

  // ---- Daily digest ----------------------------------------------------
  digestEnabled: true,
  digestHour: 8,                      // local hour, 0-23
  digestRecipients: [],               // empty = the mailbox owner
  digestIncludeWaiting: true,
  digestMaxRowsPerSection: 25,

  // ---- The model -------------------------------------------------------
  model: 'claude-opus-5',
  // low | medium | high | xhigh | max. Judging a conversation's next step is
  // reasoning, not keyword matching — but it is not research either.
  effort: 'medium',
  maxTokens: 2000,
  apiTimeoutMs: 90 * 1000,
  apiMaxRetries: 3,
  // Messages kept verbatim at the end of a long thread. Earlier ones are
  // compressed to one line each.
  transcriptFullMessages: 6,
  transcriptMaxCharsPerMessage: 2500,
  transcriptMaxTotalChars: 24000,
  // Recent human corrections replayed to the model as examples.
  correctionExamples: 12,

  // ---- Housekeeping ----------------------------------------------------
  logRetentionDays: 60,
  stateRetentionDays: 180,
  dryRun: false
};

/** Keys the sheet may override, with the coercion each one needs. */
var CONFIG_COERCIONS = {
  searchQuery: 'string',
  maxThreadsPerScan: 'int',
  maxClassificationsPerScan: 'int',
  runBudgetMs: 'int',
  ourDomains: 'list',
  ourAliases: 'list',
  timezone: 'string',
  workingDays: 'intlist',
  workingStartHour: 'int',
  workingEndHour: 'int',
  slaWorkingHours: 'number',
  slaWorkingHoursOfficial: 'number',
  minConfidence: 'number',
  minConfidenceToComplete: 'number',
  resurfaceOverdueToInbox: 'bool',
  starCompanyNextStep: 'bool',
  markOverdueImportant: 'bool',
  digestEnabled: 'bool',
  digestHour: 'int',
  digestRecipients: 'list',
  digestIncludeWaiting: 'bool',
  digestMaxRowsPerSection: 'int',
  model: 'string',
  effort: 'string',
  maxTokens: 'int',
  apiTimeoutMs: 'int',
  apiMaxRetries: 'int',
  transcriptFullMessages: 'int',
  transcriptMaxCharsPerMessage: 'int',
  transcriptMaxTotalChars: 'int',
  correctionExamples: 'int',
  logRetentionDays: 'int',
  stateRetentionDays: 'int',
  dryRun: 'bool'
};

/** Pure: apply one sheet override onto a config object. Exported for tests. */
function coerceConfigValue_(key, raw) {
  var kind = CONFIG_COERCIONS[key];
  if (!kind) return undefined;
  var s = String(raw == null ? '' : raw).trim();
  switch (kind) {
    case 'string':
      return s;
    case 'int': {
      var i = parseInt(s, 10);
      return isNaN(i) ? undefined : i;
    }
    case 'number': {
      var n = parseFloat(s);
      return isNaN(n) ? undefined : n;
    }
    case 'bool':
      if (/^(true|yes|y|1|on)$/i.test(s)) return true;
      if (/^(false|no|n|0|off)$/i.test(s)) return false;
      return undefined;
    case 'list':
      return s ? s.split(',').map(function (x) { return x.trim(); })
                  .filter(function (x) { return x.length > 0; }) : [];
    case 'intlist':
      return s ? s.split(',').map(function (x) { return parseInt(x.trim(), 10); })
                  .filter(function (x) { return !isNaN(x); }) : [];
  }
  return undefined;
}

/** Pure: merge sheet rows ([key, value] pairs) over a base config. */
function mergeConfig_(base, rows) {
  var out = {};
  for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
  (rows || []).forEach(function (row) {
    var key = String(row[0] || '').trim();
    if (!key || !CONFIG_COERCIONS.hasOwnProperty(key)) return;
    var v = coerceConfigValue_(key, row[1]);
    if (v !== undefined) out[key] = v;
  });
  return out;
}

var __configCache = null;

/** The live config: defaults, overridden by the sheet's config tab. */
function getConfig() {
  if (__configCache) return __configCache;
  var rows = [];
  try {
    rows = Store.readConfigRows();
  } catch (e) {
    // The sheet may not exist yet (first run, or setup in progress).
  }
  __configCache = mergeConfig_(DEFAULT_CONFIG, rows);
  if (!__configCache.ourDomains.length) {
    var me = ownEmail_();
    if (me && me.indexOf('@') > -1) __configCache.ourDomains = [me.split('@')[1].toLowerCase()];
  }
  return __configCache;
}

function resetConfigCache_() { __configCache = null; }

function ownEmail_() {
  try {
    return (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/** Where the API key lives. Never in code, never in the sheet. */
var PROP_API_KEY = 'ANTHROPIC_API_KEY';
var PROP_SHEET_ID = 'STATE_SPREADSHEET_ID';

function getApiKey_() {
  var k = PropertiesService.getScriptProperties().getProperty(PROP_API_KEY);
  if (!k) {
    throw new Error(
      'No API key. Open Project Settings > Script Properties and add ' +
      PROP_API_KEY + '. See INSTALL.md step 4.');
  }
  return k;
}
