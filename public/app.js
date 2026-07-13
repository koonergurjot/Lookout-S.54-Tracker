/* ============================================================
   Lookout S.54 Bumping Tracker
   Local-only, offline, dependency-free vanilla JS app.

   Data lives in the browser's localStorage. Collections:
     - cases:        the bumping cases (the core data)
     - seniority:    the uploaded seniority list (lookup source)
     - seniorityMeta:when/what was uploaded (defensibility)
     - audit:        immutable change log (who/what/when)

   ── WHERE TO MODIFY THINGS LATER ───────────────────────────
   • CONFIG below       → decision/secondary windows, statuses, required &
                          critical fields, status gates, enforcement toggle
   • newCase() below    → add/remove/rename fields on a bumping case
   • COLUMN_MATCHERS    → how seniority xlsx/csv columns are matched
   ============================================================ */

/* ---------------- CONFIG ---------------- */
const CONFIG = {
  DECISION_WINDOW_DAYS: 7,        // 7-day decision deadline (from S.54 notice)
  UPCOMING_DEADLINE_DAYS: 3,      // "upcoming" window for the dashboard
  // Secondary statutory/contractual timeline (e.g. recall / bumping-rights
  // window). Rename/retune to match your collective agreement.
  SECONDARY_WINDOW: { days: 60, label: '60-Day Bumping/Recall Deadline', short: '60-day' },
  STATUSES: ['Pending', 'Decision Required', 'Completed', 'Laid Off'],

  // Fields flagged (warned) when missing — "complete" definition.
  REQUIRED_FIELDS: ['name', 'site', 'position', 'seniorityHours', 'noticeDate', 'effectiveDate'],

  // ENFORCEMENT — critical fields that BLOCK saving when missing.
  // Set ENFORCE_CRITICAL=false to fall back to warn-only behaviour.
  ENFORCE_CRITICAL: true,
  CRITICAL_FIELDS: ['name', 'noticeDate', 'effectiveDate'],

  // STATUS GATES — data required before a case may ENTER each status.
  // A case can always sit in "Pending" as a draft. Advancing is gated.
  STATUS_GATES: {
    'Decision Required': ['noticeDate'],                       // need a deadline to act against
    'Completed':         ['decisionMade', 'resolution', 'leaveOk'], // a real, recorded outcome
    'Laid Off':          ['decisionMade', 'leaveOk'],          // an accepted-layoff decision
  },
};

// Default factory for a new case. Add new fields here + in the form builder.
function newCase(overrides = {}) {
  const now = new Date().toISOString();
  return Object.assign({
    id: 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: '',
    site: '',
    position: '',
    seniorityHours: '',
    noticeDate: '',          // S.54 Notice Date (decision window start)
    effectiveDate: '',
    onLeave: false,          // is this staff member currently on a leave of absence?
    leaveReturnDate: '',     // expected return-to-work date, if onLeave
    leaveType: '',           // optional: Medical / Parental / WCB / etc.
    decisionMade: false,
    decisionMadeAt: '',      // timestamp when decision was recorded (defensibility)
    optionChosen: '',
    bumpsIntoId: '',         // reference to another case's id
    status: 'Pending',
    notes: '',
    // ---- defensibility / audit fields ----
    seniaritySnapshot: null, // frozen seniority record at decision time
    createdAt: now,
    updatedAt: now,
  }, overrides);
}

/* ---------------- STORAGE ---------------- */
const Store = {
  cases: [],
  seniority: [],
  seniorityMeta: null,       // { uploadedAt, filename, count }
  audit: [],                 // immutable change log
  load() {
    try { this.cases = JSON.parse(localStorage.getItem('s54_cases')) || []; } catch { this.cases = []; }
    try { this.seniority = JSON.parse(localStorage.getItem('s54_seniority')) || []; } catch { this.seniority = []; }
    try { this.seniorityMeta = JSON.parse(localStorage.getItem('s54_seniorityMeta')) || null; } catch { this.seniorityMeta = null; }
    try { this.audit = JSON.parse(localStorage.getItem('s54_audit')) || []; } catch { this.audit = []; }
  },
  saveCases() { localStorage.setItem('s54_cases', JSON.stringify(this.cases)); },
  saveSeniority() {
    localStorage.setItem('s54_seniority', JSON.stringify(this.seniority));
    localStorage.setItem('s54_seniorityMeta', JSON.stringify(this.seniorityMeta));
  },
  saveAudit() { localStorage.setItem('s54_audit', JSON.stringify(this.audit)); },
  getCase(id) { return this.cases.find(c => c.id === id); },
};

/* ============================================================
   AUDIT LOG  (defensibility: who / what / when)
   Single user, so "who" is recorded as the local operator.
   ============================================================ */
const OPERATOR = 'HR/LR User';  // single-user system; label on every audit row.

function recordAudit(action, caseObj, changes, details) {
  Store.audit.push({
    id: 'A' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    at: new Date().toISOString(),
    by: OPERATOR,
    action,                                   // 'create' | 'update' | 'delete' | 'chain-create' | 'seniority-upload' | 'seniority-clear'
    caseId: caseObj ? caseObj.id : '',
    caseName: caseObj ? caseObj.name : '',
    changes: changes || [],                   // [{ field, from, to }]
    details: details || '',
  });
  Store.saveAudit();
}

// Diff two case snapshots → list of {field, from, to} for audited fields.
const AUDITED_FIELDS = ['name', 'site', 'position', 'seniorityHours', 'noticeDate',
  'effectiveDate', 'onLeave', 'leaveReturnDate', 'leaveType',
  'decisionMade', 'optionChosen', 'bumpsIntoId', 'status', 'notes'];
function diffCase(before, after) {
  const changes = [];
  for (const f of AUDITED_FIELDS) {
    const a = before ? before[f] : '';
    const b = after[f];
    if (String(a ?? '') !== String(b ?? '')) {
      changes.push({
        field: f,
        from: f === 'bumpsIntoId' ? caseName(a) : a,
        to:   f === 'bumpsIntoId' ? caseName(b) : b,
      });
    }
  }
  return changes;
}
function caseName(id) { const c = id ? Store.getCase(id) : null; return c ? c.name : (id ? '(unknown)' : ''); }

