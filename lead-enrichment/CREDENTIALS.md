# Adding your API keys

## Do not send keys through chat

Not to me, not to anyone. A chat transcript is stored, searchable, and cannot be
un-sent; a leaked provider key can be spent by whoever finds it. Every key below
goes into a file on your own machine that is already in `.gitignore`.

If you have already pasted a key into a chat anywhere, rotate it now — every
provider here has a "regenerate key" button, and it takes ten seconds.

## The whole process

```bash
cd lead-enrichment
cp .env.example .env      # run.sh does this for you on first launch
```

Open `.env` in any text editor, paste each key after its `=`, save. Then:

```bash
python3 -m leadenrich.cli doctor    # what is configured, what is missing
python3 -m leadenrich.cli verify    # one real call per provider — proves it works
```

`verify` is the step people skip and regret. It makes exactly one live call to
each provider you have configured and tells you whether the key authenticates,
whether the plan covers the endpoint, and whether the adapter parses what comes
back. It costs a handful of credits and it is the difference between finding a
problem now and finding it on row 400 of a paid run.

## What each key buys you

**You do not need all of these.** A provider with no key is skipped, not faked.
Start with two.

| Priority | Key | Where to get it | What it gives you |
|---|---|---|---|
| **Start here** | `HUNTER_API_KEY` | [hunter.io](https://hunter.io) → Dashboard → API | Email finder **and** verifier on one key, plus the public URLs where an address was seen — the evidence behind your Source column |
| **Start here** | `GOOGLE_MAPS_API_KEY` | [Google Cloud Console](https://console.cloud.google.com) → enable **Places API (New)** → Credentials | Published clinic phone numbers, first-party and licensed |
| Then | `ZEROBOUNCE_API_KEY` | [zerobounce.net](https://www.zerobounce.net) → API | Proper validation. Costs nothing on an `unknown` result |
| Then | `PROSPEO_API_KEY` | [prospeo.io](https://prospeo.io) → API | Takes the LinkedIn URL directly, so it runs before a domain is known |
| Optional | `FINDYMAIL_API_KEY` | [findymail.com](https://www.findymail.com) → API | Charges only on a hit, so a miss is free — why it sits second in the chain |
| Optional | `APOLLO_API_KEY` | [apollo.io](https://apollo.io) → Settings → Integrations → API | Identity resolution. Needs a paid plan for API access |
| Optional | `ANYMAILFINDER_API_KEY`, `DROPCONTACT_API_KEY`, `SNOV_CLIENT_ID` + `SNOV_CLIENT_SECRET` | each provider's dashboard | Extra coverage on the tail — each only sees rows the others missed |

### Restrict the Google key

In Cloud Console, set the key's **API restrictions** to *Places API (New)* only.
An unrestricted Maps key found in a repository has been used to run up four-figure
bills. Also set a **budget alert** on the project: phone and website are
Enterprise-SKU fields at roughly $20 per 1,000 calls, with about 1,000 free
Enterprise calls a month.

## Google Sheets delivery (optional)

Only if you want rows written straight into a client's sheet.

1. Google Cloud Console → **Enable the Google Sheets API**
2. **Credentials → Create credentials → Service account**, then **Keys → Add key
   → JSON**. Save the file outside the repository.
3. Point `GOOGLE_SHEETS_CREDENTIALS_FILE` at that file, and
   `GOOGLE_SHEET_ID` at the long id in your sheet's URL.
4. **Share the spreadsheet with the service account's `client_email` as an
   Editor.** Forgetting this is the cause of almost every 403 here.

`doctor` prints the exact address to share with once the file is configured.

## What the app does with a key

* Reads it from the environment at call time. It is never written to any output
  file, never logged, and never included in the audit trail.
* `.env` is git-ignored, so a key cannot be committed by accident.
* If a key is wrong the circuit breaker trips on the first `401` and drops that
  provider for the rest of the run, rather than re-proving it two thousand times.

## Cost control before your first real run

Set these in `config/pipeline.yml` before spending anything:

```yaml
budget:
  max_total_requests: 500        # a hard ceiling for the whole run
  max_estimated_credits: 400
  per_provider:
    google_places: 120           # the Enterprise SKU — watch this one
```

Then run a pilot rather than the full list:

```bash
python3 -m leadenrich.cli run leads.csv --limit 100
```

A tripped cap **skips** a provider; it never fails a row. So the worst case is a
run that delivers less, not a run that overspends.
