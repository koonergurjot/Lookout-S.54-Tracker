# Lookout — S.54 Bumping Tracker

A **local-only, offline** web app to manage employee bumping scenarios
(Section 54 layoffs) for a unionized organization, built to track the actual
Article 13 / MIG affiliate-displacement process — not just a generic
domino chain. It tracks individual bumping cases, enforces the real clocks
and validity checks the process depends on, and **automatically builds the
domino chain** when one employee bumps another (A → B → C → D).

Built for a single HR / Labour Relations user. No login, no server, no internet
required. Data is stored in your browser's `localStorage` (with JSON
export/import so it isn't a single point of failure — see below).

---

## How to run

**Option A — just open the file (simplest)**

1. Download/clone this folder.
2. Open **`public/index.html`** in any modern browser (Chrome, Edge, Firefox).
3. Done. It works fully offline.

**Option B — local dev server** (only if your browser blocks `file://` features)

```bash
# from inside this folder:
python3 -m http.server 8000 --directory public
#   then visit http://localhost:8000
```

**Option C — deploy to Cloudflare (optional)**

The app is static, so it deploys as Cloudflare Workers static assets. The
included `wrangler.jsonc` points at `./public`, so:

```bash
npx wrangler deploy
```

Only the files in `public/` are published — no server code, no `node_modules`,
no repo internals.

> Your data lives in the browser on the machine you use it on. Using the same
> browser on the same computer keeps your cases between sessions. Clearing
> browser data will erase them — use **Export Data** regularly (top-right) to
> keep an offline JSON backup.

---

## Quick start

1. **Upload Seniority List** (top-right) → choose an `.xlsx` **or** `.csv` file.
   This powers auto-fill, suggestions, and the eligible-target finder. Excel
   files are read directly — no conversion needed.
2. Click **+ Add Case**. Start typing a name — pick from the seniority list and
   Site / Position / Seniority Hours / Employment Status / Hire Date auto-fill.
3. Record the notice/list timeline, then confirm **List Receipt Confirmed** —
   this (not the notice date) starts the real 7-day clock.
4. Under **Decision & Election**, pick the **Elected Option**. Choosing
   *Bump Junior Employee* reveals **Bumps Into** plus an **eligible-target
   list** filtered to valid targets. On save, the app **automatically creates
   that person's case** and links them in the chain.
5. Watch the chain build under the **Domino Chains** tab.
6. The **Dashboard** flags overdue decisions, notice-period/recall issues,
   union-notification gaps, upcoming deadlines, and missing info.

A sample file, `public/sample-seniority.csv`, is included so you can try it
immediately (basic columns only — see "Seniority file parsing" below for the
optional columns).

---

## Core concepts

### Statuses (real lifecycle, not a generic 4-state model)

`Notice Issued` → `List & Vacancies Provided` → `Options Meeting Held` →
`Election Received` → `Placed` **or** `Laid Off` → `Recall Period` → `Closed`

Each forward step is gated on the data it implies (see **Status gates**
below) — the form shows live 🔒 hints and blocks the save with a reason.

### The displacement options (hard enum, not free text)

Electing an option unlocks different required fields and different
downstream clocks:

- **Post to Vacancy** (12.3) — requires a Vacancy Position.
- **Bump Junior Employee** — requires a validated bump target + ability
  attestation (see **Bump-validity checks** below).
- **Transfer to Casual** (29.7) — no extra fields.
- **Voluntary Layoff** — optional "elects casual registration during recall" flag.
- **Apply to Other Posting** (secondary) — requires posting details.

Electing *Bump Junior Employee* does **not** automatically mark the case
"placed" or "decided" — the operator confirms **Decision made** and advances
status explicitly. (Earlier builds of this app force-completed the bumping
case the moment a target was typed; that was wrong — electing to bump isn't
the same as the election being finalized.)

### The two real clocks

- **7-day decision window (13.3)** — runs from **confirmed receipt of the
  current seniority list** (`Seniority List Receipt Confirmed Date` +
  `Receipt Confirmed Via`: Email / Signature / Meeting / Other), **not** the
  S.54 notice date. These are frequently different dates.
- **13.4 scaled notice period** — auto-computed from years of service (hire
  date → notice date): 2 wks in probation, 4 wks post-probation, +1 wk/year
  at 3+ years, capped at 8 wks. **This scaling is a best-effort reading of
  the rule text — confirm the exact break points (especially the probation
  length, `CONFIG.NOTICE_PERIOD.PROBATION_MONTHS`) against your agreement
  and tune `CONFIG.NOTICE_PERIOD` if it's off.** A case can't be moved to
  *Placed* or *Laid Off* while the Effective Date falls before this
  computed end date.
