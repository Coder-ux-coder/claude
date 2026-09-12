/**
 * Digest.gs — one email a morning, and the only part of the system that has an
 * opinion about how your day should start.
 *
 * The digest is deliberately an email rather than a dashboard. The RFP is
 * explicit that there is to be no second application to check, and an email
 * arrives on every device the mailbox is already signed in on — including the
 * phone, including offline. A dashboard is a place you have to remember to go.
 */

var SECTION_ORDER = [
  { key: 'overdue',   title: 'Overdue — past the agreed response time', accent: '#b3261e' },
  { key: 'company',   title: 'We must act',                              accent: '#8a5300' },
  { key: 'newEnq',    title: 'New enquiries',                            accent: '#1a5fb4' },
  { key: 'official',  title: 'Official &amp; financial',                 accent: '#5b3a91' },
  { key: 'review',    title: 'Needs review — the system was unsure',     accent: '#5f6368' },
  { key: 'waiting',   title: 'Waiting on the other side',                accent: '#1e7b3c' }
];

/** Pure: sort the ledger into the sections the digest prints. */
function buildDigestModel_(records, nowMs, cfg) {
  var buckets = { overdue: [], company: [], newEnq: [], official: [], review: [], waiting: [] };

  records.forEach(function (rec) {
    if (rec.category === 'COMPLETED') return;
    var row = {
      subject: rec.subject || '(no subject)',
      counterparty: rec.counterparty || '',
      summary: rec.summary || '',
      commitment: rec.commitment || '',
      permalink: rec.permalink || '',
      ageHours: ageWorkingHours_(rec, nowMs, cfg),
      overdue: rec.overdue,
      needsReview: rec.needsReview,
      category: rec.category
    };
    if (rec.overdue) buckets.overdue.push(row);
    else if (rec.needsReview) buckets.review.push(row);
    else if (rec.category === 'OFFICIAL_FINANCIAL') buckets.official.push(row);
    else if (rec.category === 'COMPANY_NEXT_STEP') buckets.company.push(row);
    else if (rec.category === 'NEW_ENQUIRY') buckets.newEnq.push(row);
    else if (rec.category === 'CUSTOMER_NEXT_STEP') buckets.waiting.push(row);
  });

  // Oldest first everywhere: the thing that has waited longest is the thing
  // most likely to cost you something.
  Object.keys(buckets).forEach(function (k) {
    buckets[k].sort(function (a, b) { return b.ageHours - a.ageHours; });
  });

  return {
    buckets: buckets,
    counts: {
      overdue: buckets.overdue.length, company: buckets.company.length,
      newEnq: buckets.newEnq.length, official: buckets.official.length,
      review: buckets.review.length, waiting: buckets.waiting.length
    },
    actionable: buckets.overdue.length + buckets.company.length +
                buckets.newEnq.length + buckets.official.length
  };
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatAge_(hours) {
  if (hours < 1) return 'under an hour';
  if (hours < 8) return Math.round(hours) + ' working hours';
  var days = hours / 8;
  return (days < 2 ? '1 working day' : Math.round(days) + ' working days');
}

/** Pure: render the model as an email that reads well on a phone. */
function renderDigestHtml_(model, cfg, subjectLine) {
  var css = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';
  var out = [];
  out.push('<div style="' + css + ';max-width:680px;margin:0 auto;padding:8px 4px;color:#1f1f1f">');
  out.push('<h2 style="margin:0 0 4px;font-size:19px;font-weight:650">' +
    escapeHtml_(subjectLine) + '</h2>');
  out.push('<p style="margin:0 0 18px;font-size:13px;color:#5f6368">' +
    model.actionable + ' conversation' + (model.actionable === 1 ? '' : 's') +
    ' need attention&nbsp;·&nbsp;' + model.counts.waiting + ' waiting on others</p>');

  if (model.actionable === 0 && model.counts.review === 0) {
    out.push('<p style="margin:24px 0;padding:14px 16px;background:#e8f5e9;' +
      'border-radius:8px;font-size:14px">Nothing is outstanding on our side. ' +
      'Every open conversation is waiting on someone else.</p>');
  }

  SECTION_ORDER.forEach(function (section) {
    var rows = model.buckets[section.key];
    if (!rows || !rows.length) return;
    if (section.key === 'waiting' && !cfg.digestIncludeWaiting) return;

    out.push('<h3 style="margin:22px 0 8px;font-size:14px;font-weight:650;' +
      'letter-spacing:.02em;text-transform:uppercase;color:' + section.accent + '">' +
      section.title + ' (' + rows.length + ')</h3>');

    var shown = rows.slice(0, cfg.digestMaxRowsPerSection);
    shown.forEach(function (r) {
      out.push('<div style="border-left:3px solid ' + section.accent +
        ';padding:9px 0 9px 12px;margin:0 0 9px">');
      out.push('<div style="font-size:14px;font-weight:600;line-height:1.35">' +
        (r.permalink
          ? '<a href="' + escapeHtml_(r.permalink) + '" style="color:#1a0dab;text-decoration:none">' +
            escapeHtml_(r.subject) + '</a>'
          : escapeHtml_(r.subject)) + '</div>');
      if (r.summary) {
        out.push('<div style="font-size:13px;color:#3c4043;margin-top:3px;line-height:1.45">' +
          escapeHtml_(r.summary) + '</div>');
      }
      if (r.commitment) {
        out.push('<div style="font-size:12.5px;color:#8a5300;margin-top:3px">' +
          'Outstanding: ' + escapeHtml_(r.commitment) + '</div>');
      }
      out.push('<div style="font-size:12px;color:#5f6368;margin-top:4px">' +
        escapeHtml_(r.counterparty) + '&nbsp;·&nbsp;open ' + formatAge_(r.ageHours) + '</div>');
      out.push('</div>');
    });
    if (rows.length > shown.length) {
      out.push('<div style="font-size:12.5px;color:#5f6368;margin:0 0 8px 15px">' +
        '+ ' + (rows.length - shown.length) + ' more in the label</div>');
    }
  });

  out.push('<hr style="border:none;border-top:1px solid #e0e0e0;margin:26px 0 10px">');
  out.push('<p style="font-size:11.5px;color:#80868b;line-height:1.5;margin:0">' +
    'Labels update automatically on every device signed in to this mailbox. ' +
    'To correct a classification, change the Workflow label on the conversation ' +
    'in Gmail — the system records the correction, stops overruling that thread, ' +
    'and learns from it.</p>');
  out.push('</div>');
  return out.join('\n');
}

/** Plain-text fallback, for clients that will not render HTML. */
function renderDigestText_(model, cfg) {
  var out = [];
  SECTION_ORDER.forEach(function (section) {
    var rows = model.buckets[section.key];
    if (!rows || !rows.length) return;
    if (section.key === 'waiting' && !cfg.digestIncludeWaiting) return;
    out.push(section.title.replace(/&amp;/g, '&').toUpperCase() + ' (' + rows.length + ')');
    rows.slice(0, cfg.digestMaxRowsPerSection).forEach(function (r) {
      out.push('  - ' + r.subject + ' [' + r.counterparty + ', open ' +
        formatAge_(r.ageHours) + ']');
      if (r.summary) out.push('      ' + r.summary);
      if (r.permalink) out.push('      ' + r.permalink);
    });
    out.push('');
  });
  return out.join('\n') || 'Nothing outstanding.';
}

function sendDigest() {
  var cfg = getConfig();
  if (!cfg.digestEnabled) return { skipped: 'disabled' };

  var now = Date.now();
  var model = buildDigestModel_(Store.allRecords(), now, cfg);
  var dateLabel = Utilities.formatDate(new Date(now), cfg.timezone, 'EEEE d MMMM');
  var subject = (model.counts.overdue > 0 ? '[' + model.counts.overdue + ' overdue] ' : '') +
    'Mailbox: ' + model.actionable + ' to action — ' + dateLabel;

  var recipients = (cfg.digestRecipients && cfg.digestRecipients.length)
    ? cfg.digestRecipients : [ownEmail_()];
  var to = recipients.filter(String).join(',');
  if (!to) {
    Store.log('WARN', 'digest_no_recipient', '', 'nobody to send to');
    return { skipped: 'no recipient' };
  }

  if (cfg.dryRun) {
    Store.log('INFO', 'digest_dry_run', '', subject);
    return { dryRun: true, subject: subject, counts: model.counts };
  }

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: renderDigestText_(model, cfg),
    htmlBody: renderDigestHtml_(model, cfg, subject),
    name: 'Mailbox Workflow'
  });

  Store.log('INFO', 'digest_sent', '', to + ' | ' + JSON.stringify(model.counts));
  return { sent: to, counts: model.counts };
}
