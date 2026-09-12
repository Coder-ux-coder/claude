/**
 * run.js — the logic tests. `node test/run.js`
 *
 * These cover the parts where being wrong is expensive and silent: the clock,
 * the state machine's refusal to close an uncertain thread, label diffing, and
 * the exact shape of the API request.
 */
const { loadSandbox, group, check, eq, near, report } = require('./harness.js');
const S = loadSandbox();

// Karachi is UTC+5 with no daylight saving — a deterministic office.
const PKT = 5;
const at = (y, m, d, h, mi = 0) => Date.UTC(y, m - 1, d, h - PKT, mi);
const MON = [2026, 9, 7];    // Monday 7 September 2026
const FRI = [2026, 9, 11];   // Friday 11 September
const NEXT_MON = [2026, 9, 14];

const cfg = S.mergeConfig_(S.DEFAULT_CONFIG, [
  ['timezone', 'Asia/Karachi'],
  ['workingDays', '1,2,3,4,5'],
  ['workingStartHour', '9'],
  ['workingEndHour', '17'],
  ['slaWorkingHours', '16'],
  ['slaWorkingHoursOfficial', '8'],
  ['ourDomains', 'example.com']
]);
const H = 3600000;

// ---------------------------------------------------------------------------
group('Config overrides from the spreadsheet');

eq('numbers coerce', cfg.slaWorkingHours, 16);
eq('lists coerce', cfg.ourDomains, ['example.com']);
eq('int lists coerce', cfg.workingDays, [1, 2, 3, 4, 5]);
eq('booleans: TRUE', S.coerceConfigValue_('dryRun', 'TRUE'), true);
eq('booleans: no', S.coerceConfigValue_('dryRun', 'no'), false);
eq('junk is ignored, default survives',
  S.mergeConfig_(S.DEFAULT_CONFIG, [['slaWorkingHours', 'banana']]).slaWorkingHours,
  S.DEFAULT_CONFIG.slaWorkingHours);
eq('unknown keys cannot be injected',
  S.mergeConfig_(S.DEFAULT_CONFIG, [['__proto__', 'x'], ['nonsense', '1']]).nonsense,
  undefined);

// ---------------------------------------------------------------------------
group('The working-hours clock');

eq('a Monday is a working day', S.localParts_(new Date(at(...MON, 12)), cfg.timezone).dow, 1);
eq('a Saturday is not', cfg.workingDays.indexOf(
  S.localParts_(new Date(at(2026, 9, 12, 12)), cfg.timezone).dow), -1);

near('09:00 to 17:00 is a full day',
  S.workingMsBetween_(at(...MON, 9), at(...MON, 17), cfg) / H, 8);
near('overnight counts for nothing',
  S.workingMsBetween_(at(...MON, 17), at(2026, 9, 8, 9), cfg) / H, 0);
near('Friday evening to Monday morning skips the weekend',
  S.workingMsBetween_(at(...FRI, 16), at(...NEXT_MON, 10), cfg) / H, 2);
near('mail that lands at 21:00 has aged nothing by midnight',
  S.workingMsBetween_(at(...MON, 21), at(...MON, 23, 59), cfg) / H, 0);
near('a whole working week is forty hours',
  S.workingMsBetween_(at(...MON, 9), at(...FRI, 17), cfg) / H, 40);

eq('four office hours from Friday 16:00 lands Monday noon',
  new Date(S.addWorkingHours_(at(...FRI, 16), 4, cfg)).toISOString(),
  new Date(at(...NEXT_MON, 12)).toISOString());
eq('a 16-hour deadline on Friday 18:40 falls on Tuesday close',
  new Date(S.addWorkingHours_(at(...FRI, 18, 40), 16, cfg)).toISOString(),
  new Date(at(2026, 9, 15, 17)).toISOString());
eq('the deadline never lands outside office hours',
  S.localParts_(new Date(S.addWorkingHours_(at(...MON, 16), 2, cfg)), cfg.timezone).hour, 10);

