# Lead enrichment pipeline — clinic decision-makers, India

Turns a list of LinkedIn profile URLs into `Name, Role, Clinic, Phone, Email,
Source`, with a provider, a source URL and a check timestamp behind every single
value.

**New here? Read [`START_HERE.md`](START_HERE.md) first.** It gets you to a
working demo in thirty seconds with no accounts.

```bash
./run.sh                              # browser UI on http://127.0.0.1:8000
python3 -m leadenrich.cli demo        # or: fictional sample run, no keys needed
```

---

## What makes this different from a spreadsheet of API calls

Three things, and they are the three that decide whether this work is
deliverable or embarrassing.

**1 · A waterfall that knows the difference between "no" and "not right now".**
Providers are tried in order and the first *accepted* result wins. A clean
no-match is terminal for that provider and the chain advances immediately; a
429, a 5xx or a dropped connection is retried with exponential backoff and
jitter. Conflating the two either burns paid credits re-asking a settled
question, or abandons a provider that was merely rate-limited.

**2 · Deliverability and ownership are never merged.** A validator answers *will
mail land here?* Nothing more. Whether the address belongs to *this person* is a
separate judgement, decided by who asserted it and on what evidence. A catch-all
domain accepts everything and therefore proves neither, so catch-all and unknown
never reach the delivered Email column. Role mailboxes (`info@`, `contact@`) are
refused too — deliverable, but not a named decision-maker's inbox.

