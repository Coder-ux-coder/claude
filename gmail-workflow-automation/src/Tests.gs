/**
 * Tests.gs — run `selfTest` from the Apps Script editor after installing.
 *
 * The Node suite in test/run.js covers the logic far more thoroughly, but it
 * runs on Node's Intl implementation. Apps Script computes local time through
 * Utilities.formatDate instead, so the two must be shown to agree — a one-hour
 * disagreement between them would silently move every deadline. That is what
 * this file is really for.
 */

function selfTest() {
  var results = [];
  function ok(name, cond, detail) {
    results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (detail && !cond ? '  [' + detail + ']' : ''));
  }

  var cfg = getConfig();
  var H = 3600000;
  // Monday 7 September 2026, 09:00 in the configured timezone.
  var mon9 = zonedToUtcMs_(2026, 9, 7, 9, 0, cfg.timezone);
  var mon17 = zonedToUtcMs_(2026, 9, 7, 17, 0, cfg.timezone);

  // --- the timezone round trip, the thing Node cannot check ---------------
  var parts = localParts_(new Date(mon9), cfg.timezone);
  ok('local time round-trips through the configured timezone',
    parts.hour === 9 && parts.day === 7 && parts.month === 9,
    JSON.stringify(parts));
  ok('weekday numbering is Sunday-zero', parts.dow === 1, 'dow=' + parts.dow);

  // --- the clock ----------------------------------------------------------
  var fullDay = workingMsBetween_(mon9, mon17, cfg) / H;
  var expectDay = Math.max(0, cfg.workingEndHour - cfg.workingStartHour);
  ok('a full office day measures ' + expectDay + ' hours',
    Math.abs(fullDay - expectDay) < 0.001, 'got ' + fullDay);

  var overnight = workingMsBetween_(mon17, mon17 + 12 * H, cfg) / H;
  ok('the evening does not age a thread', overnight < expectDay, 'got ' + overnight);

  var due = addWorkingHours_(mon9, 2, cfg);
  ok('a two-hour deadline lands inside office hours',
    localParts_(new Date(due), cfg.timezone).hour === cfg.workingStartHour + 2);

  // --- the state machine --------------------------------------------------
  var ctx = { threadId: 'selftest', permalink: '', subject: 'self test',
              fingerprint: 'fp', nowMs: mon9 + H, lastInboundMs: mon9 };
  var v = { category: 'COMPANY_NEXT_STEP', confidence: 0.95, summary: 's',
            commitment: 'do the thing', commitment_owner: 'US' };

  var rec = decideState_(null, v, ctx, cfg);
  ok('our own move gets a deadline', !!rec.dueAt);
  ok('the clock starts at their message', rec.openedAt === new Date(mon9).toISOString());

  var unsure = decideState_(rec,
    { category: 'COMPLETED', confidence: cfg.minConfidenceToComplete - 0.1,
      summary: '', commitment: '', commitment_owner: 'NONE' }, ctx, cfg);
  ok('an uncertain model cannot close a thread', unsure.category !== 'COMPLETED');
  ok('it asks for review instead', unsure.needsReview === true);

  // --- labels -------------------------------------------------------------
  var plan = labelPlan_([], rec, cfg);
  ok('a new thread gains exactly one label', plan.add.length === 1 && plan.remove.length === 0,
    JSON.stringify(plan));
  var keepMine = labelPlan_(['Clients/Acme', cfg.labels.CUSTOMER_NEXT_STEP], rec, cfg);
  ok('labels we do not own are left alone',
    keepMine.remove.indexOf('Clients/Acme') === -1, JSON.stringify(keepMine));

  // --- text handling ------------------------------------------------------
  ok('quoted history is stripped',
    stripQuotedAndSignature_('New text.\nOn Mon, 7 Sep 2026 at 09:30, A B <a@b.com> wrote:\n> old')
      === 'New text.');

  // --- environment --------------------------------------------------------
  ok('an API key is configured',
    !!PropertiesService.getScriptProperties().getProperty(PROP_API_KEY));
  ok('the state spreadsheet is reachable', !!Store.url());
  ok('triggers are installed', ScriptApp.getProjectTriggers().length > 0);
  ok('every workflow label exists',
    managedLabels_(cfg).every(function (n) { return !!GmailApp.getUserLabelByName(n); }));

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var out = results.join('\n') + '\n\n' +
    (results.length - failed) + ' passed, ' + failed + ' failed';
  console.log(out);
  return out;
}

/**
 * Send one real request to the API and print what came back. Run this once
 * after installing to prove the key, the network and the model all work.
 * Costs a fraction of a cent.
 */
function testApiConnection() {
  var cfg = getConfig();
  var ctx = {
    subject: 'Quotation for 40 units', counterparty: 'Test Buyer', messageCount: 2,
    firstDateIso: new Date().toISOString(), lastDateIso: new Date().toISOString(),
    lastDirection: 'OUT', nowIso: new Date().toISOString(), previousCategory: ''
  };
  var transcript = [
    '[1] 2026-09-07T04:00:00Z THEM (Test Buyer)',
    'Please send a quotation for 40 units.',
    '',
    '[2] 2026-09-07T05:00:00Z US (Sales)',
    'Thank you. We will prepare the quotation.'
  ].join('\n');

  var res = classifyThread_(ctx, transcript, cfg, []);
  if (!res.ok) {
    console.log('FAILED: ' + res.error);
    return res;
  }
  var correct = res.verdict.category === 'COMPANY_NEXT_STEP';
  console.log([
    'Connection OK.',
    '  model      : ' + cfg.model + ' at ' + cfg.effort + ' effort',
    '  category   : ' + res.verdict.category + (correct ? '  (correct)' : '  (EXPECTED COMPANY_NEXT_STEP)'),
    '  confidence : ' + res.verdict.confidence,
    '  summary    : ' + res.verdict.summary,
    '  outstanding: ' + (res.verdict.commitment || '(none)') +
      ' [' + res.verdict.commitment_owner + ']',
    '  usage      : ' + usageLine_(res.usage),
    '',
    correct
      ? 'The model correctly kept the matter with us: a promise is not a delivery.'
      : 'Unexpected classification — check the model id and effort setting.'
  ].join('\n'));
  return res;
}
