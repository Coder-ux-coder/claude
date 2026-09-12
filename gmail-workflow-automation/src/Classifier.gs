/**
 * Classifier.gs — the one place that talks to the Anthropic API.
 *
 * Google Apps Script cannot install the official Anthropic SDK (no npm, no
 * Node runtime), so this is a direct HTTPS call against the Messages API.
 * Everything the SDK would normally do for us — retries, backoff, error
 * classification, schema validation — is done explicitly below.
 */

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

/**
 * Classify one thread.
 * @return {{ok: boolean, verdict: object|null, error: string, usage: object|null}}
 */
function classifyThread_(ctx, transcript, cfg, corrections) {
  var payload = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    // Judging whose move it is, is reasoning — not keyword matching. Adaptive
    // thinking lets the model spend tokens on the hard threads and skip it on
    // the obvious ones, which is exactly the shape of an email queue.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: cfg.effort,
      format: { type: 'json_schema', schema: verdictSchema_() }
    },
    system: [
      {
        type: 'text',
        text: buildSystemPrompt_(cfg),
        // Stable across every call — cached, then billed at a tenth.
        cache_control: { type: 'ephemeral' }
      },
      {
        type: 'text',
        text: buildCorrectionsBlock_(corrections)
      }
    ],
    messages: [
      { role: 'user', content: buildUserMessage_(ctx, transcript, cfg) }
    ]
  };

  var res = anthropicFetchWithRetry_(payload, cfg);
  if (!res.ok) return { ok: false, verdict: null, error: res.error, usage: null };

  var body = res.body;

  // A safety decline is not a crash — it is a thread a human should look at.
  if (body.stop_reason === 'refusal') {
    return {
      ok: false, verdict: null, usage: body.usage || null,
      error: 'model declined to classify (' +
        ((body.stop_details && body.stop_details.category) || 'unspecified') + ')'
    };
  }
  if (body.stop_reason === 'max_tokens') {
    return { ok: false, verdict: null, usage: body.usage || null,
      error: 'response truncated — raise maxTokens' };
  }

  var text = firstTextBlock_(body);
  if (!text) {
    return { ok: false, verdict: null, usage: body.usage || null,
      error: 'no text block in response' };
  }

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, verdict: null, usage: body.usage || null,
      error: 'unparseable JSON: ' + String(text).slice(0, 200) };
  }

  return { ok: true, verdict: normaliseVerdict_(parsed), error: '', usage: body.usage || null };
}

/** Structured output puts the JSON in a text block; thinking blocks precede it. */
function firstTextBlock_(body) {
  var blocks = (body && body.content) || [];
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'text' && blocks[i].text) return blocks[i].text;
  }
  return '';
}

/** Pure: clamp and defend against anything the schema cannot express. */
function normaliseVerdict_(v) {
  var conf = Number(v.confidence);
  if (isNaN(conf)) conf = 0;
  conf = Math.max(0, Math.min(1, conf));
  var owner = String(v.commitment_owner || 'NONE').toUpperCase();
  if (['US', 'THEM', 'NONE'].indexOf(owner) === -1) owner = 'NONE';
  return {
    category: String(v.category || ''),
    confidence: conf,
    summary: String(v.summary || '').slice(0, 300),
    commitment: owner === 'NONE' ? '' : String(v.commitment || '').slice(0, 300),
    commitment_owner: owner,
    reasoning: String(v.reasoning || '').slice(0, 1000)
  };
}

/**
 * POST with backoff. Retries the failures worth retrying (429, 5xx, transport)
 * and never retries the ones that will fail identically forever (400, 401, 403).
 */
function anthropicFetchWithRetry_(payload, cfg) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': getApiKey_(),
      'anthropic-version': ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var lastError = '';
  for (var attempt = 0; attempt <= cfg.apiMaxRetries; attempt++) {
    if (attempt > 0) {
      // 1s, 2s, 4s ... plus jitter, so parallel triggers do not resonate.
      Utilities.sleep(Math.min(30000, Math.pow(2, attempt - 1) * 1000) +
        Math.floor(Math.random() * 500));
    }
    var response;
    try {
      response = UrlFetchApp.fetch(ANTHROPIC_URL, options);
    } catch (e) {
      lastError = 'transport: ' + e;
      continue;
    }
    var code = response.getResponseCode();
    var text = response.getContentText();

    if (code === 200) {
      try {
        return { ok: true, body: JSON.parse(text), error: '' };
      } catch (e) {
        lastError = 'bad JSON envelope: ' + text.slice(0, 200);
        continue;
      }
    }

    var detail = errorMessageOf_(text);
    if (code === 429 || code >= 500) {
      lastError = 'HTTP ' + code + ': ' + detail;
      continue;
    }
    // 400 / 401 / 403 / 404 — retrying changes nothing.
    return { ok: false, body: null, error: 'HTTP ' + code + ': ' + detail };
  }
  return { ok: false, body: null, error: 'gave up after ' +
    (cfg.apiMaxRetries + 1) + ' attempts — ' + lastError };
}

function errorMessageOf_(text) {
  try {
    var j = JSON.parse(text);
    return (j.error && j.error.message) ? j.error.message : String(text).slice(0, 300);
  } catch (e) {
    return String(text).slice(0, 300);
  }
}

/** Cost bookkeeping, written to the log so the bill is never a surprise. */
function usageLine_(usage) {
  if (!usage) return '';
  return 'in=' + (usage.input_tokens || 0) +
    ' cached=' + (usage.cache_read_input_tokens || 0) +
    ' cachewrite=' + (usage.cache_creation_input_tokens || 0) +
    ' out=' + (usage.output_tokens || 0);
}