/* ---------------- DATE / VALIDATION HELPERS ---------------- */
function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function decisionDeadline(c) {
  // Decision window starts at the S.54 Notice Date.
  return addDays(c.noticeDate, CONFIG.DECISION_WINDOW_DAYS);
}
function secondaryDeadline(c) {
  // Secondary (e.g. 60-day) window, also measured from the S.54 Notice Date.
  return addDays(c.noticeDate, CONFIG.SECONDARY_WINDOW.days);
}
function today() { return new Date().toISOString().slice(0, 10); }
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(today() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function missingFields(c) {
  return CONFIG.REQUIRED_FIELDS.filter(f => c[f] === '' || c[f] === null || c[f] === undefined);
}
function isOverdue(c) {
  if (c.decisionMade || c.status === 'Completed' || c.status === 'Laid Off') return false;
  const d = daysUntil(decisionDeadline(c));
  return d !== null && d < 0;
}
function isActive(c) { return c.status !== 'Completed' && c.status !== 'Laid Off'; }

// True if the Effective Date is set earlier than the staff member's recorded
// return-from-leave date — i.e. the bump/layoff would take effect while
// they're still away. The effective date should instead be set to (or after)
// the return date.
function leaveConflict(c) {
  return !!(c.onLeave && c.leaveReturnDate && c.effectiveDate && c.effectiveDate < c.leaveReturnDate);
}

/* ---------------- ENFORCEMENT: status gates & critical fields ---------------- */
// A case "has a recorded resolution" if it bumps someone OR an option is chosen.
function hasResolution(c) { return !!(c.bumpsIntoId || (c.optionChosen && c.optionChosen.trim())); }

// Evaluate one gate requirement against a case. Supports virtual predicates.
function gateMet(c, req) {
  if (req === 'decisionMade') return !!c.decisionMade;
  if (req === 'resolution')   return hasResolution(c);
  if (req === 'leaveOk')      return !leaveConflict(c);
  return c[req] !== '' && c[req] !== null && c[req] !== undefined;
}
function gateLabel(req) {
  if (req === 'resolution') return 'a recorded outcome (Bumps Into or Option Chosen)';
  if (req === 'decisionMade') return '“Decision made” checked';
  if (req === 'leaveOk') return "an Effective Date on/after the staff member's return from leave";
  return fieldLabel(req);
}
// Returns [] if the target status is allowed, else the list of missing requirements.
function statusGateMissing(c, status) {
  const reqs = CONFIG.STATUS_GATES[status] || [];
  return reqs.filter(r => !gateMet(c, r));
}
// Hard-required critical fields that block saving entirely.
function criticalMissing(c) {
  if (!CONFIG.ENFORCE_CRITICAL) return [];
  const missing = CONFIG.CRITICAL_FIELDS.filter(f => c[f] === '' || c[f] === null || c[f] === undefined);
  // Checking "on leave" without a return date makes the effective-date check
  // impossible to defend, so treat the return date as critical in that case.
  if (c.onLeave && !c.leaveReturnDate) missing.push('leaveReturnDate');
  return missing;
}

/* ---------------- SENIORITY SNAPSHOT (defensibility) ---------------- */
// Freeze the seniority record for this person at this moment, with the
// provenance of the list it came from. This is what existed "at the time".
function captureSnapshot(name) {
  const person = Store.seniority.find(p => p.name.toLowerCase() === (name || '').toLowerCase());
  if (!person) return null;
  return {
    name: person.name,
    site: person.site,
    position: person.position,
    seniorityHours: person.seniorityHours,
    capturedAt: new Date().toISOString(),
    listUploadedAt: Store.seniorityMeta ? Store.seniorityMeta.uploadedAt : null,
    listFilename: Store.seniorityMeta ? Store.seniorityMeta.filename : null,
  };
}

/* Collect all warnings for a case (non-blocking flags shown in the UI). */
function caseWarnings(c) {
  const w = [];
  const miss = missingFields(c);
  if (miss.length) w.push(`Missing: ${miss.map(fieldLabel).join(', ')}`);
  if (c.seniorityHours === '' || c.seniorityHours === null || c.seniorityHours === undefined)
    w.push('Seniority data missing');
  if (isOverdue(c)) w.push('Decision overdue (7-day)');
  // Secondary (60-day) window overdue.
  if (isActive(c)) {
    const sd = daysUntil(secondaryDeadline(c));
    if (sd !== null && sd < 0) w.push(`${CONFIG.SECONDARY_WINDOW.short} window overdue`);
  }
  if (c.status === 'Decision Required' && !c.decisionMade && !hasResolution(c))
    w.push('Awaiting decision');
  // On-leave: flag missing return date, or an effective date that lands before it.
  if (c.onLeave) {
    if (!c.leaveReturnDate) w.push('On leave — return date not recorded');
    else if (leaveConflict(c)) w.push(`Effective Date is before return from leave (returns ${fmtDate(c.leaveReturnDate)})`);
  }
  // Defensibility: no frozen seniority snapshot backing this case.
  if (!c.seniaritySnapshot) w.push('No seniority snapshot on record');
  // Incomplete chain: a person was bumped but their own next move isn't resolved.
  if (c.bumpsIntoId) {
    const next = Store.getCase(c.bumpsIntoId);
    if (next && isActive(next) && !next.bumpsIntoId && next.status !== 'Laid Off' && !next.decisionMade)
      w.push('Chain continues — next case undecided');
  }
  return w;
}

/* ---------------- FIELD LABELS ---------------- */
const FIELD_LABELS = {
  name: 'Name', site: 'Site', position: 'Position', seniorityHours: 'Seniority Hours',
  noticeDate: 'S.54 Notice Date', effectiveDate: 'Effective Date',
  onLeave: 'On Leave', leaveReturnDate: 'Expected Return Date', leaveType: 'Leave Type',
  decisionMade: 'Decision Made', decisionMadeAt: 'Decision Timestamp',
  optionChosen: 'Option Chosen', bumpsIntoId: 'Bumps Into', status: 'Status', notes: 'Notes',
};
function fieldLabel(f) { return FIELD_LABELS[f] || f; }

/* ============================================================
   CSV PARSER  (handles quoted fields & commas inside quotes)
   ============================================================ */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* ignore */ }
      else { field += ch; }
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/* ============================================================
   COLUMN MATCHING  — maps a header cell to one of our fields.
   Real Lookout reports vary ("Last, First" / "Last, First Name",
   "Job class", "Location", "Total Seniority" / "Total SEN CV+SAP May")
   and put the header several rows down under report titles. Each matcher
   tests a normalized (lowercased/trimmed) header cell.
   Tune these to recognize new column names later.
   ============================================================ */
const COLUMN_MATCHERS = {
  name:           h => h.includes('last, first') || h.includes('last,first') || h.includes('employee name') || h.includes('full name') || h === 'name' || h === 'employee',
  position:       h => h.includes('job class') || h.includes('position') || h.includes('classification') || h.includes('title') || h === 'job' || h === 'role',
  site:           h => h.includes('location') || h.includes('site') || h.includes('facility') || h.includes('department') || h === 'dept',
  seniorityHours: h => h.includes('total sen') || h.includes('seniority') || (h.includes('total') && h.includes('sen')) || h === 'hours' || h.includes('total hours'),
};
const norm = s => String(s ?? '').trim().toLowerCase();

// Score a row by how many of our fields its cells match → used to find the header.
function headerScore(row) {
  const matched = new Set();
  row.forEach(cell => {
    const h = norm(cell);
    if (!h) return;
    for (const field in COLUMN_MATCHERS) if (COLUMN_MATCHERS[field](h)) matched.add(field);
  });
  return matched;
}

/* Turn a raw 2D grid (from CSV or XLSX) into a seniority list.
   Auto-detects the header row (title/blank rows above are skipped). */
function rowsToSeniority(rows) {
  if (!rows || !rows.length) throw new Error('The file appears to be empty.');

  // Find the best header row in the first 25 rows: most fields matched,
  // and it MUST locate at least a name and a seniority column.
  let headerRow = -1, best = 0;
  const scan = Math.min(rows.length, 25);
  for (let r = 0; r < scan; r++) {
    const m = headerScore(rows[r]);
    if (m.has('name') && m.has('seniorityHours') && m.size > best) { best = m.size; headerRow = r; }
  }
  if (headerRow === -1)
    throw new Error('Could not find the header row.\nExpected columns like "Last, First", "Job class", "Location" and "Total Seniority".');

  // Map each field to a column index from the chosen header row.
  const headers = rows[headerRow];
  const idx = { name: -1, position: -1, site: -1, seniorityHours: -1 };
  headers.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    for (const field in COLUMN_MATCHERS) {
      if (idx[field] === -1 && COLUMN_MATCHERS[field](h)) idx[field] = i;
    }
  });

  const list = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cols = rows[r];
    const name = (cols[idx.name] || '').toString().trim();
    if (!name) continue;                              // require a name; skips blanks/footers
    if (/^(total|grand total)\b/i.test(name)) continue;
    list.push({
      name,
      site: idx.site > -1 ? (cols[idx.site] || '').toString().trim() : '',
      position: idx.position > -1 ? (cols[idx.position] || '').toString().trim() : '',
      seniorityHours: cleanHours(idx.seniorityHours > -1 ? cols[idx.seniorityHours] : ''),
    });
  }
  if (!list.length) throw new Error('Found the header but no employee rows below it.');
  return list;
}