**3 · Built to survive 2,000 rows, not just eight.** Every provider is paced to
its published rate limit (Hunter's 15/second *and* 500/minute are both enforced),
and a provider whose key is wrong or whose credits have run out is dropped from
the run on its first `401` rather than being re-proved on every remaining row.
Real websites get real handling: `www`/scheme fallbacks, the site's own contact
link followed rather than paths guessed, a byte ceiling, and a Cloudflare or
JavaScript wall reported as *needs a human* instead of the false negative "no
number found".

**4 · A phone policy that cannot be bypassed by accident.** Every delivered
number is one the business itself published, carries the URL that proves it, and
is labelled with what kind of line it is. A provider's `mobile_phone` field with
no publication evidence is stored, labelled
`provider_supplied_unpublished`, and withheld. There is no code path that turns
it into a "verified mobile" — see [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) for
why that matters commercially, not just ethically.

---

## Architecture

```
  CSV / Sheet ──▶ Ingest ──▶ Identity ──▶ Email ──▶ Validation ──▶ Phone ──▶ Checks
                    │          │            │           │            │         │
                 dedupe    Apollo→PDL   Prospeo→     ZeroBounce   Places→   name and
                 normalise →slug parse  Findymail→   →Hunter      website   employer
                                        Hunter→...   verifier     (robots-   agreement
                                                                  aware)         │
                             ┌────────────────────────────────────────────────────┘
                             ▼
        delivery.csv  ·  audit.csv  ·  review.csv  ·  report.json
        (six columns)    (every source  (what needs   (fill rates,
                          URL, provider,  a human,     provider
                          timestamp,      with a       outcomes,
                          contact type)   suggested    spend)
                                          action)
```

Cross-cutting, all unit-tested: checkpoint/resume per row *and per stage*,
per-provider and global budget caps, provenance on every field, deduplication,
and a review queue that nothing is silently dropped from.

| Module | Responsibility |
|---|---|
| `models.py` | Records, status vocabularies, contact-type labels |
| `config.py` | YAML config; secrets read from the environment, never the file |
| `httpclient.py` | Retry/backoff; transient vs. permanent classification |
| `pipeline.py` | Stage orchestration, waterfall, skip rules, checkpointing |
| `validation.py` | The email gate — deliverability × ownership |
| `phone.py` | Number parsing, contact-type classification, the export gate |
| `normalize.py` | Slug parsing, domains, role canonicalisation, similarity |
| `store.py` | SQLite checkpoints; the UI and CLI share one database |
| `budget.py` | Spend caps that skip a provider rather than fail a row |
| `ratelimit.py` | Token buckets honouring each provider's published pace |
| `breaker.py` | Drops a dead provider from the run after repeated permanent failures |
| `webfetch.py` | Defensive fetching of real public pages: charset, size, walls |
| `io_csv.py` | Ingest, the six delivered columns, audit and review files |
| `sheets.py` | Google Sheets delivery, degrading cleanly when unconfigured |
| `providers/` | One adapter per documented API; each cites its `DOC_URL` |

---

## Providers implemented

| Stage | Adapters |
|---|---|
| Identity | `apollo`, `pdl`, `enrichlayer` *(off by default)*, `linkedin_slug` *(free, local)* |
| Email | `prospeo`, `findymail`, `hunter`, `anymailfinder`, `dropcontact`, `snov` |
| Validation | `zerobounce`, `hunter_verifier` |
| Phone | `google_places`, `website` *(robots-aware, no key needed)* |
| Demo | `demo_identity`, `demo_email_a/b/c`, `demo_validator`, `demo_places`, `demo_website` |

Adding one is a single file plus a `@registry.register` decorator. Order is
configuration, not code.

**Verified against documentation; not executed live.** This build had no vendor
accounts and no egress to them. Request shapes, auth headers and response
parsing follow the documented contracts cited in
[`docs/RESEARCH.md`](docs/RESEARCH.md), and each adapter is unit-tested against
its documented response shape. Before your first paid run:

```bash
python3 -m leadenrich.cli doctor    # what is configured, what is missing
python3 -m leadenrich.cli verify    # one live call per provider, pass/fail report
```

`verify` is the step that converts *documented* into *verified*. It calls every
provider you have configured once, reports whether the key authenticates and the
adapter parses the response, and writes `out/verify_report.json`. It costs a
handful of credits. `smoke --provider <name>` does the same for one provider and
prints the raw response beside the parse.

See [`CREDENTIALS.md`](CREDENTIALS.md) for where each key comes from. Keys live
in a git-ignored `.env` — never in chat, an issue, or a commit.

---

## Configuration

Everything lives in [`config/pipeline.yml`](config/pipeline.yml). The knobs you
will actually touch:

```yaml
waterfalls:
  email: [prospeo, findymail, hunter, anymailfinder, dropcontact, snov]

email_policy:
  accept_deliverability: [deliverable]   # catch-all and unknown are NOT accepted
  export_risky: false                    # true = also ship risky, clearly labelled
  reject_role_accounts: true

phone_policy:
  require_public_evidence: true          # no source URL -> not exported
  allow_provider_personal_mobile: false  # keep false unless you have a legal basis

budget:
  max_total_requests: 20000
  per_provider: { hunter: 2500, google_places: 2200 }

identity_corroboration: false            # true = cross-check every identity provider
```

Secrets never go in that file. Each provider names an environment variable; copy
`.env.example` to `.env` and fill in only what you have bought. A provider with
no key is **skipped, not failed** — so one provider is enough to start.

---

## Delivering

`export` writes the operator's four files. `deliver` turns a finished run into
something you can actually send:

```bash
python3 -m leadenrich.cli deliver <run-id> --client "Acme Clinics" --operator "Your Name"
```

```
out/<run-id>_handover/
  Leads.csv           the six requested columns
  Needs-review.csv    every flagged row, with the reason and what to do
  Audit-trail.csv     37 columns: provider, source URL, check timestamp, contact type
  README.md           cover note — coverage computed from the run, not typed by hand
  Data-dictionary.md  what every column and every phone label means
out/<run-id>_handover.zip
```

The cover note is the part that earns repeat work. It states the fill rate per
column, breaks the Phone column down by *kind of line*, and then lists **why each
blank cell is blank** — catch-all domain, shared mailbox, no published number —
with counts. A withheld provider-supplied mobile is counted and explained there,
never silently dropped, so the client can see there was nothing lawful to give
rather than assuming you missed it. See
[`samples/handover-example/`](samples/handover-example/).

`deliver` refuses a half-finished run unless you pass `--force`, because a fill
rate computed over rows that were never attempted reads to a client as coverage.

To hand over the **system** rather than a list:

```bash
./package.sh      # dist/lead-enrichment-<date>.zip
```

That excludes `.env`, run databases and caches, and then greps the staged copy
for credential-shaped strings — refusing to seal the archive if it finds one.

---

## Tests

```bash
python3 -m pytest          # 281 tests, no network, no credentials
```

| Suite | Proves |
|---|---|
| `test_waterfall.py` | A→B→C fallback; first hit short-circuits; missing keys, budget caps and insufficient input all skip rather than fail |
| `test_httpclient.py` | 429/5xx retried with growing backoff, `Retry-After` honoured, 4xx never retried, 404 returned as data |
| `test_email_gate.py` | Catch-all, unknown, unvalidated, unowned and role addresses all refused; risky export is opt-in and flagged |
| `test_phone_policy.py` | Provider mobiles withheld and never relabelled; evidence required; direct line beats switchboard; Indian formats parsed |
| `test_resume.py` | Finished rows never re-enriched; mid-stage crash resumes correctly; budget state persists |
| `test_adapters.py` | Every adapter against its documented response shape, including empty-but-successful answers |
| `test_identity_check.py` | Name and employer disagreements caught; slug-only names marked weak; client input never overwritten |
| `test_dedupe_and_export.py` | Dedupe keys; exactly six delivered columns; audit retains URL/provider/timestamp/contact-type/status |
| `test_demo_and_budget.py` | Full demo run is deterministic, exercises every branch, and stays inside its caps |
| `test_normalize.py` | Slug parsing, domains, role seniority, similarity measures |
| `test_resilience.py` | Rate-limit pacing exactly matches published limits; the breaker drops a dead provider but never a merely flaky one |
| `test_webfetch.py` | Every real-world page failure: lying charsets, PDFs, oversized pages, JS walls, redirect loops, timeouts |
| `test_handover.py` | The client bundle: fill rates counted not estimated, duplicates out of every denominator, every blank cell explained by the gate that refused it, a withheld number counted but never printed, and packaging that refuses to seal an archive containing a credential |
| `test_web_handover.py` | The browser route that builds the bundle: the same partial-run guard as the CLI, and a demo run stamped fictional whichever path built it |
| `test_website_integration.py` | **No mocked transport** — the provider runs over a real socket against a realistic clinic site, honours robots.txt, follows the site's own "Reach Us" link, and picks a doctor's published direct line over the switchboard |

---

## Documentation

| | |
|---|---|
| [`START_HERE.md`](START_HERE.md) | Get running in three steps |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Provider research, verified contracts, costs, sources, and why a custom app beat Clay/Make/n8n |
| [`docs/OPERATOR_PLAYBOOK.md`](docs/OPERATOR_PLAYBOOK.md) | Pilot → measure → price → deliver → QA |
| [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) | DPDP Act, TCCCPR, and the phone-policy reasoning |
| [`docs/CLIENT_REPLY.md`](docs/CLIENT_REPLY.md) | Ready-to-send proposal with a sample |
| [`samples/handover-example/`](samples/handover-example/) | What the client actually receives — cover note, data dictionary, and the three CSVs, built from the demo fixtures |

---

## Known limitations

* **A bare LinkedIn URL may not resolve.** Proxycurl's July 2025 shutdown ended
  the "URL in, data out" era. Ask clients for name, clinic and domain columns.
* **Paid provider behaviour is unverified here.** Adapters follow current
  documentation and are tested against those response shapes, but no vendor
  account exists in the build environment, so none has been called live.
  `verify` is how you confirm each one on your own machine, and it should be the
  first thing you run after adding keys.
* **The website reader, by contrast, is proven over real HTTP** — against a live
  external site and against a locally served clinic site in
  `test_website_integration.py`. Real Indian clinic domains were unreachable
  from the build sandbox (egress policy), so those specific sites remain
  untested.
* **No independent India/clinic coverage benchmark exists.** Published waterfall
  hit rates come from vendor blogs and were measured on US/EU tech B2B. Run a
  pilot; quote from that.
* **No outreach, ever.** This software reads and enriches. It sends nothing and
  buys nothing.
