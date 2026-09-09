# Research & Architecture: LinkedIn-sourced clinic decision-maker enrichment (India)

**Date of research:** 9 September 2026
**Scope:** 2,000 LinkedIn profile URLs of clinic owners/directors in India →
delivered as `Name, Role, Clinic, Phone, Email, Source`.

> **How to read this document.** Everything in the *Verified* column was
> confirmed against current vendor documentation surfaced through web search on
> the research date. Everything in *Claimed* is vendor or affiliate marketing and
> is **not** independently verified. The distinction is load-bearing: several
> widely circulated "hit rate" numbers in this market come from blogs owned by
> the vendors being ranked.
>
> **One environment limitation, stated plainly.** This build ran inside a
> sandbox whose egress policy blocked direct HTTPS fetches to `docs.apollo.io`,
> `hunter.io`, `developers.google.com` and similar vendor doc hosts. Doc
> contracts below were therefore reconstructed from search-engine extractions of
> those same official pages rather than from a byte-for-byte page fetch. Each
> adapter in the code carries the doc URL it was built from in a module-level
> `DOC_URL` constant so any contract can be re-checked in one click before a
> paid run. Treat every adapter as **implemented against documentation, not
> executed against a live account** — see "What is untested" at the end.

---

## 1. The finding that reshapes this brief: there is no lawful "LinkedIn URL in, data out" API

Proxycurl — for years the default answer to "how do I turn a LinkedIn profile
URL into structured data?" — **shut down on 4 July 2025**. LinkedIn (Microsoft)
sued its operator Nubela Pte Ltd in the Northern District of California in
January 2025, alleging operation of hundreds of thousands of fake accounts, breach
of the User Agreement, and CFAA violations. Nubela settled rather than litigate,
a permanent injunction was entered, and the People/Company/Jobs endpoints are
gone and are not returning.

Three consequences follow directly, and they should be stated to the client
before any money changes hands:

1. **A bare LinkedIn URL is a weak input.** It is not a database key any
   compliant vendor can look up on demand. What survives is *matching*: send the
   URL to a provider that already holds a licensed or independently-collected
   record and hope it matches. Apollo and People Data Labs both accept a
   LinkedIn URL as a match key — but a miss returns nothing, and there is no
   appeal.
2. **The slug is still free signal.** `linkedin.com/in/dr-anjali-mehta-8b41a2`
   yields a high-probability name (`Anjali Mehta`, honorific `Dr`) with no API
   call and no access-control bypass. That is a legitimate parse of a URL the
   client already possesses, and it is the pipeline's zero-cost baseline.
   It yields **no company, no role, no contact**.
3. **Anything that revives "URL in, data out" by logging in is off the table.**
   Session-cookie scraping, `li_at` token reuse, and headless-browser logins all
   sit on the wrong side of the injunction the industry just watched land. This
   build does none of it and has no code path that could.

**Therefore the pipeline is designed to degrade honestly**, not to pretend. Rows
that cannot be resolved from a URL are routed to a review queue with a stated
reason, and the client is asked up front for optional `name`, `company` and
`domain` columns, which lift the resolvable fraction substantially.