// ---------------------------------------------------------------------------
group('Address recognition');

check('our domain is us', S.isOurAddress_('Ali Raza <ali@example.com>', cfg));
check('their domain is not', !S.isOurAddress_('buyer@acme.pk', cfg));
check('an alias counts as us',
  S.isOurAddress_('sales@partner.com',
    Object.assign({}, cfg, { ourAliases: ['sales@partner.com'] })));
eq('display names are extracted', S.displayName_('"Raza, Ali" <ali@example.com>'), 'Raza, Ali');
eq('a bare address falls back to itself', S.displayName_('ali@example.com'), 'ali@example.com');

// ---------------------------------------------------------------------------
group('The state machine');

const baseCtx = {
  threadId: 'T1', permalink: 'https://mail.google.com/x', subject: 'Quotation for 40 units',
  fingerprint: 'fp1', nowMs: at(...MON, 10), lastInboundMs: at(...MON, 9, 30)
};
const verdict = (over) => Object.assign({
  category: 'COMPANY_NEXT_STEP', confidence: 0.9, summary: 'Awaiting our quotation',
  commitment: 'send quotation', commitment_owner: 'US'
}, over);

let rec = S.decideState_(null, verdict(), baseCtx, cfg);
eq('a first classification is taken at face value', rec.category, 'COMPANY_NEXT_STEP');
eq('the clock starts when their message landed, not when we scanned',
  rec.openedAt, new Date(at(...MON, 9, 30)).toISOString());
check('a deadline is set for our own move', !!rec.dueAt);
check('and it is not yet passed', !rec.overdue);

// The RFP's central rule, enforced in code rather than trusted to the prompt.
const unsureClose = S.decideState_(rec, verdict({ category: 'COMPLETED', confidence: 0.7 }),
  baseCtx, cfg);
eq('an unsure COMPLETED does not close the thread', unsureClose.category, 'COMPANY_NEXT_STEP');
check('it is sent for review instead', unsureClose.needsReview);
eq('and the reason is recorded', unsureClose._reason, 'not confident enough to close');

const sureClose = S.decideState_(rec, verdict({ category: 'COMPLETED', confidence: 0.95 }),
  baseCtx, cfg);
eq('a confident COMPLETED does close it', sureClose.category, 'COMPLETED');
check('a closed thread carries no deadline', !sureClose.dueAt);
check('and cannot be overdue', !sureClose.overdue);

const lowConf = S.decideState_(null, verdict({ confidence: 0.4 }), baseCtx, cfg);
eq('a low-confidence answer is still applied', lowConf.category, 'COMPANY_NEXT_STEP');
check('but flagged for review', lowConf.needsReview);

const garbage = S.decideState_(rec, verdict({ category: 'BANANA' }), baseCtx, cfg);
eq('an unknown category falls back to the last known state', garbage.category, 'COMPANY_NEXT_STEP');
check('and asks for a human', garbage.needsReview);

// A customer who chases us three times must not reset our own deadline.
const chased = S.decideState_(rec, verdict(),
  Object.assign({}, baseCtx, { nowMs: at(2026, 9, 8, 11), lastInboundMs: at(2026, 9, 8, 10) }), cfg);
eq('a follow-up from them does not restart our clock', chased.openedAt, rec.openedAt);
eq('so the deadline is unchanged too', chased.dueAt, rec.dueAt);

// Handing the ball over and taking it back.
const handedOver = S.decideState_(rec, verdict({ category: 'CUSTOMER_NEXT_STEP', confidence: 0.9 }),
  Object.assign({}, baseCtx, { nowMs: at(2026, 9, 8, 12) }), cfg);
check('waiting on them clears the deadline', !handedOver.dueAt);
const backToUs = S.decideState_(handedOver, verdict(),
  Object.assign({}, baseCtx, { nowMs: at(2026, 9, 9, 10), lastInboundMs: at(2026, 9, 9, 9, 15) }), cfg);