// Normalize a seniority value: strip commas/spaces, round float noise to 2dp.
function cleanHours(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(/[, ]/g, ''));
  if (!isFinite(n)) return String(v).trim();
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// CSV entry point (kept for compatibility): parse → map.
function importSeniorityCSV(text) { return rowsToSeniority(parseCSV(text)); }

/* Route an uploaded File to the right parser by extension/signature → list. */
async function parseSeniorityFile(file) {
  const isXlsx = /\.xlsx$/i.test(file.name) ||
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (isXlsx) {
    if (typeof DecompressionStream === 'undefined')
      throw new Error('This browser cannot read .xlsx (no DecompressionStream). Please use a current Chrome/Edge/Firefox, or save the file as .csv.');
    const buf = await file.arrayBuffer();
    return rowsToSeniority(await parseXLSX(buf));
  }
  if (/\.xls$/i.test(file.name)) throw new Error('Legacy .xls is not supported — save it as .xlsx or .csv.');
  return rowsToSeniority(parseCSV(await file.text()));
}

/* ============================================================
   XLSX READER  — dependency-free, offline.
   An .xlsx is a ZIP of XML. We unzip with the browser's built-in
   DecompressionStream and read the cells with DOMParser. No libraries.
   Returns the first worksheet as a 2D array of strings.
   ============================================================ */
async function parseXLSX(arrayBuffer) {
  const files = await unzip(new Uint8Array(arrayBuffer));
  const dec = new TextDecoder('utf-8');
  const getText = path => (files[path] ? dec.decode(files[path]) : '');

  const shared = parseSharedStrings(getText('xl/sharedStrings.xml'));
  const sheetPath = firstSheetPath(files, getText);
  const sheetXml = getText(sheetPath);
  if (!sheetXml) throw new Error('Could not read the worksheet inside the .xlsx file.');
  return parseSheetXml(sheetXml, shared);
}

// Locate the first worksheet's XML path via the workbook relationships.
function firstSheetPath(files, getText) {
  try {
    const wb = new DOMParser().parseFromString(getText('xl/workbook.xml'), 'application/xml');
    const sheet = [...wb.getElementsByTagName('*')].find(e => e.localName === 'sheet');
    const rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttribute('id'));
    if (rid) {
      const rels = new DOMParser().parseFromString(getText('xl/_rels/workbook.xml.rels'), 'application/xml');
      const rel = [...rels.getElementsByTagName('*')].find(e => e.localName === 'Relationship' && e.getAttribute('Id') === rid);
      let target = rel && rel.getAttribute('Target');
      if (target) { target = target.replace(/^\/?xl\//, '').replace(/^\//, ''); return 'xl/' + target.replace(/^xl\//, ''); }
    }
  } catch { /* fall through */ }
  // Fallback: first worksheet file present.
  const key = Object.keys(files).find(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
  if (!key) throw new Error('No worksheet found inside the .xlsx file.');
  return key;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagName('*')].filter(e => e.localName === 'si').map(si => {
    // Concatenate every <t> within the shared-string item (handles rich-text runs).
    return [...si.getElementsByTagName('*')].filter(e => e.localName === 't').map(t => t.textContent).join('');
  });
}

function parseSheetXml(xml, shared) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rowsEls = [...doc.getElementsByTagName('*')].filter(e => e.localName === 'row');
  const grid = [];
  let maxCol = 0;
  for (const rowEl of rowsEls) {
    const cells = [...rowEl.children].filter(e => e.localName === 'c');
    const arr = [];
    for (const c of cells) {
      const ref = c.getAttribute('r') || '';
      const col = colIndex(ref);
      const t = c.getAttribute('t');
      let value = '';
      if (t === 'inlineStr') {
        const is = [...c.getElementsByTagName('*')].filter(e => e.localName === 't').map(e => e.textContent).join('');
        value = is;
      } else {
        const vEl = [...c.children].find(e => e.localName === 'v');
        const raw = vEl ? vEl.textContent : '';
        if (t === 's') value = shared[parseInt(raw, 10)] ?? '';
        else value = raw;          // number, boolean, or general
      }
      const i = col >= 0 ? col : arr.length;
      arr[i] = value;
      if (i + 1 > maxCol) maxCol = i + 1;
    }
    for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = '';
    grid.push(arr);
  }
  // Pad ragged rows so column indexes line up.
  return grid.map(r => { for (let i = 0; i < maxCol; i++) if (r[i] === undefined) r[i] = ''; return r; });
}