- **13.5 recall period** — 1 year from the *expiry of the notice period*
  (not the notice date), tracked only for `Laid Off` / `Recall Period`
  cases. The Dashboard has a dedicated expiring/expired card.

### 11.2 quarterly list staleness

If a case's S.54 Notice Date falls in a different quarter (Jan/Apr/Jul/Oct 1)
than the one the currently-loaded seniority list was **uploaded** in, the
case is flagged: *"Notice dated ... but the loaded list is the ... quarter —
this may not be the list currently in effect."* This is a heuristic (the file
itself has no "effective quarter" field) — verify against the report's own
title/date when in doubt.

### 13.2(b) / 13.2(c) — steward and union notification

- **Steward Present** checkbox records whether the union steward was at the
  options meeting.
- **Union Notified At** is a timestamp; for any case that results in
  `Laid Off` / `Recall Period`, a missing or >24h-late notification is
  flagged red on the case and on the Dashboard.

### Bump-validity checks (defensibility)

When *Bump Junior Employee* is elected:

- **Junior test (hard block)** — the target must have **fewer** seniority
  hours than the bumper. Saving is blocked outright otherwise, with the
  exact hours shown. The chain view also shows the hours delta on each node.
- **Casual/Temporary block (hard block)** — a target whose Employment Status
  contains "Casual" or "Temp" cannot be saved as a bump target.
- **Duplicate-target flag (soft warning)** — if two cases point at the same
  target, both are flagged: one person can only be displaced once.
- **3% promotion test (soft warning, only when computable)** — if pay
  rate/grid-step data is present on **both** the bumper and the target, a
  target rate more than 3% above the bumper's is flagged. Real affiliate
  seniority exports often don't carry pay rate — when it's absent this
  degrades silently to "unverified," it does not block.
- **Ability-to-perform attestation** — explicit `Ability Assessed By` /
  `Assessment Basis` fields (not a silent assumption); required before a
  case can move to *Placed*.
- **Eligible-target finder** — filters the seniority list to valid
  candidates (more junior, Regular, excluding already-targeted people) and
  ranks by closest seniority (shortest likely domino chain — a judgment
  call; re-rank in `eligibleBumpTargets()` if your practice differs). Every
  candidate still requires the explicit ability attestation.

### Leave of absence

A case can be marked **On Leave**, with an **Expected Return Date** (and an
optional Leave Type — Medical / Parental / WCB / etc.). This matters because a
bump or layoff can't take effect while someone is still away:

- Checking *On Leave* requires a return date to save at all (hard-enforced).
- If the **Effective Date** is earlier than the return date, the form flags
  it and offers a one-click **Use return date as Effective Date** fix.
- A case **cannot** be moved to *Placed* or *Laid Off* while that conflict
  exists.
- The Dashboard has a **Staff On Leave** card/section; on-leave cases show a
  🏖 badge in the Cases list.

### Vacancies tab

The MIG expects the vacancy list to travel with the seniority list. The
**Vacancies** tab is a simple add/delete list (position, site, posted/closing
dates, notes); cases electing *Post to Vacancy* reference a position from it
by name, and `Vacancy List Provided Date` is tracked per case.

### Event / restructuring grouping

Optional **Event / Restructuring** free-text field on each case (e.g.
*"Sturgeon Place – Jul 2026"*, with autocomplete suggestions from prior
entries) — filter the Dashboard, Cases, and Chains views by it so concurrent
restructurings don't blend into one list.

### Document generation (drafts — review before sending)

From an open case: **Displacement Letter**, **Union Notification Email**, and
**Printable Case File** each open a new tab pre-filled from the case's data,
with a print button. These are drafts for you to review/edit — not
pre-cleared legal language.

### Employee ID as a match key