eq('and it restarts when they reply', backToUs.openedAt,
  new Date(at(2026, 9, 9, 9, 15)).toISOString());

// Overdue is arithmetic, not opinion.
const stale = S.decideState_(null, verdict(),
  Object.assign({}, baseCtx, { nowMs: at(2026, 9, 10, 12) }), cfg);
check('16 working hours later the same thread is overdue', stale.overdue);

const official = S.decideState_(null, verdict({ category: 'OFFICIAL_FINANCIAL' }), baseCtx, cfg);
check('official mail runs on the shorter clock',
  Date.parse(official.dueAt) < Date.parse(rec.dueAt));

let ticking = JSON.parse(JSON.stringify(rec));
eq('the clock alone can flip a record', S.refreshOverdue_(ticking, at(2026, 9, 10, 12)), true);
check('and it says so', ticking.overdue);
eq('re-running the clock is idempotent', S.refreshOverdue_(ticking, at(2026, 9, 10, 13)), false);

// Monday 09:30->17:00 is 7.5h and Tuesday 09:00->10:30 is 1.5h. The 16 calendar
// hours in between count for nothing.
near('age is reported in office hours, not calendar hours',
  S.ageWorkingHours_(rec, at(2026, 9, 8, 10, 30), cfg), 9, 0.01);

// ---------------------------------------------------------------------------
group('Label planning');

const L = cfg.labels;
eq('a fresh thread gains exactly one state label',
  S.labelPlan_([], rec, cfg), { add: [L.COMPANY_NEXT_STEP], remove: [] });
eq('moving state swaps the label, nothing else',
  S.labelPlan_([L.CUSTOMER_NEXT_STEP], rec, cfg),
  { add: [L.COMPANY_NEXT_STEP], remove: [L.CUSTOMER_NEXT_STEP] });
eq('labels we do not own are never touched',
  S.labelPlan_(['Clients/Acme', 'Tax', L.CUSTOMER_NEXT_STEP], rec, cfg),
  { add: [L.COMPANY_NEXT_STEP], remove: [L.CUSTOMER_NEXT_STEP] });
eq('overdue is an overlay, not a replacement',
  S.labelPlan_([L.COMPANY_NEXT_STEP], Object.assign({}, rec, { overdue: true }), cfg),
  { add: [L.OVERDUE], remove: [] });
eq('clearing overdue removes only the overlay',
  S.labelPlan_([L.COMPANY_NEXT_STEP, L.OVERDUE], rec, cfg),
  { add: [], remove: [L.OVERDUE] });
eq('a settled thread needs no changes', S.labelPlan_([L.COMPANY_NEXT_STEP], rec, cfg),
  { add: [], remove: [] });

eq('a hand-placed label is read back',
  S.humanCategoryFromLabels_([L.OFFICIAL_FINANCIAL, 'Tax'], cfg), 'OFFICIAL_FINANCIAL');
eq('two state labels are ambiguous, so we do not guess',
  S.humanCategoryFromLabels_([L.OFFICIAL_FINANCIAL, L.COMPANY_NEXT_STEP], cfg), null);
eq('overlays alone are not a human verdict',
  S.humanCategoryFromLabels_([L.OVERDUE], cfg), null);

// ---------------------------------------------------------------------------
group('Transcript compaction');

const quoted = [
  'Please find the revised figures attached.',
  '',
  'On Mon, 7 Sep 2026 at 09:30, Ali Raza <ali@example.com> wrote:',
  '> Here is the original quotation',
  '> Regards'
].join('\n');
eq('quoted history is cut at the marker',
  S.stripQuotedAndSignature_(quoted), 'Please find the revised figures attached.');

eq('signatures are cut',
  S.stripQuotedAndSignature_('Confirmed.\n--\nAli Raza\nDirector'), 'Confirmed.');
eq('mobile footers are cut',
  S.stripQuotedAndSignature_('Yes please.\n\nSent from my iPhone'), 'Yes please.');