// "B5" → 1 (zero-based column index); ignores the row number.
function colIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ---- Minimal ZIP reader (central directory + DecompressionStream) ---- */
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find End Of Central Directory record (scan back from the end).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .xlsx (ZIP) file.');
  const cdCount = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);   // central directory offset

  const out = {};
  for (let n = 0; n < cdCount; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method   = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen  = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen   = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // Read the local header to find where the data actually starts.
    const lNameLen  = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    // Only decode the parts we need (XML); skip others lazily? We decode all small.
    if (/\.(xml|rels)$/i.test(name)) {
      out[name] = method === 0 ? comp.slice() : await inflateRaw(comp);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/* ============================================================
   APP STATE & ROUTER
   ============================================================ */
const App = { view: 'dashboard', search: '' };

function setView(v) {
  App.view = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  render();
}

function render() {
  const main = document.getElementById('main');
  if (App.view === 'dashboard') main.innerHTML = renderDashboard();
  else if (App.view === 'cases') main.innerHTML = renderCases();
  else if (App.view === 'chains') main.innerHTML = renderChains();
  else if (App.view === 'seniority') main.innerHTML = renderSeniority();
  else if (App.view === 'audit') main.innerHTML = renderAudit();
  wireViewEvents();
}

/* ---------------- DASHBOARD ---------------- */
function renderDashboard() {
  const cases = Store.cases;
  const active = cases.filter(isActive);
  const missing = cases.filter(c => missingFields(c).length > 0);
  const overdue = cases.filter(isOverdue);
  const overdue60 = cases.filter(c => {
    if (!isActive(c)) return false;
    const d = daysUntil(secondaryDeadline(c));
    return d !== null && d < 0;
  });
  const upcoming = cases.filter(c => {
    if (!isActive(c)) return false;
    const d = daysUntil(decisionDeadline(c));
    return d !== null && d >= 0 && d <= CONFIG.UPCOMING_DEADLINE_DAYS;
  });
  const noSnapshot = cases.filter(c => !c.seniaritySnapshot);
  const onLeave = cases.filter(c => isActive(c) && c.onLeave);
  const leaveConflicts = onLeave.filter(leaveConflict);

  const listRows = (arr, label, which) => arr.length
    ? `<table class="case-table"><thead><tr><th>Name</th><th>Position</th><th>Deadline</th><th>Status</th></tr></thead><tbody>
        ${arr.map(c => `<tr class="row-click" data-edit="${c.id}">
          <td>${esc(c.name) || '<span class="muted">Unnamed</span>'}</td>
          <td>${esc(c.position) || '—'}</td>
          <td>${fmtDate(which === '60' ? secondaryDeadline(c) : decisionDeadline(c))} ${deadlineFlag(c, which)}</td>
          <td>${statusBadge(c.status)}</td></tr>`).join('')}
      </tbody></table>`
    : `<div class="empty-state">No ${label}.</div>`;

  const leaveRows = onLeave.length
    ? `<table class="case-table"><thead><tr><th>Name</th><th>Position</th><th>Return Date</th><th>Effective Date</th><th>Status</th></tr></thead><tbody>
        ${onLeave.map(c => `<tr class="row-click" data-edit="${c.id}">
          <td>${esc(c.name) || '<span class="muted">Unnamed</span>'}</td>
          <td>${esc(c.position) || '—'}</td>
          <td>${c.leaveReturnDate ? fmtDate(c.leaveReturnDate) : '<span class="flag">not recorded</span>'}</td>
          <td>${c.effectiveDate ? fmtDate(c.effectiveDate) : '—'} ${leaveConflict(c) ? '<span class="flag">before return</span>' : ''}</td>
          <td>${statusBadge(c.status)}</td></tr>`).join('')}
      </tbody></table>`
    : `<div class="empty-state">No staff currently marked on leave.</div>`;

  const seniorityBanner = Store.seniorityMeta
    ? `<div class="dash-section"><div class="form-warning" style="background:var(--ok-bg);color:var(--ok);border-color:#bfe3cd;">
        ✔ Seniority list on record: <strong>${esc(Store.seniorityMeta.filename || 'uploaded file')}</strong>
        — ${Store.seniorityMeta.count} employees, loaded ${fmtDateTime(Store.seniorityMeta.uploadedAt)}.</div></div>`
    : `<div class="dash-section"><div class="form-warning">⚠️ No seniority list loaded — decisions cannot be backed by a current list. Upload one for defensibility.</div></div>`;

  return `
    <div class="cards">
      <div class="card"><div class="num">${active.length}</div><div class="label">Total Active Cases</div></div>
      <div class="card ${missing.length ? 'warn' : 'ok'}"><div class="num">${missing.length}</div><div class="label">Cases Missing Info</div></div>
      <div class="card ${overdue.length ? 'alert' : 'ok'}"><div class="num">${overdue.length}</div><div class="label">Overdue Decisions (7-day)</div></div>
      <div class="card ${overdue60.length ? 'alert' : 'ok'}"><div class="num">${overdue60.length}</div><div class="label">Overdue (${CONFIG.SECONDARY_WINDOW.short})</div></div>
      <div class="card ${upcoming.length ? 'warn' : 'ok'}"><div class="num">${upcoming.length}</div><div class="label">Upcoming Deadlines (≤${CONFIG.UPCOMING_DEADLINE_DAYS}d)</div></div>
      <div class="card ${noSnapshot.length ? 'warn' : 'ok'}"><div class="num">${noSnapshot.length}</div><div class="label">No Seniority Snapshot</div></div>
      <div class="card ${leaveConflicts.length ? 'alert' : (onLeave.length ? 'warn' : 'ok')}"><div class="num">${onLeave.length}</div><div class="label">Staff On Leave</div></div>
    </div>

    ${seniorityBanner}
    <div class="dash-section"><h3>⚠️ Overdue Decisions (7-day)</h3>${listRows(overdue, 'overdue decisions', '7')}</div>
    <div class="dash-section"><h3>⏰ Overdue ${esc(CONFIG.SECONDARY_WINDOW.label)}</h3>${listRows(overdue60, 'overdue ' + CONFIG.SECONDARY_WINDOW.short + ' cases', '60')}</div>
    <div class="dash-section"><h3>⏳ Upcoming Deadlines</h3>${listRows(upcoming, 'upcoming deadlines', '7')}</div>
    <div class="dash-section"><h3>🏖️ Staff On Leave</h3>${leaveRows}</div>
    <div class="dash-section"><h3>📋 Cases Missing Information</h3>${listRows(missing, 'cases missing info', '7')}</div>
  `;
}

function deadlineFlag(c, which) {
  if (c.status === 'Completed' || c.status === 'Laid Off') return '';
  if (which === '60') {
    const d = daysUntil(secondaryDeadline(c));
    if (d === null) return '';
    if (d < 0) return `<span class="flag">${Math.abs(d)}d overdue</span>`;
    if (d <= CONFIG.UPCOMING_DEADLINE_DAYS) return `<span class="flag flag-warn">in ${d}d</span>`;
    return '';
  }
  if (c.decisionMade) return '';
  const d = daysUntil(decisionDeadline(c));
  if (d === null) return '';
  if (d < 0) return `<span class="flag">${Math.abs(d)}d overdue</span>`;
  if (d <= CONFIG.UPCOMING_DEADLINE_DAYS) return `<span class="flag flag-warn">in ${d}d</span>`;
  return '';
}

/* ---------------- CASES LIST ---------------- */
function renderCases() {
  const q = App.search.toLowerCase();
  const list = Store.cases.filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.position.toLowerCase().includes(q) || c.site.toLowerCase().includes(q)
  );

  const body = list.length ? list.map(c => {
    const warns = caseWarnings(c);
    const next = c.bumpsIntoId ? Store.getCase(c.bumpsIntoId) : null;
    return `<tr class="row-click" data-edit="${c.id}">
      <td><strong>${esc(c.name) || '<span class="muted">Unnamed</span>'}</strong>${c.onLeave ? `<span class="flag flag-warn" title="On leave${c.leaveReturnDate ? ' — returns ' + esc(fmtDate(c.leaveReturnDate)) : ''}">🏖 Leave</span>` : ''}${warns.length ? `<span class="flag" title="${esc(warns.join(' • '))}">${warns.length} ⚠</span>` : ''}<br><span class="muted">${esc(c.site)}</span></td>
      <td>${esc(c.position) || '—'}</td>
      <td>${c.seniorityHours !== '' ? esc(c.seniorityHours) : '<span class="flag">missing</span>'}</td>
      <td>${fmtDate(decisionDeadline(c))} ${deadlineFlag(c)}</td>
      <td>${next ? `→ ${esc(next.name) || 'case'}` : '<span class="muted">—</span>'}</td>
      <td>${statusBadge(c.status)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="6"><div class="empty-state">No cases yet. Click <strong>+ Add Case</strong> to begin.</div></td></tr>`;

  return `
    <div class="toolbar">
      <input type="search" id="caseSearch" placeholder="Search name, position, site…" value="${esc(App.search)}" />
      <span class="muted">${list.length} case${list.length === 1 ? '' : 's'}</span>
    </div>
    <table class="case-table">
      <thead><tr><th>Name / Site</th><th>Position</th><th>Sen. Hours</th><th>Decision Deadline</th><th>Bumps Into</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/* ---------------- CHAINS (visual domino) ---------------- */
function renderChains() {
  // A chain starts at a case nobody bumps into ("root").
  const bumpedInto = new Set(Store.cases.map(c => c.bumpsIntoId).filter(Boolean));
  const roots = Store.cases.filter(c => !bumpedInto.has(c.id));

  if (!Store.cases.length)
    return `<div class="empty-state">No cases yet. Chains appear automatically as you record who bumps whom.</div>`;

  const chains = roots.map(root => {
    const nodes = [];
    let cur = root, guard = 0;
    const seen = new Set();
    while (cur && guard++ < 200 && !seen.has(cur.id)) {
      seen.add(cur.id);
      nodes.push(cur);
      cur = cur.bumpsIntoId ? Store.getCase(cur.bumpsIntoId) : null;
    }
    return nodes;
  });

  // Only show chains with at least one link, plus a note for standalone cases.
  const multi = chains.filter(n => n.length > 1);
  const singles = chains.filter(n => n.length === 1);

  let html = '';
  if (multi.length) {
    html += multi.map(nodes => `<div class="chain"><div class="chain-flow">
      ${nodes.map((c, i) => chainNode(c, i === nodes.length - 1) + (i < nodes.length - 1 ? '<div class="chain-arrow">→</div>' : '')).join('')}
    </div></div>`).join('');
  } else {
    html += `<div class="empty-state">No multi-step chains yet. When a case records <em>“Bumps Into”</em>, the chain builds here automatically.</div>`;
  }

  if (singles.length) {
    html += `<div class="dash-section" style="margin-top:24px;"><h3>Standalone cases (no bump recorded)</h3>
      <div class="chain"><div class="chain-flow" style="flex-wrap:wrap;gap:12px;">
      ${singles.map(n => chainNode(n[0], true)).join('')}
      </div></div></div>`;
  }
  return html;
}

function chainNode(c, isLast) {
  const incomplete = isActive(c) && missingFields(c).length > 0;
  const tail = isLast && isActive(c) && !c.bumpsIntoId && c.status !== 'Laid Off'
    ? `<div class="flag flag-warn" style="margin-top:6px;">chain end — undecided</div>` : '';
  return `<div class="chain-node ${incomplete ? 'node-incomplete' : ''}" data-edit="${c.id}" style="cursor:pointer;">
    <div class="node-name">${esc(c.name) || 'Unnamed'}</div>
    <div class="node-pos">${esc(c.position) || '—'}<br>${esc(c.site) || ''}</div>
    ${statusBadge(c.status)}${tail}
  </div>`;
}

/* ---------------- SENIORITY VIEW ---------------- */
function renderSeniority() {
  if (!Store.seniority.length)
    return `<div class="empty-state">No seniority list loaded.<br><br>
      Click <strong>Upload Seniority List</strong> (top right) and choose an <strong>.xlsx</strong> or <strong>.csv</strong> file.<br>
      <span class="muted">Report titles above the header are skipped automatically. Columns are matched flexibly —
      e.g. “Last, First”/“Name”, “Job class”/“Position”, “Location”/“Site”, “Total Seniority”/“Total SEN…”/“Hours”.</span></div>`;

  const rows = Store.seniority.map(p => `<tr>
    <td>${esc(p.name)}</td><td>${esc(p.site)}</td><td>${esc(p.position)}</td><td>${esc(p.seniorityHours)}</td>
  </tr>`).join('');
  const meta = Store.seniorityMeta;
  const provenance = meta
    ? `<div class="form-warning" style="background:var(--ok-bg);color:var(--ok);border-color:#bfe3cd;">
        Source: <strong>${esc(meta.filename || 'uploaded file')}</strong> · ${meta.count} employees · loaded ${fmtDateTime(meta.uploadedAt)}.
        <br><span class="muted">Cases created/decided while this list is active capture a frozen snapshot for defensibility.</span></div>`
    : '';
  return `
    ${provenance}
    <div class="toolbar">
      <span class="muted">${Store.seniority.length} employees loaded</span>
      <button class="btn btn-ghost btn-sm" id="clearSeniority">Clear list</button>
    </div>
    <table class="case-table">
      <thead><tr><th>Name</th><th>Site</th><th>Position</th><th>Seniority Hours</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------------- AUDIT LOG VIEW ---------------- */
function renderAudit() {
  if (!Store.audit.length)
    return `<div class="empty-state">No audit entries yet.<br><br>
      <span class="muted">Every case creation, edit, decision, chain link, and seniority upload is recorded here with a timestamp — your defensible trail.</span></div>`;

  const actionLabel = {
    'create': 'Case created', 'update': 'Case updated', 'delete': 'Case deleted',
    'chain-create': 'Chain: case auto-created', 'seniority-upload': 'Seniority list uploaded',
    'seniority-clear': 'Seniority list cleared',
  };
  // Newest first.
  const rows = [...Store.audit].reverse().map(a => {
    const changeHtml = a.changes && a.changes.length
      ? `<ul class="audit-changes">${a.changes.map(ch =>
          `<li><strong>${esc(fieldLabel(ch.field))}</strong>: <span class="muted">${esc(displayVal(ch.field, ch.from)) || '∅'}</span> → ${esc(displayVal(ch.field, ch.to)) || '∅'}</li>`).join('')}</ul>`
      : '';
    const linkable = a.caseId && Store.getCase(a.caseId);
    return `<tr>
      <td style="white-space:nowrap;">${fmtDateTime(a.at)}</td>
      <td>${esc(a.by)}</td>
      <td><strong>${esc(actionLabel[a.action] || a.action)}</strong>${a.details ? `<br><span class="muted">${esc(a.details)}</span>` : ''}${changeHtml}</td>
      <td>${a.caseName ? (linkable ? `<span class="chain-link" data-edit="${a.caseId}">${esc(a.caseName)}</span>` : esc(a.caseName)) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="toolbar">
      <span class="muted">${Store.audit.length} entr${Store.audit.length === 1 ? 'y' : 'ies'} — newest first</span>
      <button class="btn btn-ghost btn-sm" id="exportAudit">Export CSV</button>
    </div>
    <table class="case-table">
      <thead><tr><th>When</th><th>By</th><th>Action</th><th>Case</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Friendly display of an audited value (dates/booleans).
function displayVal(field, v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if ((field === 'noticeDate' || field === 'effectiveDate' || field === 'leaveReturnDate') && v) return fmtDate(v);
  return v == null ? '' : String(v);
}

/* ---------------- SHARED RENDER HELPERS ---------------- */
function statusBadge(s) {
  const map = { 'Pending': 'badge-pending', 'Decision Required': 'badge-decision', 'Completed': 'badge-completed', 'Laid Off': 'badge-laidoff' };
  return `<span class="badge ${map[s] || 'badge-pending'}">${esc(s)}</span>`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ============================================================
   CASE FORM (modal)
   ============================================================ */
let editingId = null;
let pendingSnapshot = null;   // snapshot staged via the form's capture button

function openCaseForm(id) {
  editingId = id || null;
  const c = id ? Object.assign(newCase(), Store.getCase(id)) : newCase();
  document.getElementById('modalTitle').textContent = id ? 'Edit Bumping Case' : 'Add Bumping Case';
  document.getElementById('caseForm').innerHTML = buildFormHTML(c);
  document.getElementById('modalOverlay').hidden = false;
  wireFormEvents(c);
  updateComputed();
  const nameInput = document.getElementById('f_name');
  if (nameInput && !id) nameInput.focus();
}

function closeCaseForm() {
  document.getElementById('modalOverlay').hidden = true;
  editingId = null;
}

function buildFormHTML(c) {
  const statusOpts = CONFIG.STATUSES.map(s => `<option value="${s}" ${c.status === s ? 'selected' : ''}>${s}</option>`).join('');
  // Existing cases (excluding self) selectable as an already-created bump target.
  const caseOpts = Store.cases.filter(x => x.id !== c.id)
    .map(x => `<option value="${x.id}" ${c.bumpsIntoId === x.id ? 'selected' : ''}>${esc(x.name)} — ${esc(x.position)}</option>`).join('');

  return `
    <div class="form-warning" id="formWarning" hidden></div>

    <div class="form-row autocomplete">
      <label>Name <span class="req">*</span></label>
      <input type="text" id="f_name" value="${esc(c.name)}" autocomplete="off" placeholder="Start typing — suggestions from seniority list" />
      <div class="autocomplete-list" id="nameAuto" hidden></div>
      <div class="field-hint">Pick from the seniority list to auto-fill Site, Position &amp; Hours.</div>
    </div>

    <div class="form-row two">
      <div><label>Site <span class="req">*</span></label><input type="text" id="f_site" value="${esc(c.site)}" /></div>
      <div><label>Position <span class="req">*</span></label><input type="text" id="f_position" value="${esc(c.position)}" /></div>
    </div>

    <div class="form-row two">
      <div><label>Seniority Hours <span class="req">*</span></label><input type="number" step="any" id="f_seniorityHours" value="${esc(c.seniorityHours)}" /></div>
      <div><label>Status</label><select id="f_status">${statusOpts}</select>
        <div class="field-hint" id="gateHint"></div></div>
    </div>

    ${snapshotPanelHTML(c)}

    <div class="form-row two">
      <div><label>S.54 Notice Date <span class="req">*</span></label><input type="date" id="f_noticeDate" value="${esc(c.noticeDate)}" /></div>
      <div><label>Effective Date <span class="req">*</span></label><input type="date" id="f_effectiveDate" value="${esc(c.effectiveDate)}" /></div>
    </div>

    <div class="form-row checkbox-row">
      <input type="checkbox" id="f_onLeave" ${c.onLeave ? 'checked' : ''} />
      <label for="f_onLeave">Staff member is currently on a leave of absence</label>
    </div>
    <div class="form-row two" id="leaveFields" ${c.onLeave ? '' : 'hidden'}>
      <div><label>Expected Return Date <span class="req">*</span></label><input type="date" id="f_leaveReturnDate" value="${esc(c.leaveReturnDate)}" /></div>
      <div><label>Leave Type <span class="muted">(optional)</span></label><input type="text" id="f_leaveType" value="${esc(c.leaveType)}" placeholder="e.g. Medical, Parental, WCB" /></div>
    </div>
    <div class="form-warning" id="leaveWarning" hidden></div>

    <div class="form-row two">
      <div>
        <label>7-Day Decision Deadline (auto)</label>
        <input type="text" id="f_deadline" value="" readonly style="background:#f0f4f8;" />
        <div class="field-hint computed" id="deadlineHint"></div>
      </div>
      <div>
        <label>${esc(CONFIG.SECONDARY_WINDOW.label)} (auto)</label>
        <input type="text" id="f_deadline2" value="" readonly style="background:#f0f4f8;" />
        <div class="field-hint computed" id="deadline2Hint"></div>
      </div>
    </div>

    <div class="form-row checkbox-row">
      <input type="checkbox" id="f_decisionMade" ${c.decisionMade ? 'checked' : ''} />
      <label for="f_decisionMade">Decision made</label>
      ${c.decisionMade && c.decisionMadeAt ? `<span class="field-hint" style="margin:0 0 0 8px;">recorded ${esc(fmtDateTime(c.decisionMadeAt))}</span>` : ''}
    </div>

    <div class="form-row">
      <label>Option Chosen</label>
      <input type="text" id="f_optionChosen" value="${esc(c.optionChosen)}" placeholder="e.g. Bump junior employee / Accept layoff / Retire" />
    </div>

    <div class="form-row autocomplete">
      <label>Bumps Into <span class="muted">(creates the next case automatically)</span></label>
      <input type="text" id="f_bumpsInto" autocomplete="off" placeholder="Type a name from the seniority list…" value="${esc(c.bumpsIntoId && Store.getCase(c.bumpsIntoId) ? Store.getCase(c.bumpsIntoId).name : '')}" />
      <div class="autocomplete-list" id="bumpAuto" hidden></div>
      <input type="hidden" id="f_bumpsIntoId" value="${esc(c.bumpsIntoId)}" />
      ${caseOpts ? `<div class="field-hint">…or link an existing case:
        <select id="f_bumpExisting"><option value="">— none —</option>${caseOpts}</select></div>` : ''}
      <div class="field-hint">Selecting someone here records the domino: this person → that person.</div>
    </div>

    <div class="form-row">
      <label>Notes</label>
      <textarea id="f_notes" rows="2">${esc(c.notes)}</textarea>
    </div>

    ${editingId ? caseHistoryHTML(c.id) : ''}

    <div class="form-actions">
      <div>${editingId ? '<button type="button" class="btn btn-danger btn-sm" id="btnDelete">Delete</button>' : ''}</div>
      <div class="right">
        <button type="button" class="btn btn-ghost" id="btnCancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Case</button>
      </div>
    </div>
  `;
}

/* Seniority snapshot panel: shows the frozen record, or offers to capture one. */
function snapshotPanelHTML(c) {
  if (c.seniaritySnapshot) {
    const s = c.seniaritySnapshot;
    return `<div class="snapshot-panel ok">
      <div class="snapshot-title">📌 Seniority snapshot on record</div>
      <div class="snapshot-body">${esc(s.name)} — ${esc(s.position) || 'no position'}, ${esc(s.site) || 'no site'}, <strong>${esc(s.seniorityHours) || '—'}h</strong>
      <br><span class="muted">Captured ${esc(fmtDateTime(s.capturedAt))}${s.listUploadedAt ? ` · from list loaded ${esc(fmtDateTime(s.listUploadedAt))}` : ''}.</span></div>
      <button type="button" class="btn btn-ghost btn-sm" id="btnReSnapshot">Refresh from current list</button>
    </div>`;
  }
  const canCapture = Store.seniority.length > 0;
  return `<div class="snapshot-panel warn">
    <div class="snapshot-title">⚠️ No seniority snapshot</div>
    <div class="snapshot-body muted">A snapshot freezes this employee's seniority as it stands today — your defensible record of what the list showed at decision time. ${canCapture ? 'Click below (or pick the name from the list) to capture it.' : 'Upload a seniority list first to enable this.'}</div>
    ${canCapture ? `<button type="button" class="btn btn-ghost btn-sm" id="btnReSnapshot">Capture snapshot now</button>` : ''}
  </div>`;
}

/* Per-case audit history (read-only, inside the form). */
function caseHistoryHTML(caseId) {
  const entries = Store.audit.filter(a => a.caseId === caseId);
  if (!entries.length) return '';
  const items = [...entries].reverse().slice(0, 12).map(a => {
    const summary = a.changes && a.changes.length
      ? a.changes.map(ch => `${fieldLabel(ch.field)}: ${displayVal(ch.field, ch.from) || '∅'} → ${displayVal(ch.field, ch.to) || '∅'}`).join('; ')
      : (a.details || a.action);
    return `<li><span class="muted">${esc(fmtDateTime(a.at))}</span> — ${esc(summary)}</li>`;
  }).join('');
  return `<div class="form-row"><label>History (audit trail)</label>
    <ul class="case-history">${items}</ul></div>`;
}

/* Read the form into a case object. */
function readForm() {
  return {
    name: val('f_name').trim(),
    site: val('f_site').trim(),
    position: val('f_position').trim(),
    seniorityHours: val('f_seniorityHours').trim(),
    noticeDate: val('f_noticeDate'),
    effectiveDate: val('f_effectiveDate'),
    onLeave: document.getElementById('f_onLeave').checked,
    leaveReturnDate: val('f_leaveReturnDate'),
    leaveType: val('f_leaveType').trim(),
    decisionMade: document.getElementById('f_decisionMade').checked,
    optionChosen: val('f_optionChosen').trim(),
    bumpsIntoId: val('f_bumpsIntoId'),
    status: val('f_status'),
    notes: val('f_notes').trim(),
  };
}
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

function updateComputed() {
  const notice = val('f_noticeDate');
  // 7-day decision deadline.
  setDeadlineField('f_deadline', 'deadlineHint', addDays(notice, CONFIG.DECISION_WINDOW_DAYS));
  // Secondary (60-day) deadline.
  setDeadlineField('f_deadline2', 'deadline2Hint', addDays(notice, CONFIG.SECONDARY_WINDOW.days));
  updateLeaveWarning();
  updateGateHint();
}

/* Live feedback on the on-leave / return-date / effective-date relationship. */
function updateLeaveWarning() {
  const fields = document.getElementById('leaveFields');
  const warn = document.getElementById('leaveWarning');
  const onLeaveEl = document.getElementById('f_onLeave');
  if (!warn || !onLeaveEl) return;
  const onLeave = onLeaveEl.checked;
  if (fields) fields.hidden = !onLeave;
  if (!onLeave) { warn.hidden = true; return; }

  const returnDate = val('f_leaveReturnDate');
  const effDate = val('f_effectiveDate');
  if (!returnDate) {
    warn.hidden = false;
    warn.className = 'form-warning';
    warn.innerHTML = `⚠️ On leave — record an expected <strong>return date</strong> so the Effective Date can be checked against it.`;
    return;
  }
  if (effDate && effDate < returnDate) {
    warn.hidden = false;
    warn.className = 'form-warning form-error';
    warn.innerHTML = `⛔ Effective Date (${esc(fmtDate(effDate))}) is before this person's return from leave (${esc(fmtDate(returnDate))}).
      <button type="button" class="btn btn-ghost btn-sm" id="btnUseReturnDate">Use return date as Effective Date</button>`;
    return;
  }
  warn.hidden = true;
}

function setDeadlineField(inputId, hintId, dl) {
  const input = document.getElementById(inputId);
  const hint = document.getElementById(hintId);
  if (!input || !hint) return;
  if (dl) {
    input.value = fmtDate(dl);
    const d = daysUntil(dl);
    hint.textContent = d < 0 ? `Overdue by ${Math.abs(d)} day(s)` : `${d} day(s) remaining`;
    hint.style.color = d < 0 ? 'var(--danger)' : 'var(--teal-dark)';
  } else {
    input.value = 'Set the S.54 Notice Date →';
    hint.textContent = '';
  }
}

/* Project the form's effect on save: a typed/selected bump implies a recorded
   decision + outcome (handleBumpLink applies this). Used for gate evaluation. */
function projectedCase(data) {
  const p = Object.assign({}, data);
  const selId = val('f_bumpsIntoId');
  const typed = val('f_bumpsInto').trim();
  if ((selId && Store.getCase(selId)) || typed) { p.bumpsIntoId = selId || 'pending'; p.decisionMade = true; }
  return p;
}

/* Live feedback on whether the chosen status is allowed by its gate. */
function updateGateHint() {
  const hint = document.getElementById('gateHint');
  if (!hint) return;
  const provisional = projectedCase(readForm());
  const missing = statusGateMissing(provisional, provisional.status);
  if (missing.length) {
    hint.innerHTML = `🔒 To set <strong>${esc(provisional.status)}</strong>, first add: ${missing.map(gateLabel).join(', ')}.`;
    hint.style.color = 'var(--danger)';
  } else {
    hint.textContent = '';
  }
}

/* ============================================================
   SAVE + AUTO CHAIN CREATION  (the core feature)
   ============================================================ */
function saveCase(e) {
  e.preventDefault();
  const data = readForm();
  const warn = document.getElementById('formWarning');
  document.querySelectorAll('.case-form .invalid').forEach(el => el.classList.remove('invalid'));

  // ---- ENFORCEMENT 1: critical fields BLOCK the save ----
  const critical = criticalMissing(data);
  if (critical.length) {
    critical.forEach(f => { const el = document.getElementById('f_' + f); if (el) el.classList.add('invalid'); });
    warn.hidden = false;
    warn.className = 'form-warning form-error';
    warn.innerHTML = `⛔ Cannot save — these are required: <strong>${critical.map(fieldLabel).join(', ')}</strong>.`;
    return;
  }

  // ---- ENFORCEMENT 2: status gates BLOCK advancing without data ----
  // Gate against the PROJECTED state: a typed/selected bump will, on save,
  // set bumpsIntoId + decisionMade (see handleBumpLink), so count it now.
  const gateMissing = statusGateMissing(projectedCase(data), data.status);
  if (gateMissing.length) {
    const el = document.getElementById('f_status'); if (el) el.classList.add('invalid');
    warn.hidden = false;
    warn.className = 'form-warning form-error';
    warn.innerHTML = `🔒 Cannot set status <strong>${esc(data.status)}</strong> yet — first provide: ${gateMissing.map(gateLabel).join(', ')}.`;
    return;
  }

  // ---- Soft validation: warn (non-blocking) on remaining recommended fields ----
  const miss = CONFIG.REQUIRED_FIELDS.filter(f => data[f] === '' || data[f] === null);
  if (miss.length) {
    miss.forEach(f => { const el = document.getElementById('f_' + f); if (el) el.classList.add('invalid'); });
    warn.hidden = false;
    warn.className = 'form-warning';
    warn.innerHTML = `⚠️ Missing recommended fields: <strong>${miss.map(fieldLabel).join(', ')}</strong>. Saved anyway — please complete when possible.`;
  }

  // Snapshot taken in the form (if any) is carried on a stashed property.
  const stagedSnapshot = pendingSnapshot;

  let target, before = null, isNew = false;
  if (editingId) {
    target = Store.getCase(editingId);
    before = JSON.parse(JSON.stringify(target));   // pre-image for diff
    Object.assign(target, data);
  } else {
    isNew = true;
    target = newCase(data);
    Store.cases.push(target);
  }

  // Decision timestamp: stamp the moment "Decision made" first becomes true.
  if (target.decisionMade && !target.decisionMadeAt) target.decisionMadeAt = new Date().toISOString();
  if (!target.decisionMade) target.decisionMadeAt = '';

  // Seniority snapshot: explicit capture, else auto-capture if none yet & name matches.
  if (stagedSnapshot) target.seniaritySnapshot = stagedSnapshot;
  else if (!target.seniaritySnapshot) {
    const auto = captureSnapshot(target.name);
    if (auto) target.seniaritySnapshot = auto;
  }

  target.updatedAt = new Date().toISOString();

  // ---- AUTO CHAIN CREATION ----
  handleBumpLink(target);

  // ---- AUDIT ----
  if (isNew) {
    recordAudit('create', target, diffCase(null, target), 'Case created');
  } else {
    const changes = diffCase(before, target);
    if (changes.length) recordAudit('update', target, changes, '');
  }

  Store.saveCases();
  pendingSnapshot = null;
  closeCaseForm();
  render();
  toast(isNew ? 'Case added' : 'Case updated');
}

/* Ensure target.bumpsIntoId points at a real case, creating one if needed. */
function handleBumpLink(target) {
  const typedName = val('f_bumpsInto').trim();
  let bumpId = val('f_bumpsIntoId');

  // If a hidden id is already set (chosen from suggestions / existing case), trust it.
  if (bumpId && Store.getCase(bumpId)) {
    target.bumpsIntoId = bumpId;
  } else if (typedName) {
    // Try to match an existing case by name first (avoid duplicates).
    let bumped = Store.cases.find(c => c.id !== target.id && c.name.toLowerCase() === typedName.toLowerCase());
    if (!bumped) {
      // Auto-create a new case for the bumped employee, pre-filled from seniority list.
      const sen = Store.seniority.find(p => p.name.toLowerCase() === typedName.toLowerCase());
      bumped = newCase({
        name: typedName,
        site: sen ? sen.site : '',
        position: sen ? sen.position : '',
        seniorityHours: sen ? sen.seniorityHours : '',
        status: 'Decision Required',   // they now must decide
        seniaritySnapshot: captureSnapshot(typedName),  // freeze their seniority too
      });
      Store.cases.push(bumped);
      // Audit the automatic downstream case — closes the "missed person" gap.
      recordAudit('chain-create', bumped, diffCase(null, bumped),
        `Auto-created because ${target.name || 'a case'} bumps into ${bumped.name}`);
      toast(`Chain: created case for ${typedName}`);
    }
    target.bumpsIntoId = bumped.id;
  } else {
    target.bumpsIntoId = '';
  }

  // The bumping person has effectively made their move → mark sensibly.
  if (target.bumpsIntoId) {
    if (!target.decisionMade) { target.decisionMade = true; target.decisionMadeAt = new Date().toISOString(); }
    if (target.status === 'Pending' || target.status === 'Decision Required') target.status = 'Completed';
    if (!target.optionChosen) {
      const b = Store.getCase(target.bumpsIntoId);
      target.optionChosen = b ? `Bumps into ${b.name}` : target.optionChosen;
    }
  }
}

function deleteCase() {
  if (!editingId) return;
  if (!confirm('Delete this case? Any cases that bump into it will be unlinked.')) return;
  const victim = Store.getCase(editingId);
  const unlinked = [];
  Store.cases.forEach(c => { if (c.bumpsIntoId === editingId) { c.bumpsIntoId = ''; unlinked.push(c.name || 'a case'); } });
  Store.cases = Store.cases.filter(c => c.id !== editingId);
  recordAudit('delete', victim, [],
    `Case deleted${unlinked.length ? ' — unlinked from: ' + unlinked.join(', ') : ''}`);
  Store.saveCases();
  closeCaseForm();
  render();
  toast('Case deleted');
}

/* (Re)attach the snapshot capture button; re-runs after the panel re-renders. */
function wireSnapshotButton() {
  const btn = document.getElementById('btnReSnapshot');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const snap = captureSnapshot(val('f_name').trim());
    if (!snap) { alert('No matching name in the current seniority list — cannot capture a snapshot.'); return; }
    pendingSnapshot = snap;
    toast('Snapshot staged — saves with the case');
    const panel = document.querySelector('.snapshot-panel');
    if (panel) {
      panel.outerHTML = snapshotPanelHTML(Object.assign({}, readForm(), { seniaritySnapshot: snap }));
      wireSnapshotButton();   // re-bind on the freshly rendered panel
    }
  });
}

/* ============================================================
   AUTOCOMPLETE (seniority lookup)
   ============================================================ */
function attachAutocomplete(inputId, listId, onPick) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  function close() { list.hidden = true; list.innerHTML = ''; }
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !Store.seniority.length) { close(); return; }
    const matches = Store.seniority.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { close(); return; }
    list.innerHTML = matches.map(p =>
      `<div class="autocomplete-item" data-name="${esc(p.name)}">${esc(p.name)} <small>— ${esc(p.position) || 'no position'}, ${esc(p.site) || 'no site'}${p.seniorityHours ? ', ' + esc(p.seniorityHours) + 'h' : ''}</small></div>`
    ).join('');
    list.hidden = false;
    list.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('mousedown', ev => {
        ev.preventDefault();
        const person = Store.seniority.find(p => p.name === item.dataset.name);
        onPick(person);
        close();
      });
    });
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wireFormEvents(c) {
  pendingSnapshot = null;
  document.getElementById('btnCancel').addEventListener('click', closeCaseForm);
  document.getElementById('caseForm').addEventListener('submit', saveCase);
  document.getElementById('f_noticeDate').addEventListener('change', updateComputed);
  const del = document.getElementById('btnDelete');
  if (del) del.addEventListener('click', deleteCase);

  // Live status-gate feedback as the operator changes status/decision/outcome.
  ['f_status', 'f_decisionMade', 'f_optionChosen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateGateHint);
  });

  // Leave-of-absence: show/hide return-date fields and check them against
  // the Effective Date live as the operator edits either.
  ['f_onLeave', 'f_leaveReturnDate', 'f_effectiveDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(id === 'f_onLeave' ? 'change' : 'input', () => {
      updateLeaveWarning();
      updateGateHint();
    });
  });
  // "Use return date as Effective Date" button is re-rendered dynamically
  // inside the warning panel, so bind via delegation on the form.
  document.getElementById('caseForm').addEventListener('click', e => {
    if (e.target && e.target.id === 'btnUseReturnDate') {
      document.getElementById('f_effectiveDate').value = val('f_leaveReturnDate');
      updateLeaveWarning();
      updateGateHint();
    }
  });

  // Capture / refresh the seniority snapshot from the current list.
  wireSnapshotButton();

  // Name autocomplete → auto-fill site/position/hours.
  attachAutocomplete('f_name', 'nameAuto', person => {
    document.getElementById('f_name').value = person.name;
    if (!val('f_site')) document.getElementById('f_site').value = person.site || '';
    if (!val('f_position')) document.getElementById('f_position').value = person.position || '';
    if (!val('f_seniorityHours')) document.getElementById('f_seniorityHours').value = person.seniorityHours || '';
  });

  // Bumps-into autocomplete → store the chosen name; case created on save.
  attachAutocomplete('f_bumpsInto', 'bumpAuto', person => {
    document.getElementById('f_bumpsInto').value = person.name;
    // Clear hidden id so save() resolves/creates by name.
    document.getElementById('f_bumpsIntoId').value = '';
    const sel = document.getElementById('f_bumpExisting');
    if (sel) sel.value = '';
  });

  // Typing in bumps-into clears a previously-selected existing-case link.
  document.getElementById('f_bumpsInto').addEventListener('input', () => {
    document.getElementById('f_bumpsIntoId').value = '';
    updateGateHint();
  });

  // Existing-case dropdown link.
  const existing = document.getElementById('f_bumpExisting');
  if (existing) existing.addEventListener('change', () => {
    document.getElementById('f_bumpsIntoId').value = existing.value;
    const linked = existing.value ? Store.getCase(existing.value) : null;
    document.getElementById('f_bumpsInto').value = linked ? linked.name : '';
    updateGateHint();
  });
}

function wireViewEvents() {
  // Row / node click → edit.
  document.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', () => openCaseForm(el.dataset.edit));
  });
  const search = document.getElementById('caseSearch');
  if (search) search.addEventListener('input', () => {
    App.search = search.value;
    // Re-render list only; keep focus.
    const main = document.getElementById('main');
    main.innerHTML = renderCases();
    wireViewEvents();
    const s = document.getElementById('caseSearch');
    s.focus(); s.setSelectionRange(s.value.length, s.value.length);
  });
  const clearSen = document.getElementById('clearSeniority');
  if (clearSen) clearSen.addEventListener('click', () => {
    if (confirm('Clear the loaded seniority list? (Cases and their saved snapshots are not affected.)')) {
      recordAudit('seniority-clear', null, [], 'Seniority list cleared');
      Store.seniority = []; Store.seniorityMeta = null; Store.saveSeniority(); render(); toast('Seniority list cleared');
    }
  });

  const exportBtn = document.getElementById('exportAudit');
  if (exportBtn) exportBtn.addEventListener('click', exportAuditCSV);
}

/* Export the audit trail as a CSV file (offline, client-side). */
function exportAuditCSV() {
  const head = ['Timestamp', 'By', 'Action', 'Case', 'Details', 'Changes'];
  const rows = Store.audit.map(a => [
    a.at, a.by, a.action, a.caseName || '', a.details || '',
    (a.changes || []).map(ch => `${fieldLabel(ch.field)}: ${displayVal(ch.field, ch.from) || '(empty)'} -> ${displayVal(ch.field, ch.to) || '(empty)'}`).join(' | '),
  ]);
  const csv = [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `s54-audit-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Audit log exported');
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------- TOAST ---------------- */
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */
function init() {
  Store.load();

  document.getElementById('btnAddCase').addEventListener('click', () => openCaseForm());
  document.getElementById('modalClose').addEventListener('click', closeCaseForm);
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target.id === 'modalOverlay') closeCaseForm();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCaseForm(); });

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));

  // Seniority upload.
  document.getElementById('btnUploadSeniority').addEventListener('click', () => document.getElementById('seniorityFile').click());
  document.getElementById('seniorityFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';                 // allow re-upload of the same file
    if (!file) return;
    try {
      const list = await parseSeniorityFile(file);
      Store.seniority = list;
      Store.seniorityMeta = { uploadedAt: new Date().toISOString(), filename: file.name, count: list.length };
      Store.saveSeniority();
      recordAudit('seniority-upload', null, [], `Loaded "${file.name}" — ${list.length} employees`);
      toast(`Loaded ${list.length} employees`);
      setView('seniority');
    } catch (err) {
      alert('Could not read "' + file.name + '":\n\n' + err.message +
        '\n\nSupported: .xlsx and .csv. (Older .xls must be re-saved as .xlsx or .csv.)');
    }
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
