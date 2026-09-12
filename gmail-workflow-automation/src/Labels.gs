/**
 * Labels.gs — the only surface the user actually sees.
 *
 * Gmail labels live on the server, not on the client. That single fact is what
 * makes this system work on every device the mailbox is signed in on — web,
 * Android, iOS, Outlook over IMAP, a corporate laptop — with no install
 * anywhere. Nothing below runs on a phone; the phone simply displays what the
 * server already decided.
 */

var _labelCache = {};

function getOrCreateLabel_(name) {
  if (_labelCache[name]) return _labelCache[name];
  var label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  _labelCache[name] = label;
  return label;
}

/** Create every managed label up front so the sidebar is complete from day one. */
function ensureLabels_(cfg) {
  var created = [];
  managedLabels_(cfg).forEach(function (name) {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
      created.push(name);
    }
  });
  _labelCache = {};
  return created;
}

function currentLabelNames_(thread) {
  return thread.getLabels().map(function (l) { return l.getName(); });
}

/**
 * Apply a record's labels to a thread and return what changed.
 * Also handles the visibility rules: an overdue thread is pulled back into the
 * inbox so that having read it once does not make it disappear.
 */
function applyLabels_(thread, rec, cfg) {
  var current = currentLabelNames_(thread);
  var plan = labelPlan_(current, rec, cfg);

  if (cfg.dryRun) return { add: plan.add, remove: plan.remove, dryRun: true };

  plan.remove.forEach(function (name) {
    var l = GmailApp.getUserLabelByName(name);
    if (l) thread.removeLabel(l);
  });
  plan.add.forEach(function (name) { thread.addLabel(getOrCreateLabel_(name)); });

  if (rec.overdue) {
    if (cfg.resurfaceOverdueToInbox && !thread.isInInbox()) thread.moveToInbox();
    if (cfg.markOverdueImportant && !thread.isImportant()) thread.markImportant();
  }
  if (cfg.starCompanyNextStep && rec.category === 'COMPANY_NEXT_STEP') {
    var msgs = thread.getMessages();
    if (msgs.length && !msgs[msgs.length - 1].isStarred()) msgs[msgs.length - 1].star();
  }

  return { add: plan.add, remove: plan.remove, dryRun: false };
}
