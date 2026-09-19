# Streamer Lead Workspace

A local, single-user research tool for collecting **Whatnot** and **eBay Live**
streamer leads. It produces one deliverable: a CSV with exactly three columns —
**Profile Link**, **Follower Count**, **Email Address** — ready to import into
Google Sheets.

Everything runs on your own machine. There is no account, no cloud service, no
search API and no scraper.

---

## What the application does, and what you do

The split is deliberate: the tool removes repetition, you keep the judgement.

**The application handles**

- Building Google search queries for each platform and category
- Opening the search or profile you select, in your own browser
- Cleaning pasted profile URLs (tracking parameters, trailing slashes, casing)
- Detecting duplicate profiles before they reach the database
- Normalising follower counts (`1,250` → `1250`, `1.2K` → `≈ 1200`)
- Checking email format
- Flagging missing fields and telling you which one to fill next
- Keeping your progress through refreshes and restarts
- Sorting leads into Incomplete / Ready for review / Approved
- Generating the client's three-column CSV, with formula-injection protection

**You handle**

- Reading search results and deciding who is worth pursuing
- Opening profiles and confirming the person is a livestream seller
- Reading the follower count off the profile
- Finding a publicly listed business email and confirming it belongs to them
- Approving each record before it is exported

When the application cannot do something reliably, it says so and asks you.
It never invents a follower count or an email address.

---

## Requirements

| Software | Version | Where |
|---|---|---|
| Python  | 3.10 or newer | <https://www.python.org/downloads/> — tick **Add python.exe to PATH** |
| Node.js | 18 or newer (LTS) | <https://nodejs.org/> |

---

## Windows setup

Open **PowerShell**, then:

```powershell
# 1. Check the prerequisites (both commands should print a version)
python --version
node --version

# 2. Go to the project folder
cd path\to\streamer-leads

# 3. Install everything (first run only - takes a minute or two)
python run.py --setup-only
```

That creates the Python virtual environment in `backend\.venv`, installs the
API dependencies, and installs the web dependencies in `frontend\node_modules`.

### Starting the application

Either double-click **`start.bat`**, or run:

```powershell
cd path\to\streamer-leads
.\start.ps1
```

or, equivalently, from any platform:

```powershell
python run.py
```

The window prints the address to open:

```
  OPEN THIS IN YOUR BROWSER:   http://localhost:5173
```

Leave that window open while you work. Press **Ctrl+C** in it to stop both
servers.

On macOS or Linux use `./start.sh` instead.

### If port 8000 is already taken

```powershell
python run.py --port 8010
```

---

## Collecting your first ten leads

1. Open **http://localhost:5173** — you land on **Research**.
2. Choose **Whatnot** or **eBay Live** on the left.
3. Pick a **Search category** (for example *Trading cards*) and select
   **Generate Searches**. Six query variations are produced.
4. Select **Open Search**. Google opens in a new tab. Use **Next** / **Prev**
   to try other variations, or **Copy** to paste the query elsewhere.
5. Browse the results yourself and open a profile that looks like a genuine
   livestream seller.
6. Copy the profile URL and paste it into **Profile Link**. The application
   cleans it, and warns you immediately if that profile is already saved.
7. Select **Open Profile** (or press `Alt+O`) and read the **follower count**
   off the page. Type it in — `1250`, `1,250` and `1.2K` are all understood.
   An abbreviated figure is stored and displayed as approximate.
8. Find the streamer's publicly listed business email. **Search for Business
   Email** opens a Google search built from their username; you read the
   results and decide.
9. Select **Save & Next** (or press `Ctrl+Enter`). The lead is saved, the form
   clears and the cursor returns to Profile Link, ready for the next streamer.
   - No email available? Use **Save Incomplete** and return to it later.
10. Repeat until you have ten. Then open **My Leads**, check each record, and
    select **Approve** on the ones you are satisfied with.
11. Open **Export**, select **Preview Export** to see the exact rows, then
    **Download CSV**.
12. In Google Sheets: **File → Import → Upload**, choose the file, pick
    *Replace spreadsheet*, then **Import data**.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Move to the next field |
| `Ctrl` + `Enter` | Save & Next |
| `Ctrl` + `S` | Save the current lead |
| `Alt` + `O` | Open the current profile |

---

## Optional: Paste Research Text

On the Research screen, **Paste Research Text** accepts an excerpt you are
allowed to use — a profile line, a contact page. Plain pattern matching then
offers candidates:

- A number is only offered as a follower count when the word *follower* sits
  next to it, so viewer counts, feedback scores and sales totals are not
  mistaken for followers.
- Suggestions are never applied automatically, and you are asked before an
  existing value is replaced.

There is no OCR, no screenshot analysis and no AI service behind this.

---

## Workflow states

| State | Meaning |
|---|---|
| **Incomplete** | One or more of the three fields is missing. Never exported. |
| **Ready for review** | All three fields are present and pass format checks. This is *not* a claim that the information is correct. |
| **Approved** | You have personally reviewed it. Only these are exported. |

Editing a key field on an approved lead returns it to *Ready for review*, so a
changed record cannot slip into the export unreviewed. There is no bulk
approve, by design.

---

## The export

```
Profile Link,Follower Count,Email Address
https://www.whatnot.com/user/example,1250,contact@example.com
```

- Approved leads only; incomplete and unreviewed records are excluded
- Duplicate profiles are removed
- UTF-8 with a BOM, so accented characters survive Excel and Google Sheets
- Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed
  with an apostrophe so a spreadsheet cannot execute them as formulas
- Nothing else is exported: no status, no dates, no internal identifiers

Where a follower count was entered in abbreviated form (`1.2K`), the export
carries the rounded figure as digits (`1200`), and the Export screen says how
many rows that affects.

---

## Where your data lives

| Path | Contents |
|---|---|
| `backend/data/leads.db` | Your leads (SQLite). Copy this file to back it up. |
| Browser local storage | The half-finished form and your platform/category choice, so a refresh loses nothing. |

Saved leads live in the database, never in the browser — closing the browser or
restarting the backend does not lose them.

---

## Running the tests

```powershell
cd backend
.venv\Scripts\python -m pytest tests\ -v
```

The suite covers URL normalisation and duplicate detection, follower-count
parsing and its approximate flag, email validation, the status transitions,
approval, approved-only export, the exact three-column schema, CSV formula
injection, persistence across a backend restart, and that search links are
ordinary Google URLs with no outbound request made by the application.

---

## Troubleshooting

**"The backend is not responding" banner**
The API window has closed. Restart with `python run.py`.

**`python` is not recognised**
Python is not on your PATH. Re-run the installer and tick *Add python.exe to
PATH*, or use `py run.py`.

**`npm` is not recognised**
Install Node.js LTS, then open a *new* PowerShell window.

**Port already in use**
`python run.py --port 8010`.

**PowerShell blocks the script**
`powershell -ExecutionPolicy Bypass -File .\start.ps1`

**Starting over**
Delete `backend\data\leads.db`. A fresh, empty database is created on the next
start.

---

## What this application deliberately does not do

No search API (Brave, Google CSE, SerpAPI, Bing, Tavily). No scraper for
Whatnot, eBay, Google or social media. No CAPTCHA or rate-limit circumvention.
No email-finding service and no guessed addresses. No verification emails. No
Google Sheets API and no access to your Google account. No CRM, outreach,
billing, analytics or lead-scoring features. No paid model API — the
application runs entirely on ordinary Python and application logic.

Search URLs are constructed as plain strings and opened by your browser when
you click. The application itself makes no outbound requests.