eq('legal boilerplate is cut',
  S.stripQuotedAndSignature_('Noted.\nCONFIDENTIALITY NOTICE: this message...'), 'Noted.');
eq('a clean message is left alone',
  S.stripQuotedAndSignature_('Kindly share the tax certificate.'),
  'Kindly share the tax certificate.');

const msgs = [];
for (let i = 0; i < 10; i++) {
  msgs.push({
    from: 'buyer@acme.pk', fromName: 'Buyer', date: new Date(at(...MON, 9 + i % 8)),
    direction: i % 2 ? 'OUT' : 'IN',
    body: 'Message number ' + i + ' with some substantive content to carry.'
  });
}
const transcript = S.renderTranscript_(msgs, cfg);
check('the opening request is always kept in full',
  transcript.includes('Message number 0 with some substantive content'));
check('the latest message is kept in full',
  transcript.includes('Message number 9 with some substantive content'));
check('middle messages are compressed', transcript.includes('(earlier)'));
check('our side is marked as US', transcript.includes('US ('));
check('their side is marked as THEM', transcript.includes('THEM ('));

eq('the counterparty is the last external correspondent', S.counterpartyOf_(msgs), 'Buyer');
eq('the inbound clock uses their last message',
  S.lastInboundMs_(msgs), msgs[8].date.getTime());

const tight = Object.assign({}, cfg, { transcriptMaxTotalChars: 300 });
check('an enormous thread is bounded',
  S.renderTranscript_(msgs, tight).length <= 380);

// ---------------------------------------------------------------------------
group('Model response handling');

eq('confidence above one is clamped',
  S.normaliseVerdict_({ category: 'COMPLETED', confidence: 7 }).confidence, 1);
eq('a missing confidence becomes zero',
  S.normaliseVerdict_({ category: 'COMPLETED' }).confidence, 0);
eq('a non-numeric confidence becomes zero',
  S.normaliseVerdict_({ category: 'COMPLETED', confidence: 'high' }).confidence, 0);
eq('an unowned commitment is dropped',
  S.normaliseVerdict_({ commitment: 'do a thing', commitment_owner: 'NONE' }).commitment, '');
eq('an invalid owner defaults to NONE',
  S.normaliseVerdict_({ commitment_owner: 'SOMEBODY' }).commitment_owner, 'NONE');

const stubCtx = { subject: 's', messageCount: 1, firstDateIso: '', lastDateIso: '', nowIso: '' };
S.__nextStatus = 200;
S.__nextBody = JSON.stringify({ stop_reason: 'refusal', stop_details: { category: 'cyber' } });
const refused = S.classifyThread_(stubCtx, 'x', cfg, []);
check('a refusal is not treated as success', !refused.ok);
check('a refusal is surfaced, not swallowed', refused.error.includes('declined'));
check('and it names the category', refused.error.includes('cyber'));

S.__nextBody = JSON.stringify({ stop_reason: 'max_tokens', content: [] });
check('a truncated response is an error, not a guess',
  S.classifyThread_(stubCtx, 'x', cfg, []).error.includes('truncated'));

S.__nextStatus = 400;
S.__nextBody = JSON.stringify({ error: { message: 'bad model id' } });
S.__fetches.length = 0;
const badReq = S.classifyThread_(stubCtx, 'x', cfg, []);
check('a 400 reports the API message', badReq.error.includes('bad model id'));
eq('and is not retried', S.__fetches.length, 1);

S.__nextStatus = 500;
S.__fetches.length = 0;
S.classifyThread_(stubCtx, 'x', cfg, []);
eq('a 500 is retried to the configured limit', S.__fetches.length, cfg.apiMaxRetries + 1);