If the seniority list has an Employee ID / Employee Number column, it's
captured and preferred over name-matching wherever the app resolves a person
(snapshot capture, bump-target lookups) — this disambiguates repeated names.
Falls back to name-matching when no ID column is present (most current
Lookout reports don't have one — this degrades gracefully).

---

## Compliance / defensibility features

- **Required-field enforcement (hard).** A case cannot be saved without the
  critical fields (Name, S.54 Notice Date, Effective Date; plus a leave
  return date if On Leave is checked). Configurable.
- **Status gates.** Advancing into `List & Vacancies Provided` /
  `Options Meeting Held` / `Election Received` / `Placed` / `Laid Off`
  requires the data that stage implies — see `CONFIG.STATUS_GATES`.
- **Bump-validity hard blocks** on save (junior test, casual/temp target) —
  see above.
- **Seniority snapshot per case.** When a case is first saved, auto-created in
  a chain, or manually refreshed from the form, the employee's seniority
  record (including employment status and hire date, if known) is **frozen**
  with a timestamp and the provenance of the uploaded list (filename + upload
  time) — what the list showed *when captured*.
- **Decision timestamps.** The exact moment "Decision made" is first recorded
  is stamped and shown.
- **Audit log.** Every create / edit / decision / chain link / seniority
  upload / vacancy change / data import is recorded with timestamp, operator,
  the case, and a field-level before→after diff. View it under the **Audit
  Log** tab, see per-case history inside each case form, and **Export CSV**
  for the record.
- **Whole-database JSON export/import** (top-right **Export Data** /
  **Import Data**) — a `localStorage`-only tool with no backup is a real
  risk; this covers cases, seniority, audit log, and vacancies in one file.
  Import **replaces** current data after a confirmation prompt.
- **Soft warnings (non-blocking)** flag missing recommended fields, overdue
  windows, list staleness, notice-period/recall issues, union-notification
  gaps, steward-presence gaps, duplicate bump targets, missing ability
  attestations, unverified promotion tests, incomplete chains, missing
  snapshots, and bump-cycle loops (including a pure cycle with no external
  root, which is otherwise invisible to simple root-based chain walking) —
  everywhere, without blocking you.
- **Next Action column** in the Cases list gives a one-line "what to do next"
  per case, driven by the same gate logic.

> Single-user tool, so the audit "operator" is a fixed label (`HR/LR User`),
> editable via `OPERATOR` in `app.js`.

---

## ⚠️ Assumptions that need domain review

This build is a fidelity pass against Art. 13 / MIG affiliate-displacement
rules, based on a plain reading of summarized rule text, not the full
collective agreement. Please confirm these before relying on them:

1. **`CONFIG.NOTICE_PERIOD.PROBATION_MONTHS` (currently 6)** — the probation
   length itself wasn't specified; only the notice-period *scaling* was
   ("2 wks probation / 4 wks post-probation / +1 wk/year at 3+ years, max
   8"). Tune `CONFIG.NOTICE_PERIOD` in `app.js` if this is wrong.
2. **11.2 quarter-staleness check** compares the notice date's quarter to the
   quarter the seniority list was **uploaded** in (the file has no explicit
   "effective quarter" field) — a proxy, not a guarantee.
3. **Eligible-target ranking** (closest seniority first) is a judgment call
   favoring the shortest domino chain — confirm this matches practice, or
   re-rank in `eligibleBumpTargets()`.
4. **3% promotion test** only runs when pay rate data is present on both
   sides; current real seniority exports don't include it, so this check is
   effectively dormant until/unless a pay-rate column becomes available.
5. **Duplicate bump target** is a soft warning, not a hard block — confirmed
   intentional (a genuine data conflict should still be visible and fixable,
   not silently prevented), but flag if you'd rather it block outright.
6. **Union notification "24h" reference point** uses the decision timestamp
   (`decisionMadeAt`), falling back to the notice date if no decision
   timestamp exists — confirm this is the right anchor for the 24h window.

---

## Project structure

| File                          | Purpose                                                        |
|-------------------------------|----------------------------------------------------------------|
| `public/index.html`           | Page shell: header, tabs, modal container.                     |
| `public/styles.css`           | All styling (dark-blue / teal palette).                        |
| `public/app.js`               | All logic: storage, chain creation, views, form, xlsx/csv import. |
| `public/sample-seniority.csv` | Example seniority file to test the upload + auto-fill.         |
| `wrangler.jsonc`              | Cloudflare static-assets deploy config (serves `public/`).     |

The app lives entirely in **`public/`** (the only thing that deploys). `app.js`
is organized top-to-bottom in clearly commented sections:
**CONFIG → data model → STORAGE → audit → date/clock helpers → gates &
bump-validity → CSV/XLSX parsers → views (dashboard/cases/chains/vacancies/
seniority/audit) → form → save/chain logic → document generation → events →
bootstrap.**

---

## Where to change things later

Everything you'd normally want to tweak is near the top of `app.js`:

- **Clocks** — `CONFIG.DECISION_WINDOW_DAYS`, `CONFIG.NOTICE_PERIOD`,
  `CONFIG.RECALL_PERIOD_DAYS`, `CONFIG.UNION_NOTIFICATION_HOURS`,
  `CONFIG.LIST_REFRESH_MONTHS`.
- **Status lifecycle** — `CONFIG.STATUSES`, `CONFIG.TERMINAL_STATUSES`.
- **Displacement options** — `CONFIG.OPTIONS` (labels) and `OPTION_FIELDS`
  (which fields each option requires).
- **Which fields are required (flagged when missing)** — `CONFIG.REQUIRED_FIELDS`.
- **Hard enforcement on/off + which fields block saving** — `CONFIG.ENFORCE_CRITICAL`, `CONFIG.CRITICAL_FIELDS`.
- **Status gates (what data each status requires)** — `CONFIG.STATUS_GATES`,
  `gateMet()` / `gateLabel()` for the virtual predicates.
- **Bump-validity rules** — `juniorViolation()`, `targetCasualTempViolation()`,
  `promotionFlag()`, `bumpBlockers()` (hard) vs. `caseWarnings()` (soft).
- **Eligible-target ranking** — `eligibleBumpTargets()`.
- **Audit operator label** — `OPERATOR`.
- **Add / rename a case field** — add it to `newCase()`, give it a label in
  `FIELD_LABELS`, and add an input to `buildFormHTML()`/`optionFieldsHTML()`
  + a line in `readForm()`.
- **How seniority columns (xlsx/csv) are recognized** — `COLUMN_MATCHERS` (one
  matcher function per field, tested against each normalized header cell).
- **Document templates** — `generateLetterHTML()`, `generateUnionNoticeHTML()`,
  `generateCaseFileHTML()`.
- **Colors / look & feel** — CSS variables at the top of `styles.css` (`:root`).
- **Lookout logo** — replace the `.logo-placeholder` element in
  `public/index.html` with an `<img src="logo.png">` (drop `logo.png` in `public/`).

---

## Seniority file parsing (xlsx & csv)

Both `.xlsx` and `.csv` are read **directly in the browser, offline, with no
library** — the `.xlsx` reader uses the browser's built-in `DecompressionStream`
to unzip and `DOMParser` to read the cells. It is tuned for real Lookout
seniority reports:

- **Header auto-detection** — report title rows (e.g. “Lookout Housing…”,
  “Seniority Report”, the quarter) above the real header are skipped; the header
  row is found wherever it sits.
- **Flexible column mapping** — matched on content, not position:
  - **Name** ← “Last, First” / “Last, First Name” / “Name” / “Employee” *(required)*
  - **Position** ← “Job class” / “Position” / “Classification” / “Title”
  - **Site** ← “Location” / “Site” / “Facility”
  - **Seniority Hours** ← “Total Seniority” / “Total SEN…” / “Hours” *(required)*
  - **Employee ID** ← “Employee ID” / “Emp #” / “Employee Number” *(optional)*
  - **Employment Status** ← “Employment Status” / “Employee Status” *(optional —
    confirmed present in real Lookout reports; drives the casual/temp bump-target block)*
  - **Hire/Seniority Date** ← “Hire Date” / “Seniority Date” / “Date of Hire” *(optional —
    confirmed present in real Lookout reports; drives the 13.4 notice-period scaling)*
  - **Pay Rate** ← “Pay Rate” / “Hourly Rate” / “Grid Step” *(optional — not present
    in current real reports; drives the 3% promotion test when available)*
- Footer/total rows and blanks are skipped; seniority values are cleaned
  (commas stripped, float noise rounded to 2 dp). Optional columns that
  aren't found simply stay blank — nothing hard-fails because a column is missing.

Verified against three real reports (Q4 2025, Q1 2026, May 2026) for the
core columns — 1,454 / 1,485 / 1,477 employees parsed exactly. To recognize a
new column name later, edit `COLUMN_MATCHERS` in `app.js`.

> Browser support for direct `.xlsx`: any current Chrome/Edge/Firefox/Safari
> (needs `DecompressionStream`). The app falls back with a clear message if not
> available — save as `.csv` in that rare case. Legacy `.xls` is not supported.

## Notes & limits

- Data is per-browser `localStorage`. Use **Export Data** / **Import Data**
  (top-right) to back up or move data between machines — this is now built in.
