/**
 * Prompt.gs — what the model is told, and how the request is shaped for cache.
 *
 * The system prompt is split in two deliberately. The first block is the
 * taxonomy and the rules: it is byte-identical on every call, so it is marked
 * cacheable and costs a tenth of its tokens after the first request of each
 * five-minute window. The second block is the correction history, which changes
 * as the office overrules the model. Putting the volatile half second keeps the
 * expensive half cached — a prefix cache is invalidated by any byte that moves
 * before it.
 */

function buildSystemPrompt_(cfg) {
  return [
'You classify business email conversations for an operations team. You are given',
'one complete Gmail thread. You decide one thing: WHOSE MOVE IS IT, and what is',
'outstanding.',
'',
'## The only question that matters',
'',
'Determine the actual next required action in the conversation. Do not infer it',
'from whether a message is read or unread, from who sent the last message, or',
'from whether our company has replied. A reply is not an action.',
'',
'  Customer: "Please send a quotation for 40 units."',
'  Us:       "Thank you. We will prepare the quotation."',
'',
'That exchange is COMPANY_NEXT_STEP, not CUSTOMER_NEXT_STEP. We have answered',
'but we have not acted; the promise is now the outstanding item, and the matter',
'stays ours until the quotation is actually sent. Only once it is sent does the',
'thread become CUSTOMER_NEXT_STEP, waiting on their decision — and if they then',
'ask a further question, it returns to us.',
'',
'Reading an email never means the matter is finished.',
'',
'## Categories — choose exactly one',
'',
'NEW_ENQUIRY',
'  A new request from a potential or existing customer that nobody on our side',
'  has substantively engaged with yet. The thread has no reply from us, or only',
'  an automatic acknowledgement. Once we have genuinely engaged, it is no longer',
'  a new enquiry.',
'',
'COMPANY_NEXT_STEP',
'  Our company must do something: answer a question, prepare or send a quotation,',
'  review documents, provide information, make a call, take an internal decision,',
'  or deliver on anything we promised. Choose this whenever we have made a',
'  promise that has not visibly been fulfilled inside this thread.',
'',
'CUSTOMER_NEXT_STEP',
'  We are waiting on the other side: to reply, to provide information, to send',
'  documents, to confirm a decision, or to approve something we already sent.',
'  Only choose this when our own last deliverable has actually been delivered.',
'',
'OFFICIAL_FINANCIAL',
'  Correspondence from government authorities, tax offices, regulators, banks,',
'  insurance companies or similar institutions. Use this category for the',
'  institutional counterparty even when an action is also required from us —',
'  these are tracked separately and on a shorter clock.',
'',
'COMPLETED',
'  The matter is demonstrably concluded: delivered and acknowledged, explicitly',
'  closed, cancelled, or pure noise with no action attached (newsletters,',
'  notifications, automated receipts that need no filing).',
'  Silence is not completion. An unanswered question is not completion.',
'  If you are not sure, do not choose COMPLETED — choose the state that keeps',
'  the conversation visible and lower your confidence instead.',
'',
'## Confidence',
'',
'Report your genuine confidence from 0.0 to 1.0.',
'  0.9+  the thread states the next step plainly',
'  0.7   the next step is clear from context but not stated',
'  0.5   plausible reading, real ambiguity',
'  0.3-  you are guessing',
'Under-reporting confidence is cheap: it sends the thread to a human. Over-',
'reporting it on a COMPLETED verdict can lose a customer. Be honest, and be',
'especially conservative before closing anything.',
'',
'## Open commitment',
'',
'If our side has promised, offered or undertaken to do something that has not',
'happened yet, state it in `commitment` as a short concrete phrase in the words',
'of the thread — "send revised quotation", "share tax certificate", "call on',
'Monday". Set `commitment_owner` to US. If the outstanding item is theirs, set',
'it to THEM with the same brevity. If nothing is outstanding, use NONE and leave',
'`commitment` empty.',
'',
'A commitment is only discharged by evidence inside the thread that it was done.',
'',
'## Summary',
'',
'One sentence, under 140 characters, written for somebody scanning thirty rows',
'in a morning digest. State the substance, not the etiquette. Write "Awaiting',
'our revised quotation for 40 units", not "Customer sent an email about a quote".',
'',
'## Transcript conventions',
'',
'Messages are numbered oldest to newest. US is our company; THEM is everyone',
'else. Quoted history and signatures have been stripped, so each message shows',
'only what was newly written. Very old middle messages may appear as one-line',
'digests — the first and the most recent messages are always shown in full.',
'',
'Return only the JSON object required by the schema.'
  ].join('\n');
}

/**
 * Corrections the office has made, replayed as examples. This is how the system
 * learns the house style — that a particular regulator is always
 * OFFICIAL_FINANCIAL, or that a standing client's "noted" really does close a
 * matter — without anyone retraining anything.
 */
function buildCorrectionsBlock_(corrections) {
  if (!corrections || !corrections.length) {
    return 'No human corrections recorded yet.';
  }
  var lines = ['## Corrections made by this office',
    '',
    'On these threads the model chose the first label and a human replaced it',
    'with the second. Treat them as binding precedent for similar mail.',
    ''];
  corrections.forEach(function (c) {
    lines.push('- "' + String(c.subject || '').slice(0, 90) + '"' +
      ' — model said ' + c.modelSaid + ', office corrected to ' + c.humanSaid +
      (c.excerpt ? ' | excerpt: ' + String(c.excerpt).replace(/\s+/g, ' ').slice(0, 160) : ''));
  });
  return lines.join('\n');
}

/** The per-thread user message: metadata the transcript cannot carry, then the thread. */
function buildUserMessage_(ctx, transcript, cfg) {
  return [
    'Thread subject: ' + (ctx.subject || '(no subject)'),
    'Counterparty: ' + (ctx.counterparty || 'unknown'),
    'Messages: ' + ctx.messageCount,
    'Thread started: ' + ctx.firstDateIso,
    'Last message: ' + ctx.lastDateIso + ' (from ' + (ctx.lastDirection === 'OUT' ? 'us' : 'them') + ')',
    'Current time: ' + ctx.nowIso + ' (' + cfg.timezone + ')',
    ctx.previousCategory
      ? 'Previously classified as: ' + ctx.previousCategory +
        (ctx.previousCommitment ? ' | outstanding: ' + ctx.previousCommitment : '')
      : 'Not previously classified.',
    '',
    '--- THREAD ---',
    transcript
  ].join('\n');
}

/** The response contract. No numeric bounds — the API's schema subset omits them. */
function verdictSchema_() {
  return {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES },
      confidence: { type: 'number' },
      summary: { type: 'string' },
      commitment: { type: 'string' },
      commitment_owner: { type: 'string', enum: ['US', 'THEM', 'NONE'] },
      reasoning: { type: 'string' }
    },
    required: ['category', 'confidence', 'summary', 'commitment', 'commitment_owner', 'reasoning'],
    additionalProperties: false
  };
}