S.__nextStatus = 200;
S.__nextBody = JSON.stringify({
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: JSON.stringify({
      category: 'CUSTOMER_NEXT_STEP', confidence: 0.88, summary: 'Waiting on their PO',
      commitment: 'send purchase order', commitment_owner: 'THEM', reasoning: 'they said so'
    }) }
  ],
  usage: { input_tokens: 1200, cache_read_input_tokens: 900, output_tokens: 120 }
});
S.__fetches.length = 0;
const good = S.classifyThread_({
  subject: 'PO', counterparty: 'Buyer', messageCount: 3,
  firstDateIso: '2026-09-07T04:00:00Z', lastDateIso: '2026-09-07T06:00:00Z',
  lastDirection: 'OUT', nowIso: '2026-09-07T07:00:00Z', previousCategory: 'COMPANY_NEXT_STEP'
}, 'THREAD TEXT', cfg, [{ subject: 'Tax notice', modelSaid: 'NEW_ENQUIRY',
  humanSaid: 'OFFICIAL_FINANCIAL', excerpt: 'FBR notice' }]);

check('a well-formed response parses', good.ok);
eq('the verdict comes through', good.verdict.category, 'CUSTOMER_NEXT_STEP');
eq('usage is captured for cost tracking',
  S.usageLine_(good.usage), 'in=1200 cached=900 cachewrite=0 out=120');

// ---------------------------------------------------------------------------
group('The API request itself');

const sent = JSON.parse(S.__fetches[0].options.payload);
eq('the configured model is used', sent.model, cfg.model);
eq('adaptive thinking is requested', sent.thinking, { type: 'adaptive' });
eq('effort is passed', sent.output_config.effort, cfg.effort);
eq('the response is schema-constrained', sent.output_config.format.type, 'json_schema');
eq('the schema is closed', sent.output_config.format.schema.additionalProperties, false);
eq('every field is required', sent.output_config.format.schema.required.length, 6);
eq('the category enum matches the code', sent.output_config.format.schema.properties.category.enum,
  S.CATEGORIES);
check('no deprecated thinking budget is sent', sent.thinking.budget_tokens === undefined);
check('no sampling parameters are sent',
  sent.temperature === undefined && sent.top_p === undefined && sent.top_k === undefined);

eq('the stable half of the system prompt is cached',
  sent.system[0].cache_control, { type: 'ephemeral' });
check('the volatile half is not cached', sent.system[1].cache_control === undefined);
check('corrections live in the volatile half',
  sent.system[1].text.includes('OFFICIAL_FINANCIAL'));
check('the cached half is identical across calls',
  sent.system[0].text === S.buildSystemPrompt_(cfg));
check('the prompt states the read-is-not-done rule',
  sent.system[0].text.includes('Reading an email never means the matter is finished'));
check('the prompt carries the RFP\'s quotation example',
  sent.system[0].text.includes('We will prepare the quotation.'));
check('and spells out which way it resolves',
  sent.system[0].text.includes('That exchange is COMPANY_NEXT_STEP'));

eq('auth headers are right', Object.keys(S.__fetches[0].options.headers).sort(),
  ['anthropic-version', 'x-api-key']);
eq('the pinned API version is sent',
  S.__fetches[0].options.headers['anthropic-version'], '2023-06-01');
check('errors are read rather than thrown', S.__fetches[0].options.muteHttpExceptions === true);
check('the thread text reaches the model', sent.messages[0].content.includes('THREAD TEXT'));
check('so does the previous verdict',
  sent.messages[0].content.includes('Previously classified as: COMPANY_NEXT_STEP'));

// ---------------------------------------------------------------------------
group('The daily digest');

