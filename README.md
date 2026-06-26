# Lookout — S.54 Bumping Tracker

A simple, **local-only, offline** web app to manage employee bumping scenarios
(Section 54 layoffs) for a unionized organization. It tracks individual bumping
cases and **automatically builds the domino chain** when one employee bumps
another (A → B → C → D).

Built for a single HR / Labour Relations user. No login, no server, no internet
required. Data is stored in your browser's `localStorage`.

---

## How to run

**Option A — just open the file (simplest)**

1. Download/clone this folder.
2. Double-click `index.html` to open it in any modern browser (Chrome, Edge, Firefox).
3. Done. It works fully offline.

**Option B — local dev server** (only if your browser blocks `file://` features)

```bash
# from inside this folder, pick one:
python3 -m http.server 8000
#   then visit http://localhost:8000
```

> Your data lives in the browser on the machine you use it on. Using the same
> browser on the same computer keeps your cases between sessions. Clearing
> browser data will erase them.

---

## Quick start

1. **Upload Seniority List** (top-right) → choose a `.csv` file. This powers
   auto-fill and suggestions. (Excel users: *Save As → CSV* first.)
2. Click **+ Add Case**. Start typing a name — pick from the seniority list and
   Site / Position / Seniority Hours auto-fill.
3. In **Bumps Into**, type the employee this person displaces. On save, the app
   **automatically creates that person's case** and links them in the chain.
4. Watch the chain build under the **Domino Chains** tab.
5. The **Dashboard** flags overdue decisions, upcoming deadlines, and missing info.

A sample file, `sample-seniority.csv`, is included so you can try it immediately.

---

## Core concepts

- **7-Day Decision Deadline** is auto-calculated as *S.54 Notice Date + 7 days*.
- **Auto chain creation:** setting *Bumps Into* creates the next case and links it.
  The bumping employee is marked *Completed*; the bumped employee becomes
  *Decision Required*.
- **Validation is non-blocking:** missing required fields are highlighted and
  flagged everywhere, but you can always save (warnings, never blocks).

### Statuses
`Pending` → `Decision Required` → `Completed` / `Laid Off`

---

## Project structure

| File                   | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `index.html`           | Page shell: header, tabs, modal container.                     |
| `styles.css`           | All styling (dark-blue / teal palette).                        |
| `app.js`               | All logic: storage, chain creation, views, form, CSV import.   |
| `sample-seniority.csv` | Example seniority file to test the upload + auto-fill.         |

`app.js` is organized top-to-bottom in clearly commented sections:
**CONFIG → STORAGE → helpers → CSV parser → views → form → save/chain logic → events → bootstrap.**

---

## Where to change things later

Everything you'd normally want to tweak is near the top of `app.js`:

- **Decision window length / upcoming-deadline window** — `CONFIG.DECISION_WINDOW_DAYS`, `CONFIG.UPCOMING_DEADLINE_DAYS`.
- **Status options** — `CONFIG.STATUSES`.
- **Which fields are required (flagged when missing)** — `CONFIG.REQUIRED_FIELDS`.
- **Add / rename a case field** — add it to `newCase()`, give it a label in
  `FIELD_LABELS`, and add an input to `buildFormHTML()` + a line in `readForm()`.
- **How CSV columns are recognized** — `SENIORITY_COLUMNS` (each field lists the
  header names it will match, case-insensitive).
- **Colors / look & feel** — CSS variables at the top of `styles.css` (`:root`).
- **Lookout logo** — replace the `.logo-placeholder` element in `index.html`
  with an `<img src="logo.png">`.

---

## Notes & limits

- Excel `.xlsx` is **not** parsed directly (keeps the app dependency-free). Save
  as `.csv` first — basic and reliable.
- Data is per-browser. To move data between machines, you'd export/import
  `localStorage` (not built in — kept intentionally simple).