*Sources:* [Proxycurl shutdown notice (Nubela)](https://nubela.co/blog/goodbye-proxycurl/) ·
[ZoomInfo: Proxycurl shut down](https://pipeline.zoominfo.com/sales/proxycurl-api) ·
[Linked API migration guide](https://linkedapi.io/guides/proxycurl-alternatives)

---

## 2. Tool choice: custom application, not Clay / Make / n8n

The brief permitted an orchestrator. Research says build the app. The reasoning:

| Option | Verified position | Verdict |
|---|---|---|
| **Clay** | Powerful waterfalls, but **no public versioned REST API, no public base URL, no OpenAPI spec**. Programmatic entry is an inbound webhook table; a lookup API exists only on Enterprise. Pricing rebuilt 11 Mar 2026 into Data Credits + Actions; Launch **$185/mo** (2,500 data credits), Growth **$495/mo**. | **Rejected.** A 2,000-row one-off would burn a subscription, and the deliverable would not be portable or testable. |
| **Make / n8n** | Both can chain HTTP modules fine. But retry semantics, budget caps, checkpoint/resume and a review queue must be hand-built inside a visual canvas, where they cannot be unit-tested. n8n self-hosted adds an ops surface. | **Rejected** for a job that must be auditable row-by-row. |
| **Custom Python app** | Every provider below is a plain REST call. Adapters are ~60 lines each. Waterfall order, budget caps, provenance, resume and the review queue become ordinary code with ordinary tests. Zero recurring platform cost. | **Chosen.** |

A secondary, decisive reason: the client's own words were "verified mobile
number". Meeting that request *responsibly* requires a phone-classification
policy that refuses to relabel a reception line as a personal mobile. That
policy is enforceable in code with tests. It is not enforceable in a Clay column.

*Sources:* [ZoomInfo: Clay API review](https://pipeline.zoominfo.com/sales/clay-api) ·
[Clay pricing breakdown 2026](https://salesmotion.io/blog/clay-pricing) ·
[Bitscale on Clay HTTP API limits](https://bitscale.ai/blogs/clays-new-pricing-explained-what-the-http-api-limits-mean-for-agencies)

---

## 3. Provider matrix — verified contracts

### 3.1 Identity resolution (LinkedIn URL → person, role, company)

| Provider | Endpoint & auth | Accepts LinkedIn URL? | Notes verified |
|---|---|---|---|
| **Apollo.io** | `POST https://api.apollo.io/api/v1/people/match`, header `x-api-key` | **Yes** — `linkedin_url` param | Personal emails and phones are withheld unless `reveal_personal_emails` / `reveal_phone_number` are set. `reveal_phone_number=true` **requires a `webhook_url`**: phone verification is asynchronous and the result is POSTed back, not returned inline. API access requires a paid plan; some endpoints require a key flagged *master key* or a 403 follows. Documented rate limits are per-minute/hour/day and plan-dependent (Person Enrichment commonly 100/min, bulk 10/min). |
| **People Data Labs** | `GET https://api.peopledatalabs.com/v5/person/enrich`, header `X-Api-Key` | **Yes** — `profile` param | Minimum viable input is `profile` OR `email` OR `phone` OR `lid` OR (`first_name`+`last_name` AND one of locality/region/company/school/postal_code). `min_likelihood` (1–10) trades match rate against match quality. Response can carry `mobile_phone`. |
| **Enrich Layer** | `https://enrichlayer.com/api/v2/...`, Bearer | Claims yes | Positions itself as Proxycurl's successor with a compatibility layer. **Treat with caution**: it inherits the legal exposure that closed Proxycurl. Adapter is shipped **disabled by default** with a warning banner in config. |
| **Coresignal** | Dataset + API, per-record pricing ~$0.196 → ~$0.005 by commitment | Bulk dataset match | Adapter not shipped; noted as the bulk-licensing route if volume grows past one-off work. |
| **Slug parser (local)** | none — pure string parsing | n/a | Free baseline. Extracts probable given/family name and honorific from the URL path. Confidence marked `low`; never exported as a confirmed name on its own. |

### 3.2 Email discovery waterfall (A → B → C …)

| Provider | Endpoint & auth | Key inputs | Verified specifics |
|---|---|---|---|
| **Hunter.io** | `GET https://api.hunter.io/v2/email-finder?api_key=…` | `domain` + `first_name`/`last_name`, **or a LinkedIn handle** (added per changelog) | 1 credit/call. Rate limits **15 req/s and 500 req/min**. Response carries a confidence `score` and, where a recent check exists, `data.verification.status` ∈ `valid | accept_all | unknown`, plus up to 20 `data.sources` with discovery dates — genuinely useful provenance. If `domain` and `company` are both sent, `domain` wins. |
| **Prospeo** | `POST https://api.prospeo.io/linkedin-email-finder`, header `X-KEY` | LinkedIn URL | Documented rate limit ~150 req/min. Frequently ranked first in LinkedIn-sourced waterfalls (claim, not verified). |
| **Findymail** | `POST https://app.findymail.com/api/search/…`, `Authorization: Bearer` | name + domain; LinkedIn variants | **Credit charged only when an email is found.** Verify endpoint consumes a verifier credit on every attempt. |
| **Anymail Finder** | `POST https://api.anymailfinder.com/v5.1/find-email/person`, Bearer | name + domain | Returns `email`, `email_status` (e.g. `valid`), and `credits_charged`. Markets itself on verified-only results. |
| **Dropcontact** | `POST https://api.dropcontact.io/batch`, header `X-Access-Token` | name + company/website | **Asynchronous**: POST returns a `request_id`, results are polled. GDPR-native (EU processing), no third-party database — it derives and verifies. |
| **Snov.io** | OAuth2 `client_credentials` → `https://api.snov.io/v1/oauth/access_token`, then Bearer (1-hour TTL) | name + domain | Cheapest tier of the set; treated as a tail provider. |

**Recommended default order for this brief** (encoded in `config/pipeline.yml`,
and freely reorderable):

```
Prospeo  →  Findymail  →  Hunter  →  Anymail Finder  →  Dropcontact  →  Snov
```

Rationale: Prospeo takes the LinkedIn URL natively, so it runs while identity is
still weakest; Findymail charges only on success, so a miss is free; Hunter adds
*published-source evidence* (`data.sources`), which matters more than raw hit
rate for a deliverable that must cite a Source column. Dropcontact sits late
because it is async and slower per row, not because it is worse.

> **On the coverage numbers circulating for these tools.** Published figures —
> "Prospeo → Findymail → Datagma yields 85–92%", "a three-tool waterfall hit
> 94.2% coverage", "waterfalls add 15–25 points over any single provider" —
> come from vendor and affiliate blogs. The *directional* claim (chaining
> providers beats any single provider) is consistent across every source and is
> the reason waterfalls exist. The *specific percentages* are unverified, and
> critically **none of them were measured on Indian healthcare SMB data.** Every
> one of these tools is strongest on US/EU tech B2B. Small independent Indian
> clinics frequently have no corporate email domain at all — the "work email" is
> a Gmail address — which no domain-pattern finder can construct. Do not quote
> these percentages to the client as expected performance. Quote the pilot.

*Sources:* [Hunter API reference](https://hunter.io/api-documentation/) ·
[Hunter changelog: LinkedIn handle support](https://hunter.io/changelog/linkedin-handle-support-new-api-endpoints-2) ·
[Findymail API docs](https://app.findymail.com/docs/) ·
[Anymail Finder person endpoint](https://anymailfinder.com/email-finder-api/docs/find-person-email) ·
[Dropcontact API key guide](https://support.dropcontact.com/article/237-how-to-use-the-dropcontact-api-key) ·
[Snov.io API](https://snov.io/api) ·
[PDL person enrichment input params](https://docs.peopledatalabs.com/docs/input-parameters-person-enrichment-api) ·
[Apollo people enrichment](https://docs.apollo.io/reference/people-enrichment.md) ·
[Apollo rate limits](https://docs.apollo.io/reference/rate-limits) ·
[Waterfall benchmark claims](https://coldoutreachstack.com/blog/email-waterfall-enrichment-guide/)

### 3.3 Email validation gate

| Provider | Endpoint | Verified specifics |
|---|---|---|
| **ZeroBounce** | `GET https://api.zerobounce.net/v2/validate` | `status` ∈ `valid, invalid, catch-all, unknown, spamtrap, abuse, do_not_mail`. `sub_status` carries the diagnosis (`mailbox_not_found`, `greylisted`, `role_based`, `possible_traps`, `disposable`, `toxic`, `failed_smtp_connection`, …). Disposable and toxic now sit under `do_not_mail`. **No credit is consumed for an `unknown` result.** Also returns `free_email`, `mx_found`, `catchall_domain`, `domain_age_days`, `smtp_provider`. |
| **Hunter Verifier** | `GET https://api.hunter.io/v2/email-verifier` | `status` plus 0–100 `score` and booleans `disposable`, `webmail`, `gibberish`, `accept_all`, `mx_records`, `smtp_check`. Webmail/disposable are assigned an arbitrary score of 50. Returns **HTTP 202** when the check is still running — poll the same URL. |

**The gate, and why it is strict.** The pipeline separates two things the market
routinely conflates:

* **Deliverability** — will mail to this address land? Answered by the validator.
* **Ownership** — does this address belong to *this named person at this clinic*?
  Answered by *who asserted it and on what evidence*, never by the validator.

A `catch-all` domain accepts everything, so it proves nothing about either. In
this build, `catch-all`, `unknown`, `greylisted` and every temporary SMTP
sub-status are classified **`risky_unconfirmed`** and are **excluded from the
delivered Email column by default**, landing in the review queue instead. Role
addresses (`info@`, `contact@`) are separately flagged `role_account` — they may
be perfectly deliverable and are still *not* a named decision-maker's mailbox.
Nothing reaches the Email column labelled verified unless it is
`deliverable` **and** ownership is `provider_asserted` or
`published_on_company_site`.

*Sources:* [ZeroBounce status codes](https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-status-codes) ·
[ZeroBounce validate v2](https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails) ·
[Hunter email verifier](https://hunter.io/api/email-verifier)

### 3.4 Phone — the part of the brief that must be redefined

The proposal asks for a **"verified mobile number (+91)"**. That request, taken
literally, means a personal mobile line, harvested at scale, for cold calling
Indian citizens. This build does not do that, and the reasons are commercial as
much as ethical:

* **DPDP Act, 2023.** The publicly-available-data carve-out at s.3(c)(ii) covers
  data *the data principal themselves made public*. It is narrow. Legal analysis
  is consistent that it does **not** license indiscriminate scraping, that the
  source of each datum must be verifiable to claim the exemption, and that
  **direct-marketing processing requires prior opt-in consent even in B2B**.
  Implied consent is not a lawful basis under the Act.
* **TCCCPR 2018, as amended 12 February 2025.** Commercial calling in India is
  a registration regime: Principal Entities and telemarketers must pre-register
  with physical/biometric verification, promotional calls must originate from
  the 140 series, calling is confined to 09:00–21:00, and the DND registry is
  binding. Financial disincentives run **₹2 lakh / ₹5 lakh / ₹10 lakh** for
  first, second and subsequent violations. A scraped personal mobile is
  precisely the artefact this regime exists to suppress.

**What the pipeline delivers instead — and it is genuinely more useful:**

| Class | Definition | Exported? |
|---|---|---|
| `clinic_main_line` | The clinic's own published number (Google Business Profile, clinic website contact page). | **Yes**, labelled as such. |
| `published_direct_line` | A number the clinic *itself* publishes against the named individual — e.g. "Dr Mehta — direct: +91 …" on the practice's own Team page. | **Yes**, labelled as such, with the evidence URL retained. |
| `published_business_mobile` | A mobile the business publishes as its own business contact (extremely common for Indian clinics, where the practice mobile *is* the business line). | **Yes**, labelled as such, with evidence URL. |
| `provider_supplied_unpublished` | A provider's `mobile_phone` field with no public evidence behind it. | **No.** Off by default (`allow_provider_personal_mobile: false`). If a client switches it on under their own legal basis, it is written to the audit file with that exact label and routed to review — it is **never** relabelled "verified mobile". |

**Primary phone source: Google Places API (New).** This is a first-party,
licensed, ToS-clean route to the number a clinic has itself published.
Verified contract: `POST https://places.googleapis.com/v1/places:searchText`
and `GET https://places.googleapis.com/v1/places/{PLACE_ID}`, authenticated with
`X-Goog-Api-Key`, with a **mandatory `X-Goog-FieldMask` header**. Billing note
that matters: `internationalPhoneNumber`, `nationalPhoneNumber` and `websiteUri`
are **Enterprise-SKU fields**; requesting them bills the whole call at Enterprise
(~$20/1,000 at standard volume, with roughly 1,000 free Enterprise calls/month
since Google retired the shared $200 credit in March 2025). Requesting a field
you do not need silently upgrades your bill, so the adapter sends the narrowest
mask that satisfies the brief.

**Secondary phone source: the clinic's own website.** The pipeline fetches the
clinic's public contact/about page, respects `robots.txt`, extracts `tel:` links
and `+91` patterns, validates them with `phonenumbers`, and **stores the page URL
as evidence**. No login, no paywall, no access control is touched.

**Corroboration source: the National Medical Register (NMC).** India's NMR
publishes, for public verification, a practitioner's registration number, name,
date of registration, place of employment, qualifications and specialty. It is a
government register designed to be checked. It carries no contact details — but
it is an excellent independent confirmation of **Name + Role + institution**,
which is three of the six delivered columns.

*Sources:* [Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details) ·
[Place Data Fields (New) — SKU tiers](https://developers.google.com/maps/documentation/places/web-service/data-fields) ·
[Places usage & billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) ·
[DPDP Act 2023 (MeitY PDF)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) ·
[Publicly available data exemption analysis](https://law.asia/publicly-available-data-dpdpa/) ·
[FPF: DPDP Act explained](https://fpf.org/blog/the-digital-personal-data-protection-act-of-india-explained/) ·
[TRAI PIB release on TCCCPR amendments](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2102413&reg=48&lang=2) ·
[Securiti: India spam rules](https://securiti.ai/india-spam-rules-trai-latest-amendment/) ·
[NMR portal launch (PIB)](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2048222&reg=48&lang=2)

### 3.5 Delivery

**Google Sheets API v4**, service-account auth: create a service account, download
the JSON key, enable the Sheets API, and **share the target spreadsheet with the
service account's `client_email` as an Editor** — the single most common cause of
a 403 here is forgetting that share step. The pipeline writes the six delivery
columns to the client's sheet and keeps the full audit ledger locally.

---

## 4. Architecture

```
                 ┌──────────────┐
  CSV / Sheet ──▶│   Ingest     │ normalise · dedupe (slug + name⊕company)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   Apollo → PDL → [Enrich Layer] → slug parse
                 │  Identity    │   ⇒ Name · Role · Clinic · domain
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   Prospeo → Findymail → Hunter →
                 │ Email water- │   Anymail → Dropcontact → Snov
                 │    fall      │   stop on first ACCEPTED result
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   ZeroBounce (or Hunter verifier)
                 │  Validation  │   deliverable · risky · undeliverable
                 │     gate     │   ⊗ catch-all/unknown never = confirmed
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   Google Places → clinic website (robots-aware)
                 │    Phone     │   classify · evidence URL required
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   name/company agreement across providers
                 │Identity check│   ⇒ pass · weak · conflict → review
                 └──────┬───────┘
                        ▼
        ┌───────────────┴────────────────┐
        ▼                                ▼
  delivery.csv / Sheet            audit.csv  +  review_queue.csv
  Name Role Clinic Phone          every provider call, source URL,
  Email Source                    timestamp, status, cost, contact type
```

**Cross-cutting engine properties** (all unit-tested):

* **Waterfall** — ordered, per-stage, short-circuits on the first *accepted*
  result; acceptance is a policy function, not "provider returned 200".
* **Transient vs. no-match** — a 429/5xx/timeout/connection error is transient
  and retried with exponential backoff plus jitter; a clean 200 carrying no
  match is **terminal for that provider** and immediately advances the
  waterfall. Conflating these is the classic way to burn credits and still
  under-deliver.
* **Checkpoint / resume** — SQLite, per-row and per-stage. Killing the process
  mid-run and restarting resumes exactly where it stopped, with no repeated
  paid calls.
* **Budget caps** — global and per-provider request caps plus an estimated-spend
  ceiling. When a cap trips, the provider is skipped (not failed) and the row
  continues down the waterfall.
* **Provenance** — every field carries `{value, status, provider, source_url,
  checked_at, evidence, confidence}`. The six delivered columns are a *view*
  over that ledger; the ledger itself is retained.
* **Review queue** — unresolved identity, conflicting names, risky email,
  unevidenced phone. Nothing is silently dropped and nothing is silently
  upgraded.

---

## 5. Honest cost and coverage model for 2,000 rows

Per-provider list prices move constantly; the pipeline therefore *measures* cost
rather than assuming it — `budget.py` records estimated credits per call and
`--max-spend` halts the run. The structural points that will not change:

* Email discovery cost is dominated by **misses**, not hits — except at
  Findymail, which charges only on success. This is why a success-only-billing
  provider belongs early in the order.
* Validation is cheap relative to discovery and **must not be skipped**: an
  unvalidated list is what produces the bounce complaints that end contracts.
  ZeroBounce not charging for `unknown` removes the last excuse.
* Places calls that request phone/website are billed at **Enterprise** rates.
  With ~1,000 free Enterprise calls/month, a 2,000-row job straddles the free
  tier; run it across two billing months or accept roughly one Enterprise-rate
  thousand.

**What to tell the client about coverage.** Not a percentage — a pilot. Run 100
rows, publish the real per-column fill rate and the real review-queue rate, then
price the remaining 1,900 against measured numbers. Any quote for Indian clinic
data that leads with a US-derived 90% figure is quoting someone else's dataset.

---

## 6. What is implemented vs. what is untested

**Implemented and tested** (deterministic mocked transports, no network):
waterfall ordering and A→B→C fallback; transient-retry vs. terminal-no-match;
checkpoint/resume; the email validation gate including catch-all rejection;
phone classification and the refusal to relabel; dedupe; budget caps;
export schema and the audit sidecar; the review queue; the full demo run.

**Implemented against documentation, never executed live** — because this
environment has no accounts, keys, or egress to the vendors: every real provider
adapter (Apollo, PDL, Enrich Layer, Hunter, Prospeo, Findymail, Anymail Finder,
Dropcontact, Snov, ZeroBounce, Google Places), the Google Sheets writer, and the
robots-aware website fetcher. Their request shapes, auth headers and response
parsing follow the documented contracts cited above. **Before the first paid
run, execute `leadenrich doctor` and then `leadenrich smoke --provider <name>`**,
which sends exactly one live call per configured provider and prints the raw
response next to what the adapter parsed from it. That is the step that converts
"documented" into "verified", and it costs a handful of credits.

No purchases, outreach, or messages are made by this software. It reads and
enriches; it never sends.