const ledger = [
  { threadId: 'a', subject: 'Overdue quotation', counterparty: 'Acme', category: 'COMPANY_NEXT_STEP',
    overdue: true, needsReview: false, summary: 'Quotation promised Monday',
    commitment: 'send quotation', permalink: 'https://m/a', openedAt: new Date(at(...MON, 9)).toISOString() },
  { threadId: 'b', subject: 'New enquiry from Zeta', counterparty: 'Zeta', category: 'NEW_ENQUIRY',
    overdue: false, needsReview: false, summary: 'Asking about lead times', permalink: 'https://m/b',
    openedAt: new Date(at(2026, 9, 8, 9)).toISOString() },
  { threadId: 'c', subject: 'FBR notice', counterparty: 'FBR', category: 'OFFICIAL_FINANCIAL',
    overdue: false, needsReview: false, summary: 'Response required', permalink: 'https://m/c',
    openedAt: new Date(at(2026, 9, 9, 9)).toISOString() },
  { threadId: 'd', subject: 'Awaiting their PO', counterparty: 'Beta', category: 'CUSTOMER_NEXT_STEP',
    overdue: false, needsReview: false, summary: 'They will send the PO', permalink: 'https://m/d',
    openedAt: new Date(at(2026, 9, 9, 9)).toISOString() },
  { threadId: 'e', subject: 'Unclear thread', counterparty: 'Gamma', category: 'COMPANY_NEXT_STEP',
    overdue: false, needsReview: true, summary: '', permalink: 'https://m/e',
    openedAt: new Date(at(2026, 9, 10, 9)).toISOString() },
  { threadId: 'f', subject: 'Closed matter', counterparty: 'Delta', category: 'COMPLETED',
    overdue: false, needsReview: false, summary: 'Delivered', permalink: 'https://m/f',
    openedAt: new Date(at(...MON, 9)).toISOString() }
];
const model = S.buildDigestModel_(ledger, at(2026, 9, 11, 9), cfg);

eq('overdue is its own section', model.counts.overdue, 1);
eq('new enquiries are counted', model.counts.newEnq, 1);
eq('official mail is counted', model.counts.official, 1);
eq('uncertain threads are surfaced, not hidden', model.counts.review, 1);
eq('waiting is separated from actionable', model.counts.waiting, 1);
eq('completed work disappears from the digest',
  Object.keys(model.buckets).reduce((n, k) => n + model.buckets[k].length, 0), 5);
eq('the actionable count excludes waiting and review', model.actionable, 3);
check('an overdue thread appears only once',
  model.buckets.company.filter((r) => r.subject === 'Overdue quotation').length === 0);

const html = S.renderDigestHtml_(model, cfg, 'Mailbox: 3 to action');
check('every row links straight to the conversation', html.includes('href="https://m/a"'));
check('the outstanding commitment is shown', html.includes('send quotation'));
check('age is in working days', html.includes('working day'));
check('the correction instructions are included',
  html.includes('change the Workflow label'));

const nasty = S.buildDigestModel_([{
  threadId: 'x', subject: '<img src=x onerror=alert(1)>', counterparty: '"><script>bad()</script>',
  category: 'COMPANY_NEXT_STEP', overdue: false, needsReview: false,
  summary: 'a & b', permalink: 'https://m/x', openedAt: new Date(at(...MON, 9)).toISOString()
}], at(...MON, 12), cfg);
const nastyHtml = S.renderDigestHtml_(nasty, cfg, 'x');
check('subjects from strangers cannot inject markup', !nastyHtml.includes('<img src=x'));
check('nor can sender names', !nastyHtml.includes('<script>'));
check('but ampersands still read correctly', nastyHtml.includes('a &amp; b'));

const textVersion = S.renderDigestText_(model, cfg);
check('the plain-text fallback lists the overdue item',
  textVersion.includes('Overdue quotation'));
check('and carries links for clients without HTML', textVersion.includes('https://m/a'));

// ---------------------------------------------------------------------------
group('The state ledger round-trips');

const row = S.Store._recordToRow(rec);
const back = S.Store._rowToRecord(row);
eq('category survives', back.category, rec.category);
eq('the deadline survives', back.dueAt, rec.dueAt);
eq('booleans survive the sheet', back.overdue, rec.overdue);
eq('the fingerprint survives', back.fingerprint, rec.fingerprint);
eq('a sheet-written TRUE is read as a boolean',
  S.Store._rowToRecord(['t', '', '', '', 'COMPANY_NEXT_STEP', 0, '', '', '', '', 'TRUE', 'FALSE',
    '', '', 'TRUE', '']).humanLocked, true);

process.exit(report() ? 0 : 1);
