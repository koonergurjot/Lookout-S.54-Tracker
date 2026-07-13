/* ============================================================
   Lookout S.54 Bumping Tracker
   Local-only, offline, dependency-free vanilla JS app.

   Data lives in the browser's localStorage. Collections:
     - cases:        the bumping cases (the core data)
     - seniority:    the uploaded seniority list (lookup source)
     - seniorityMeta:when/what was uploaded (defensibility)
     - audit:        immutable change log (who/what/when)
     - vacancies:    the vacancy list (MIG — travels with the seniority list)

   ── WHERE TO MODIFY THINGS LATER ───────────────────────────
   • CONFIG below       → clocks, statuses, options, required & critical
                          fields, status gates, enforcement toggle
   • OPTION_FIELDS       → which fields each elected option requires
   • newCase() below    → add/remove/rename fields on a bumping case
   • COLUMN_MATCHERS    → how seniority xlsx/csv columns are matched

   ── ASSUMPTIONS THAT NEED DOMAIN REVIEW ────────────────────
   This build implements Art. 13 / MIG affiliate-displacement fidelity
   fixes. A few numbers are a best-effort reading of the rule text and
   are called out at CONFIG.NOTICE_PERIOD and in listStalenessWarning() —
   confirm/tune them against the actual agreement.
   ============================================================ */

/* ---------------- CONFIG ---------------- */
const CONFIG = {
  // 13.3 — the 7-day decision window runs from CONFIRMED RECEIPT of the
  // Employer's current seniority list, not the displacement notice date.
  // These are frequently different dates; this is the field that matters
  // if a "you missed your window" position is ever disputed.
  DECISION_WINDOW_DAYS: 7,
  UPCOMING_DEADLINE_DAYS: 3,

  // 13.4 — the notice period is scaled by seniority. This is a best-effort
  // reading of "2 wks probation / 4 wks post-probation / +1 wk per year at
  // 3+ years, max 8" — PROBATION_MONTHS in particular is an assumption
  // (not stated in the review). Confirm both against the agreement.
  NOTICE_PERIOD: {
    PROBATION_MONTHS: 6,            // ASSUMPTION — tune to your probation length
    PROBATION_WEEKS: 2,
    BASE_WEEKS: 4,                  // post-probation, under the scaling threshold
    SCALING_STARTS_AT_YEARS: 3,     // "+1 wk per year at 3+ years"
    MAX_WEEKS: 8,
  },

  // 13.5 — the recall period runs 1 year from the EXPIRY of the notice
  // period (not the notice date), and only applies to Laid Off cases.
  RECALL_PERIOD_DAYS: 365,
  RECALL_UPCOMING_DAYS: 30,

  // 13.2(c) — a notice that results in layoff must be copied to the BCGEU
  // rep within this window.
  UNION_NOTIFICATION_HOURS: 24,

  // 11.2 — seniority lists refresh quarterly on these months (1-indexed:
  // Jan/Apr/Jul/Oct). Used only as a heuristic (see listStalenessWarning) —
  // we compare the notice date's quarter to the quarter the list was
  // *uploaded* in, since the file itself doesn't carry an explicit
  // "effective quarter" field.
  LIST_REFRESH_MONTHS: [1, 4, 7, 10],

  // Real lifecycle of an affiliate displacement, replacing the old
  // Pending/Decision Required/Completed/Laid Off four-state model.
  STATUSES: [
    'Notice Issued',
    'List & Vacancies Provided',
    'Options Meeting Held',
    'Election Received',
    'Placed',
    'Laid Off',
    'Recall Period',
    'Closed',
  ],
  TERMINAL_STATUSES: ['Placed', 'Closed'],

  // The displacement options. Each unlocks different required fields —
  // see OPTION_FIELDS below.
  OPTIONS: [
    { value: 'Post to Vacancy',        label: 'Post into a vacant position (12.3)' },
    { value: 'Bump Junior Employee',   label: 'Bump a more junior employee' },
    { value: 'Transfer to Casual',     label: 'Transfer to casual (29.7)' },
    { value: 'Voluntary Layoff',       label: 'Accept voluntary layoff' },
    { value: 'Apply to Other Posting', label: 'Apply to other affiliate/HA postings (displaced priority)' },
  ],

  // Fields flagged (warned) when missing — "complete" definition.
  REQUIRED_FIELDS: ['name', 'site', 'position', 'seniorityHours', 'noticeDate', 'effectiveDate'],

  // ENFORCEMENT — critical fields that BLOCK saving when missing.
  // Set ENFORCE_CRITICAL=false to fall back to warn-only behaviour.
  ENFORCE_CRITICAL: true,
  CRITICAL_FIELDS: ['name', 'noticeDate', 'effectiveDate'],

  // STATUS GATES — data required before a case may ENTER each status.
  // A case can always sit in "Notice Issued" as a draft. Advancing is gated.
  STATUS_GATES: {
    'List & Vacancies Provided': ['seniorityListProvidedDate', 'vacancyListProvidedDate'],
    'Options Meeting Held':      ['seniorityListReceiptConfirmedDate'],
    'Election Received':         ['electedOption', 'optionFieldsComplete', 'decisionMade'],
    'Placed':                    ['electedOption', 'optionFieldsComplete', 'decisionMade',
                                   'leaveOk', 'noticePeriodOk', 'juniorOk', 'targetNotCasualTemp', 'abilityAttested'],
    'Laid Off':                  ['decisionMade', 'leaveOk', 'noticePeriodOk'],
  },
};

// Extra fields required once a given option is elected (beyond the base
// required/critical fields). Used by the 'optionFieldsComplete' gate.
const OPTION_FIELDS = {
  'Post to Vacancy':        ['vacancyPosition'],
  'Bump Junior Employee':   ['bumpsIntoId'],
  'Transfer to Casual':     [],
  'Voluntary Layoff':       [],
  'Apply to Other Posting': ['otherPostingDetails'],
};

// Default factory for a new case. Add new fields here + in the form builder.
function newCase(overrides = {}) {
  const now = new Date().toISOString();
  return Object.assign({
    id: 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    employeeId: '',          // optional — preferred match key when the seniority list has one
    name: '',
    site: '',
    position: '',
    seniorityHours: '',
    employmentStatus: '',    // Regular / Casual / Temporary (from seniority list)
    hireDate: '',             // seniority/hire date (from seniority list) — drives 13.4
    payRate: '',              // optional (from seniority list, if present) — drives the 3% promotion test
    eventLabel: '',           // groups cases from the same concurrent restructuring

    noticeDate: '',                        // S.54 displacement notice date
    seniorityListProvidedDate: '',         // 11.2 — date the current list was provided
    vacancyListProvidedDate: '',           // MIG — vacancy list travels with the seniority list
    seniorityListReceiptConfirmedDate: '', // 13.3 — the REAL 7-day clock start
    receiptConfirmedVia: '',               // Email / Signature / Meeting / Other

    stewardPresent: false,   // 13.2(b) — steward present at the options meeting
    unionNotifiedAt: '',     // 13.2(c) — timestamp the BCGEU rep was copied on a layoff

    effectiveDate: '',

    onLeave: false,          // is this staff member currently on a leave of absence?
    leaveReturnDate: '',     // expected return-to-work date, if onLeave
    leaveType: '',           // optional: Medical / Parental / WCB / etc.

    electedOption: '',              // one of CONFIG.OPTIONS[].value, or '' if not yet elected
    vacancyPosition: '',            // if electedOption === 'Post to Vacancy'
    electsCasualRegistration: false,// sub-flag if electedOption === 'Voluntary Layoff'
    otherPostingDetails: '',        // if electedOption === 'Apply to Other Posting'
    bumpsIntoId: '',                // if electedOption === 'Bump Junior Employee'
    abilityAssessedBy: '',          // ability-to-perform attestation — who assessed
    abilityAssessmentBasis: '',     // ...and on what basis (not a silent assumption)

    decisionMade: false,
    decisionMadeAt: '',      // timestamp when decision was recorded (defensibility)
    status: 'Notice Issued',
    notes: '',
    // ---- defensibility / audit fields ----
    senioritySnapshot: null, // frozen seniority record at decision time
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
  vacancies: [],
  load() {
    try { this.cases = JSON.parse(localStorage.getItem('s54_cases')) || []; } catch { this.cases = []; }
    try { this.seniority = JSON.parse(localStorage.getItem('s54_seniority')) || []; } catch { this.seniority = []; }
    try { this.seniorityMeta = JSON.parse(localStorage.getItem('s54_seniorityMeta')) || null; } catch { this.seniorityMeta = null; }
    try { this.audit = JSON.parse(localStorage.getItem('s54_audit')) || []; } catch { this.audit = []; }
    try { this.vacancies = JSON.parse(localStorage.getItem('s54_vacancies')) || []; } catch { this.vacancies = []; }
    this.migrateCases();
  },
  saveCases() { localStorage.setItem('s54_cases', JSON.stringify(this.cases)); },
  saveSeniority() {
    localStorage.setItem('s54_seniority', JSON.stringify(this.seniority));
    localStorage.setItem('s54_seniorityMeta', JSON.stringify(this.seniorityMeta));
  },
  saveAudit() { localStorage.setItem('s54_audit', JSON.stringify(this.audit)); },
  saveVacancies() { localStorage.setItem('s54_vacancies', JSON.stringify(this.vacancies)); },
  getCase(id) { return this.cases.find(c => c.id === id); },
  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      cases: this.cases, seniority: this.seniority, seniorityMeta: this.seniorityMeta,
      audit: this.audit, vacancies: this.vacancies,
    };
  },
  importAll(data) {
    this.cases = Array.isArray(data.cases) ? data.cases : [];
    this.seniority = Array.isArray(data.seniority) ? data.seniority : [];
    this.seniorityMeta = data.seniorityMeta || null;
    this.audit = Array.isArray(data.audit) ? data.audit : [];
    this.vacancies = Array.isArray(data.vacancies) ? data.vacancies : [];
    this.saveCases(); this.saveSeniority(); this.saveAudit(); this.saveVacancies();
    this.migrateCases();
  },
  // Safety net for any real browser data saved under the old (misspelled)
  // `seniaritySnapshot` key, from before it was renamed to `senioritySnapshot`.
  migrateCases() {
    let changed = false;
    this.cases.forEach(c => {
      if (c.senioritySnapshot === undefined && c.seniaritySnapshot !== undefined) {
        c.senioritySnapshot = c.seniaritySnapshot;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(c, 'seniaritySnapshot')) {
        delete c.seniaritySnapshot;
        changed = true;
      }
    });
    if (changed) this.saveCases();
  },
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
    action,                                   // 'create' | 'update' | 'delete' | 'chain-create' | 'seniority-upload' | 'seniority-clear' | 'vacancy-*'
    caseId: caseObj ? caseObj.id : '',
    caseName: caseObj ? caseObj.name : '',
    changes: changes || [],                   // [{ field, from, to }]
    details: details || '',
  });
  Store.saveAudit();
}

// Diff two case snapshots → list of {field, from, to} for audited fields.
const AUDITED_FIELDS = [
  'name', 'site', 'position', 'seniorityHours', 'employmentStatus', 'hireDate', 'eventLabel',
  'noticeDate', 'effectiveDate',
  'seniorityListProvidedDate', 'vacancyListProvidedDate', 'seniorityListReceiptConfirmedDate', 'receiptConfirmedVia',
  'stewardPresent', 'unionNotifiedAt',
  'onLeave', 'leaveReturnDate', 'leaveType',
  'electedOption', 'vacancyPosition', 'electsCasualRegistration', 'otherPostingDetails',
  'bumpsIntoId', 'abilityAssessedBy', 'abilityAssessmentBasis',
  'decisionMade', 'status', 'notes',
];
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
  // 13.3 — the 7-day window runs from CONFIRMED RECEIPT of the current
  // seniority list, NOT the displacement notice date.
  return addDays(c.seniorityListReceiptConfirmedDate, CONFIG.DECISION_WINDOW_DAYS);
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

// 11.2 — nearest quarter start (Jan/Apr/Jul/Oct 1) on/before a given date.
function quarterStart(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return '';
  const months = CONFIG.LIST_REFRESH_MONTHS;
  const m = d.getMonth() + 1;
  let qMonth = months[0];
  for (const mo of months) if (mo <= m) qMonth = mo;
  return `${d.getFullYear()}-${String(qMonth).padStart(2, '0')}-01`;
}
function quarterLabel(qStartStr) {
  if (!qStartStr) return '';
  const [y, m] = qStartStr.split('-');
  const names = { '01': 'Jan 1', '04': 'Apr 1', '07': 'Jul 1', '10': 'Oct 1' };
  return `${names[m] || m} ${y}`;
}
// 11.2 heuristic: flag when the notice date falls in a different quarter
// than the one the loaded seniority list was UPLOADED in (the file itself
// doesn't carry an explicit "effective quarter" field, so upload date is
// our best proxy — confirm against the report's own title/date when in doubt).
function listStalenessWarning(c) {
  if (!c.noticeDate || !Store.seniorityMeta || !Store.seniorityMeta.uploadedAt) return '';
  const noticeQ = quarterStart(c.noticeDate);
  const listQ = quarterStart(Store.seniorityMeta.uploadedAt);
  if (noticeQ && listQ && noticeQ !== listQ) {
    return `Notice dated ${fmtDate(c.noticeDate)} (${quarterLabel(noticeQ)} quarter) but the loaded seniority list was uploaded in the ${quarterLabel(listQ)} quarter — this may not be the list currently in effect (11.2).`;
  }
  return '';
}

// Years of service between hireDate and asOfDate (decimal). null if unknown.
function yearsOfService(hireDate, asOfDate) {
  if (!hireDate || !asOfDate) return null;
  const h = new Date(hireDate + 'T00:00:00');
  const a = new Date(asOfDate + 'T00:00:00');
  if (isNaN(h) || isNaN(a)) return null;
  return (a - h) / (365.25 * 86400000);
}
// 13.4 — scaled notice period, in weeks. null if hire date is unknown
// (can't be verified, so callers should NOT treat that as a violation).
function noticePeriodWeeks(c) {
  const yrs = yearsOfService(c.hireDate, c.noticeDate || today());
  if (yrs === null) return null;
  const P = CONFIG.NOTICE_PERIOD;
  const probationYears = P.PROBATION_MONTHS / 12;
  if (yrs < probationYears) return P.PROBATION_WEEKS;
  if (yrs < P.SCALING_STARTS_AT_YEARS) return P.BASE_WEEKS;
  const extraYears = Math.floor(yrs - (P.SCALING_STARTS_AT_YEARS - 1));
  return Math.min(P.MAX_WEEKS, P.BASE_WEEKS + extraYears);
}
function noticePeriodEndDate(c) {
  const wk = noticePeriodWeeks(c);
  if (wk === null || !c.noticeDate) return '';
  return addDays(c.noticeDate, wk * 7);
}
// True only when we CAN verify (both notice-period-end and effective date
// known) and the effective date lands before the notice period ends.
function noticePeriodViolation(c) {
  const end = noticePeriodEndDate(c);
  if (!end || !c.effectiveDate) return false;
  return c.effectiveDate < end;
}
// 13.5 — recall period: 1 year from the EXPIRY of the notice period.
function recallExpiryDate(c) {
  const end = noticePeriodEndDate(c);
  if (!end) return '';
  return addDays(end, CONFIG.RECALL_PERIOD_DAYS);
}

function missingFields(c) {
  return CONFIG.REQUIRED_FIELDS.filter(f => c[f] === '' || c[f] === null || c[f] === undefined);
}
function isOverdue(c) {
  if (c.decisionMade || !isActive(c)) return false;
  const d = daysUntil(decisionDeadline(c));
  return d !== null && d < 0;
}
function isActive(c) { return !CONFIG.TERMINAL_STATUSES.includes(c.status); }

// True if the Effective Date is set earlier than the staff member's recorded
// return-from-leave date — i.e. the bump/layoff would take effect while
// they're still away. The effective date should instead be set to (or after)
// the return date.
function leaveConflict(c) {
  return !!(c.onLeave && c.leaveReturnDate && c.effectiveDate && c.effectiveDate < c.leaveReturnDate);
}

// 13.2(c) — flags a missing or late union notification for a case that
// resulted (or is resulting) in layoff.
function unionNotificationIssue(c) {
  const resultedInLayoff = c.status === 'Laid Off' || c.status === 'Recall Period';
  if (!resultedInLayoff) return '';
  if (!c.unionNotifiedAt) return 'Layoff not yet copied to the BCGEU rep (13.2(c) — 24h requirement)';
  const reference = c.decisionMadeAt || c.noticeDate;
  if (!reference) return '';
  const hrs = (new Date(c.unionNotifiedAt) - new Date(reference)) / 3600000;
  if (hrs > CONFIG.UNION_NOTIFICATION_HOURS) return `Union notified ${Math.round(hrs)}h after the decision — outside the ${CONFIG.UNION_NOTIFICATION_HOURS}h window (13.2(c))`;
  return '';
}

/* ---------------- ENFORCEMENT: status gates & critical fields ---------------- */
// Fields still missing for the currently-elected option (drives the
// 'optionFieldsComplete' gate — each option unlocks different requirements).
function optionFieldsMissing(c) {
  if (!c.electedOption) return [];
  const reqs = OPTION_FIELDS[c.electedOption] || [];
  return reqs.filter(f => c[f] === '' || c[f] === null || c[f] === undefined);
}

// Evaluate one gate requirement against a case. Supports virtual predicates.
function gateMet(c, req) {
  if (req === 'decisionMade')          return !!c.decisionMade;
  if (req === 'leaveOk')               return !leaveConflict(c);
  if (req === 'electedOption')         return !!c.electedOption;
  if (req === 'optionFieldsComplete')  return optionFieldsMissing(c).length === 0;
  if (req === 'juniorOk')              return !juniorViolation(c);
  if (req === 'targetNotCasualTemp')   return !targetCasualTempViolation(c);
  if (req === 'noticePeriodOk')        return !noticePeriodViolation(c);
  if (req === 'abilityAttested') {
    if (c.electedOption !== 'Bump Junior Employee') return true;
    return !!(c.abilityAssessedBy && c.abilityAssessmentBasis);
  }
  return c[req] !== '' && c[req] !== null && c[req] !== undefined;
}
function gateLabel(req) {
  if (req === 'decisionMade') return '“Decision made” checked';
  if (req === 'leaveOk') return "an Effective Date on/after the staff member's return from leave";
  if (req === 'electedOption') return 'an elected option (Post to Vacancy / Bump / Casual / Voluntary Layoff / Other Posting)';
  if (req === 'optionFieldsComplete') return 'the fields required by the elected option (e.g. bump target, vacancy position)';
  if (req === 'juniorOk') return 'a bump target with fewer seniority hours than the bumping employee';
  if (req === 'targetNotCasualTemp') return 'a bump target in a Regular position (not Casual/Temporary)';
  if (req === 'noticePeriodOk') return 'an Effective Date on/after the end of the scaled notice period (13.4)';
  if (req === 'abilityAttested') return 'an ability-to-perform attestation (assessed by, and on what basis)';
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

/* ---------------- BUMP-VALIDITY CHECKS (defensibility) ---------------- */
// Resolve the currently-selected/typed bump target's identity + seniority
// info WITHOUT requiring a Case to exist yet (falls back to the seniority
// list directly), so validity can be checked before the domino auto-create
// runs. Prefers an employeeId match over a name match when both are known.
function resolveTypedBumpTarget() {
  const selId = val('f_bumpsIntoId');
  if (selId) {
    const existing = Store.getCase(selId);
    if (existing) return {
      id: selId, name: existing.name, seniorityHours: existing.seniorityHours,
      employmentStatus: existing.employmentStatus, payRate: existing.payRate,
    };
  }
  const typed = val('f_bumpsInto').trim();
  if (!typed) return null;
  const existingByName = Store.cases.find(c => c.id !== editingId && c.name.toLowerCase() === typed.toLowerCase());
  if (existingByName) return {
    id: existingByName.id, name: existingByName.name, seniorityHours: existingByName.seniorityHours,
    employmentStatus: existingByName.employmentStatus, payRate: existingByName.payRate,
  };
  const sen = findSeniorityPerson({ name: typed });
  if (sen) return { id: null, name: sen.name, seniorityHours: sen.seniorityHours, employmentStatus: sen.employmentStatus, payRate: sen.payRate };
  return { id: null, name: typed, seniorityHours: '', employmentStatus: '', payRate: '' };
}
// A case's bump-target info: the live projection (c._target) if present
// (mid-edit, from the open form), else resolved from the saved bumpsIntoId.
function bumpTargetInfo(c) {
  if (c._target !== undefined) return c._target;
  if (!c.bumpsIntoId) return null;
  const t = Store.getCase(c.bumpsIntoId);
  return t ? { id: t.id, name: t.name, seniorityHours: t.seniorityHours, employmentStatus: t.employmentStatus, payRate: t.payRate } : null;
}
function juniorViolation(c) {
  if (c.electedOption !== 'Bump Junior Employee') return false;
  const t = bumpTargetInfo(c);
  if (!t || t.seniorityHours === '' || t.seniorityHours == null) return false;
  if (c.seniorityHours === '' || c.seniorityHours == null) return false;
  return Number(t.seniorityHours) >= Number(c.seniorityHours);
}
function targetCasualTempViolation(c) {
  if (c.electedOption !== 'Bump Junior Employee') return false;
  const t = bumpTargetInfo(c);
  if (!t || !t.employmentStatus) return false;
  return /casual|temp/i.test(t.employmentStatus);
}
// 3% promotion test — only computable when BOTH pay rates are known. Real
// affiliate seniority exports may not include pay rate; when it's absent
// this simply returns null (degrades to "unverified", not a violation).
function promotionFlag(c) {
  if (c.electedOption !== 'Bump Junior Employee') return null;
  const t = bumpTargetInfo(c);
  if (!t || !t.payRate || !c.payRate) return null;
  const bRate = Number(c.payRate), tRate = Number(t.payRate);
  if (!isFinite(bRate) || !isFinite(tRate) || bRate <= 0) return null;
  const pctOver = (tRate - bRate) / bRate;
  return pctOver > 0.03 ? pctOver : null;
}
function duplicateTargetViolation(c) {
  if (!c.bumpsIntoId) return false;
  return Store.cases.some(o => o.id !== c.id && o.bumpsIntoId === c.bumpsIntoId);
}
// HARD blockers checked at save time (like criticalMissing) — a bump that
// fails these isn't valid, full stop, so it should never reach storage.
function bumpBlockers(data) {
  const blockers = [];
  if (data.electedOption !== 'Bump Junior Employee') return blockers;
  const t = resolveTypedBumpTarget();
  if (!t) return blockers; // no target chosen yet — optionFieldsComplete gate covers that on status advance
  if (t.seniorityHours !== '' && t.seniorityHours != null && data.seniorityHours !== '' && data.seniorityHours != null) {
    if (Number(t.seniorityHours) >= Number(data.seniorityHours)) {
      blockers.push(`"${t.name}" has ${Number(t.seniorityHours) === Number(data.seniorityHours) ? 'the same' : 'more'} seniority hours (${t.seniorityHours}) than the bumping employee (${data.seniorityHours}) — not a valid bump; the target must be more junior.`);
    }
  }
  if (t.employmentStatus && /casual|temp/i.test(t.employmentStatus)) {
    blockers.push(`"${t.name}" is ${t.employmentStatus} — Casual/Temporary positions cannot be bump targets.`);
  }
  return blockers;
}

// Ranked list of valid bump targets for a given bumper: more junior,
// Regular (not Casual/Temporary), excluding the bumper themselves. Ranked
// by CLOSEST seniority first (i.e. the most senior of the eligible juniors) —
// a judgment call favouring the shortest possible domino chain; re-rank
// if your practice differs. Ability-to-perform is never auto-cleared —
// every candidate still needs the explicit attestation fields.
function eligibleBumpTargets(bumperCase) {
  const bh = (bumperCase.seniorityHours === '' || bumperCase.seniorityHours == null) ? null : Number(bumperCase.seniorityHours);
  const bumperName = (bumperCase.name || '').toLowerCase();
  const targetedElsewhere = new Set(
    Store.cases.filter(c => c.id !== bumperCase.id && c.bumpsIntoId).map(c => c.bumpsIntoId)
  );
  return Store.seniority
    .filter(p => p.name.toLowerCase() !== bumperName)
    .filter(p => !p.employmentStatus || !/casual|temp/i.test(p.employmentStatus))
    .filter(p => bh === null || p.seniorityHours === '' || Number(p.seniorityHours) < bh)
    .map(p => {
      const existingCase = Store.cases.find(c => c.name.toLowerCase() === p.name.toLowerCase());
      return {
        name: p.name, position: p.position, site: p.site, seniorityHours: p.seniorityHours,
        delta: (bh !== null && p.seniorityHours !== '') ? Number(p.seniorityHours) - bh : null,
        alreadyTargeted: existingCase ? targetedElsewhere.has(existingCase.id) : false,
      };
    })
    .sort((a, b) => {
      const av = a.seniorityHours === '' ? -Infinity : Number(a.seniorityHours);
      const bv = b.seniorityHours === '' ? -Infinity : Number(b.seniorityHours);
      return bv - av; // closest-in-seniority (most senior of the eligible juniors) first
    })
    .slice(0, 25);
}

/* ---------------- SENIORITY SNAPSHOT (defensibility) ---------------- */
// Prefer an employeeId match (disambiguates repeated names); fall back to
// a case-insensitive name match.
function findSeniorityPerson(query) {
  if (query.employeeId) {
    const byId = Store.seniority.find(p => p.employeeId && p.employeeId === query.employeeId);
    if (byId) return byId;
  }
  if (!query.name) return null;
  return Store.seniority.find(p => p.name.toLowerCase() === query.name.toLowerCase()) || null;
}
// Freeze the seniority record for this person at this moment, with the
// provenance of the list it came from. This is what existed "at the time".
function captureSnapshot(name, employeeId) {
  const person = findSeniorityPerson({ name, employeeId });
  if (!person) return null;
  return {
    name: person.name,
    employeeId: person.employeeId || '',
    site: person.site,
    position: person.position,
    seniorityHours: person.seniorityHours,
    employmentStatus: person.employmentStatus || '',
    hireDate: person.hireDate || '',
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

  if (!c.seniorityListReceiptConfirmedDate) w.push('Seniority list receipt not confirmed — 7-day clock not started (13.3)');
  else if (isOverdue(c)) w.push('Decision overdue (7-day, from confirmed list receipt)');

  const staleness = listStalenessWarning(c);
  if (staleness) w.push(staleness);

  if (isActive(c)) {
    if (!c.hireDate) w.push('Hire date missing — cannot verify the scaled 13.4 notice period');
    else if (noticePeriodViolation(c)) w.push(`Effective Date is before the scaled notice period ends (${fmtDate(noticePeriodEndDate(c))}) — 13.4`);
  }

  if (c.status === 'Laid Off' || c.status === 'Recall Period') {
    const recall = recallExpiryDate(c);
    if (recall) {
      const d = daysUntil(recall);
      if (d !== null && d < 0) w.push(`Recall period (13.5) has expired (${fmtDate(recall)})`);
      else if (d !== null && d <= CONFIG.RECALL_UPCOMING_DAYS) w.push(`Recall period expires in ${d}d (${fmtDate(recall)})`);
    }
  }

  const unionIssue = unionNotificationIssue(c);
  if (unionIssue) w.push(unionIssue);
  if (!c.stewardPresent && c.status !== 'Notice Issued') w.push('Steward presence at options meeting not recorded (13.2(b))');

  if (!c.electedOption && c.status !== 'Notice Issued' && c.status !== 'List & Vacancies Provided') w.push('No option elected yet');
  if (c.electedOption === 'Bump Junior Employee') {
    if (targetCasualTempViolation(c)) w.push('Bump target is Casual/Temporary — not a valid target');
    if (juniorViolation(c)) w.push('Bump target is not more junior than the bumping employee');
    const promo = promotionFlag(c);
    if (promo !== null) w.push(`Promotion test: target's pay rate is ${Math.round(promo * 100)}% above the bumper's (>3% threshold) — verify this is not a promotion`);
    if (!c.abilityAssessedBy || !c.abilityAssessmentBasis) w.push('Ability-to-perform attestation not recorded');
    if (duplicateTargetViolation(c)) w.push('Bump target already displaced by another case — one person can only be displaced once');
  }

  // On-leave: flag missing return date, or an effective date that lands before it.
  if (c.onLeave) {
    if (!c.leaveReturnDate) w.push('On leave — return date not recorded');
    else if (leaveConflict(c)) w.push(`Effective Date is before return from leave (returns ${fmtDate(c.leaveReturnDate)})`);
  }

  // Defensibility: no frozen seniority snapshot backing this case.
  if (!c.senioritySnapshot) w.push('No seniority snapshot on record');

  // Incomplete chain: a person was bumped but their own next move isn't resolved.
  if (c.bumpsIntoId) {
    const next = Store.getCase(c.bumpsIntoId);
    if (next && isActive(next) && !next.electedOption)
      w.push('Chain continues — next case undecided');
  }
  return w;
}

// Short, single next-step hint per case — driven by the same rules as the
// gates/warnings above, so the operator doesn't have to reconstruct it.
function nextAction(c) {
  if (!isActive(c)) return c.status === 'Placed' ? 'Closed out — placed' : 'Closed';
  if (!c.seniorityListProvidedDate || !c.vacancyListProvidedDate) return 'Provide seniority + vacancy list';
  if (!c.seniorityListReceiptConfirmedDate) return 'Confirm list receipt (starts the 7-day clock)';
  if (!c.electedOption) return isOverdue(c) ? 'OVERDUE — record the elected option' : 'Hold options meeting / record election';
  if (optionFieldsMissing(c).length) return 'Complete the fields for the elected option';
  if (c.electedOption === 'Bump Junior Employee' && (juniorViolation(c) || targetCasualTempViolation(c))) return 'Fix invalid bump target';
  if (leaveConflict(c)) return "Adjust Effective Date to staff member's return";
  if (c.hireDate && noticePeriodViolation(c)) return 'Push Effective Date past notice period end (13.4)';
  if (!c.decisionMade) return 'Confirm the decision';
  if (c.status !== 'Placed' && c.status !== 'Laid Off' && c.status !== 'Recall Period') return 'Move to Placed / Laid Off';
  if ((c.status === 'Laid Off' || c.status === 'Recall Period') && !c.unionNotifiedAt) return 'Notify the union rep (24h — 13.2(c))';
  if (c.status === 'Recall Period') return 'Track recall period (13.5)';
  return 'Close case';
}

/* ---------------- FIELD LABELS ---------------- */
const FIELD_LABELS = {
  employeeId: 'Employee ID', name: 'Name', site: 'Site', position: 'Position', seniorityHours: 'Seniority Hours',
  employmentStatus: 'Employment Status', hireDate: 'Hire / Seniority Date', payRate: 'Pay Rate', eventLabel: 'Event / Restructuring',
  noticeDate: 'S.54 Notice Date', effectiveDate: 'Effective Date',
  seniorityListProvidedDate: 'Seniority List Provided', vacancyListProvidedDate: 'Vacancy List Provided',
  seniorityListReceiptConfirmedDate: 'List Receipt Confirmed', receiptConfirmedVia: 'Receipt Confirmed Via',
  stewardPresent: 'Steward Present', unionNotifiedAt: 'Union Notified At',
  onLeave: 'On Leave', leaveReturnDate: 'Expected Return Date', leaveType: 'Leave Type',
  electedOption: 'Elected Option', vacancyPosition: 'Vacancy Position',
  electsCasualRegistration: 'Elects Casual Registration', otherPostingDetails: 'Other Posting Details',
  bumpsIntoId: 'Bumps Into', abilityAssessedBy: 'Ability Assessed By', abilityAssessmentBasis: 'Ability Assessment Basis',
  decisionMade: 'Decision Made', decisionMadeAt: 'Decision Timestamp',
  status: 'Status', notes: 'Notes',
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

   employeeId / employmentStatus / hireDate / payRate are OPTIONAL — if a
   report doesn't have the column, the matcher simply never fires and the
   field stays blank (degrades gracefully; validators that need it just
   skip, they don't hard-fail).
   ============================================================ */
const COLUMN_MATCHERS = {
  name:             h => h.includes('last, first') || h.includes('last,first') || h.includes('employee name') || h.includes('full name') || h === 'name' || h === 'employee',
  position:         h => h.includes('job class') || h.includes('position') || h.includes('classification') || h.includes('title') || h === 'job' || h === 'role',
  site:             h => h.includes('location') || h.includes('site') || h.includes('facility') || h.includes('department') || h === 'dept',
  seniorityHours:   h => h.includes('total sen') || h.includes('seniority') && !h.includes('date') || (h.includes('total') && h.includes('sen')) || h === 'hours' || h.includes('total hours'),
  employeeId:       h => h.includes('employee id') || h.includes('emp id') || h.includes('emp #') || h.includes('employee #') || h.includes('employee number') || h === 'id' || h === 'empid',
  employmentStatus: h => h.includes('employment status') || h.includes('employee status') || h === 'status' || h.includes('employment type') || (h.includes('regular') && h.includes('casual')),
  hireDate:         h => h.includes('hire date') || h.includes('seniority date') || h.includes('date of hire') || h === 'hired' || h === 'doh',
  payRate:          h => h.includes('pay rate') || h.includes('hourly rate') || h.includes('wage rate') || h === 'rate' || h.includes('grid step') || h.includes('step'),
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
  const idx = { name: -1, position: -1, site: -1, seniorityHours: -1, employeeId: -1, employmentStatus: -1, hireDate: -1, payRate: -1 };
  headers.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    for (const field in COLUMN_MATCHERS) {
      if (idx[field] === -1 && COLUMN_MATCHERS[field](h)) idx[field] = i;
    }
  });

  const col = (cols, field) => idx[field] > -1 ? (cols[idx[field]] || '').toString().trim() : '';

  const list = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cols = rows[r];
    const name = col(cols, 'name');
    if (!name) continue;                              // require a name; skips blanks/footers
    if (/^(total|grand total)\b/i.test(name)) continue;
    list.push({
      name,
      site: col(cols, 'site'),
      position: col(cols, 'position'),
      seniorityHours: cleanHours(idx.seniorityHours > -1 ? cols[idx.seniorityHours] : ''),
      employeeId: col(cols, 'employeeId'),
      employmentStatus: col(cols, 'employmentStatus'),
      hireDate: normalizeDateCell(col(cols, 'hireDate')),
      payRate: col(cols, 'payRate'),
    });
  }
  if (!list.length) throw new Error('Found the header but no employee rows below it.');
  return list;
}

// Best-effort normalization of a hire-date cell (various spreadsheet date
// formats) to YYYY-MM-DD. Leaves the raw value alone if unparseable —
// callers treat an unparseable hireDate the same as a missing one.
function normalizeDateCell(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(s);
  if (m) {
    let [, mo, da, yr] = m;
    if (yr.length === 2) yr = (Number(yr) > 50 ? '19' : '20') + yr;
    return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().slice(0, 10);
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
const App = { view: 'dashboard', search: '', eventFilter: '' };

function setView(v) {
  App.view = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  render();
}

// Cases scoped to the active event filter (case grouping for concurrent
// restructurings) — used by every view that lists cases.
function filteredCases() {
  return App.eventFilter ? Store.cases.filter(c => c.eventLabel === App.eventFilter) : Store.cases;
}
function knownEventLabels() {
  return [...new Set(Store.cases.map(c => c.eventLabel).filter(Boolean))].sort();
}
function eventFilterHTML() {
  const labels = knownEventLabels();
  if (!labels.length) return '';
  return `<select id="eventFilter" class="event-filter">
    <option value="">All events</option>
    ${labels.map(l => `<option value="${esc(l)}" ${App.eventFilter === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
  </select>`;
}

function render() {
  const main = document.getElementById('main');
  if (App.view === 'dashboard') main.innerHTML = renderDashboard();
  else if (App.view === 'cases') main.innerHTML = renderCases();
  else if (App.view === 'chains') main.innerHTML = renderChains();
  else if (App.view === 'vacancies') main.innerHTML = renderVacancies();
  else if (App.view === 'seniority') main.innerHTML = renderSeniority();
  else if (App.view === 'audit') main.innerHTML = renderAudit();
  wireViewEvents();
}

/* ---------------- DASHBOARD ---------------- */
function renderDashboard() {
  const cases = filteredCases();
  const active = cases.filter(isActive);
  const missing = cases.filter(c => missingFields(c).length > 0);
  const overdue = cases.filter(isOverdue);
  const noticePeriodIssues = cases.filter(c => isActive(c) && c.hireDate && noticePeriodViolation(c));
  const recallExpiring = cases.filter(c => {
    if (c.status !== 'Laid Off' && c.status !== 'Recall Period') return false;
    const d = daysUntil(recallExpiryDate(c));
    return d !== null && d <= CONFIG.RECALL_UPCOMING_DAYS;
  });
  const unionIssues = cases.filter(c => !!unionNotificationIssue(c));
  const upcoming = cases.filter(c => {
    if (!isActive(c)) return false;
    const d = daysUntil(decisionDeadline(c));
    return d !== null && d >= 0 && d <= CONFIG.UPCOMING_DEADLINE_DAYS;
  });
  const noSnapshot = cases.filter(c => !c.senioritySnapshot);
  const onLeave = cases.filter(c => isActive(c) && c.onLeave);
  const leaveConflicts = onLeave.filter(leaveConflict);

  const listRows = (arr, label, dateFn) => arr.length
    ? `<table class="case-table"><thead><tr><th>Name</th><th>Position</th><th>Date</th><th>Status</th></tr></thead><tbody>
        ${arr.map(c => `<tr class="row-click" data-edit="${c.id}">
          <td>${esc(c.name) || '<span class="muted">Unnamed</span>'}</td>
          <td>${esc(c.position) || '—'}</td>
          <td>${fmtDate(dateFn(c))}</td>
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
    <div class="toolbar">${eventFilterHTML()}</div>
    <div class="cards">
      <div class="card"><div class="num">${active.length}</div><div class="label">Total Active Cases</div></div>
      <div class="card ${missing.length ? 'warn' : 'ok'}"><div class="num">${missing.length}</div><div class="label">Cases Missing Info</div></div>
      <div class="card ${overdue.length ? 'alert' : 'ok'}"><div class="num">${overdue.length}</div><div class="label">Overdue Decisions (7-day)</div></div>
      <div class="card ${noticePeriodIssues.length ? 'alert' : 'ok'}"><div class="num">${noticePeriodIssues.length}</div><div class="label">Notice Period (13.4) Issues</div></div>
      <div class="card ${recallExpiring.length ? 'alert' : 'ok'}"><div class="num">${recallExpiring.length}</div><div class="label">Recall Expiring/Expired (13.5)</div></div>
      <div class="card ${unionIssues.length ? 'alert' : 'ok'}"><div class="num">${unionIssues.length}</div><div class="label">Union Notification (13.2c)</div></div>
      <div class="card ${upcoming.length ? 'warn' : 'ok'}"><div class="num">${upcoming.length}</div><div class="label">Upcoming Deadlines (≤${CONFIG.UPCOMING_DEADLINE_DAYS}d)</div></div>
      <div class="card ${noSnapshot.length ? 'warn' : 'ok'}"><div class="num">${noSnapshot.length}</div><div class="label">No Seniority Snapshot</div></div>
      <div class="card ${leaveConflicts.length ? 'alert' : (onLeave.length ? 'warn' : 'ok')}"><div class="num">${onLeave.length}</div><div class="label">Staff On Leave</div></div>
    </div>

    ${seniorityBanner}
    <div class="dash-section"><h3>⚠️ Overdue Decisions (7-day, from confirmed list receipt)</h3>${listRows(overdue, 'overdue decisions', decisionDeadline)}</div>
    <div class="dash-section"><h3>📐 Notice Period (13.4) Issues</h3>${listRows(noticePeriodIssues, 'notice-period issues', noticePeriodEndDate)}</div>
    <div class="dash-section"><h3>📅 Recall Period (13.5) Expiring/Expired</h3>${listRows(recallExpiring, 'recall-period cases', recallExpiryDate)}</div>
    <div class="dash-section"><h3>⏳ Upcoming Deadlines</h3>${listRows(upcoming, 'upcoming deadlines', decisionDeadline)}</div>
    <div class="dash-section"><h3>🏖️ Staff On Leave</h3>${leaveRows}</div>
    <div class="dash-section"><h3>📋 Cases Missing Information</h3>${listRows(missing, 'cases missing info', decisionDeadline)}</div>
  `;
}

function deadlineFlag(c) {
  if (!isActive(c) || c.decisionMade) return '';
  const d = daysUntil(decisionDeadline(c));
  if (d === null) return '';
  if (d < 0) return `<span class="flag">${Math.abs(d)}d overdue</span>`;
  if (d <= CONFIG.UPCOMING_DEADLINE_DAYS) return `<span class="flag flag-warn">in ${d}d</span>`;
  return '';
}

/* ---------------- CASES LIST ---------------- */
function renderCases() {
  const q = App.search.toLowerCase();
  const list = filteredCases().filter(c =>
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
      <td class="muted">${esc(nextAction(c))}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7"><div class="empty-state">No cases yet. Click <strong>+ Add Case</strong> to begin.</div></td></tr>`;

  return `
    <div class="toolbar">
      <input type="search" id="caseSearch" placeholder="Search name, position, site…" value="${esc(App.search)}" />
      ${eventFilterHTML()}
      <span class="muted">${list.length} case${list.length === 1 ? '' : 's'}</span>
    </div>
    <table class="case-table">
      <thead><tr><th>Name / Site</th><th>Position</th><th>Sen. Hours</th><th>Decision Deadline</th><th>Bumps Into</th><th>Status</th><th>Next Action</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/* ---------------- CHAINS (visual domino) ---------------- */
function renderChains() {
  const cases = filteredCases();
  // A chain starts at a case nobody bumps into ("root").
  const bumpedInto = new Set(cases.map(c => c.bumpsIntoId).filter(Boolean));
  const roots = cases.filter(c => !bumpedInto.has(c.id));

  if (!cases.length)
    return `<div class="toolbar">${eventFilterHTML()}</div><div class="empty-state">No cases yet. Chains appear automatically as you record who bumps whom.</div>`;

  let anyCycle = false;
  const included = new Set();
  const chains = roots.map(root => {
    const nodes = [];
    let cur = root, guard = 0;
    const seen = new Set();
    while (cur && guard++ < 200 && !seen.has(cur.id)) {
      seen.add(cur.id);
      included.add(cur.id);
      nodes.push(cur);
      cur = cur.bumpsIntoId ? Store.getCase(cur.bumpsIntoId) : null;
    }
    if (cur && seen.has(cur.id)) anyCycle = true;   // walked back into an already-visited node
    return nodes;
  });

  // A pure cycle with no external root (A bumps B, B bumps A) has every
  // node counted as "bumped into" by someone else, so the root-finding
  // above never reaches it — it would otherwise vanish from this view
  // entirely instead of surfacing the cycle warning. Surface those nodes
  // explicitly as their own group.
  const cyclicOrphans = cases.filter(c => !included.has(c.id) && c.bumpsIntoId);
  if (cyclicOrphans.length) anyCycle = true;

  // Only show chains with at least one link, plus a note for standalone cases.
  const multi = chains.filter(n => n.length > 1);
  const singles = chains.filter(n => n.length === 1);

  let html = `<div class="toolbar">${eventFilterHTML()}</div>`;
  if (anyCycle) html += `<div class="form-warning form-error">⚠️ A bump cycle was detected (a chain loops back on itself) — check "Bumps Into" links for a mistaken circular reference.</div>`;
  if (cyclicOrphans.length) {
    html += `<div class="chain"><div class="chain-flow" style="flex-wrap:wrap;gap:12px;">
      ${cyclicOrphans.map(c => chainNode(c, false)).join('')}
    </div></div>`;
  }
  if (multi.length) {
    html += multi.map(nodes => `<div class="chain"><div class="chain-flow">
      ${nodes.map((c, i) => chainNode(c, i === nodes.length - 1, nodes[i - 1]) + (i < nodes.length - 1 ? '<div class="chain-arrow">→</div>' : '')).join('')}
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

function chainNode(c, isLast, prev) {
  const incomplete = isActive(c) && missingFields(c).length > 0;
  const flagged = c.electedOption === 'Bump Junior Employee' && (juniorViolation(c) || targetCasualTempViolation(c));
  const tail = isLast && isActive(c) && !c.bumpsIntoId && c.status !== 'Laid Off'
    ? `<div class="flag flag-warn" style="margin-top:6px;">chain end — undecided</div>` : '';
  let delta = '';
  if (prev && prev.seniorityHours !== '' && c.seniorityHours !== '' && prev.seniorityHours != null && c.seniorityHours != null) {
    const d = Number(c.seniorityHours) - Number(prev.seniorityHours);
    delta = `<div class="node-pos">${d <= 0 ? '' : '⚠ '}${d > 0 ? '+' : ''}${d} hrs</div>`;
  }
  return `<div class="chain-node ${incomplete ? 'node-incomplete' : ''} ${flagged ? 'node-incomplete' : ''}" data-edit="${c.id}" style="cursor:pointer;">
    <div class="node-name">${esc(c.name) || 'Unnamed'}</div>
    <div class="node-pos">${esc(c.position) || '—'}<br>${esc(c.site) || ''}</div>
    ${delta}
    ${statusBadge(c.status)}${flagged ? '<span class="flag">invalid bump</span>' : ''}${tail}
  </div>`;
}

/* ---------------- VACANCIES VIEW (MIG — travels with the seniority list) ---------------- */
function renderVacancies() {
  const rows = Store.vacancies.length
    ? Store.vacancies.map(v => `<tr>
        <td>${esc(v.position)}</td><td>${esc(v.site)}</td>
        <td>${v.postedDate ? fmtDate(v.postedDate) : '—'}</td>
        <td>${v.closingDate ? fmtDate(v.closingDate) : '—'}</td>
        <td class="muted">${esc(v.notes)}</td>
        <td><button class="btn btn-ghost btn-sm" data-del-vacancy="${v.id}">Delete</button></td>
      </tr>`).join('')
    : `<tr><td colspan="6"><div class="empty-state">No vacancies recorded yet. The MIG expects the vacancy list to go out with the seniority list — add them here so cases can reference "Post to Vacancy".</div></td></tr>`;

  return `
    <div class="quick-add">
      <div><label>Position</label><input type="text" id="v_position" placeholder="e.g. Housekeeping Aide" /></div>
      <div><label>Site</label><input type="text" id="v_site" placeholder="e.g. North Plant" /></div>
      <div><label>Posted Date</label><input type="date" id="v_postedDate" /></div>
      <div><label>Closing Date</label><input type="date" id="v_closingDate" /></div>
      <div><label>Notes</label><input type="text" id="v_notes" placeholder="optional" /></div>
      <button class="btn btn-primary btn-sm" id="btnAddVacancy">+ Add</button>
    </div>
    <table class="case-table">
      <thead><tr><th>Position</th><th>Site</th><th>Posted</th><th>Closes</th><th>Notes</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------------- SENIORITY VIEW ---------------- */
function renderSeniority() {
  if (!Store.seniority.length)
    return `<div class="empty-state">No seniority list loaded.<br><br>
      Click <strong>Upload Seniority List</strong> (top right) and choose an <strong>.xlsx</strong> or <strong>.csv</strong> file.<br>
      <span class="muted">Report titles above the header are skipped automatically. Columns are matched flexibly —
      e.g. “Last, First”/“Name”, “Job class”/“Position”, “Location”/“Site”, “Total Seniority”/“Total SEN…”/“Hours”,
      and (if present) Employee ID, Employment Status, Hire Date, Pay Rate.</span></div>`;

  const rows = Store.seniority.map(p => `<tr>
    <td>${esc(p.name)}</td><td>${esc(p.employeeId)}</td><td>${esc(p.site)}</td><td>${esc(p.position)}</td>
    <td>${esc(p.seniorityHours)}</td><td>${esc(p.employmentStatus)}</td><td>${p.hireDate ? fmtDate(p.hireDate) : '—'}</td>
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
      <thead><tr><th>Name</th><th>Employee ID</th><th>Site</th><th>Position</th><th>Seniority Hours</th><th>Employment Status</th><th>Hire Date</th></tr></thead>
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
    'seniority-clear': 'Seniority list cleared', 'vacancy-add': 'Vacancy added', 'vacancy-delete': 'Vacancy deleted',
    'data-import': 'Data imported from JSON backup',
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
  const dateFields = ['noticeDate', 'effectiveDate', 'leaveReturnDate', 'hireDate',
    'seniorityListProvidedDate', 'vacancyListProvidedDate', 'seniorityListReceiptConfirmedDate'];
  if (dateFields.includes(field) && v) return fmtDate(v);
  return v == null ? '' : String(v);
}

/* ---------------- SHARED RENDER HELPERS ---------------- */
function statusBadge(s) {
  const map = {
    'Notice Issued': 'badge-notice', 'List & Vacancies Provided': 'badge-listed',
    'Options Meeting Held': 'badge-meeting', 'Election Received': 'badge-election',
    'Placed': 'badge-placed', 'Laid Off': 'badge-laidoff', 'Recall Period': 'badge-recall', 'Closed': 'badge-closed',
  };
  return `<span class="badge ${map[s] || 'badge-notice'}">${esc(s)}</span>`;
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
  const optionOpts = ['<option value="">— none elected yet —</option>']
    .concat(CONFIG.OPTIONS.map(o => `<option value="${o.value}" ${c.electedOption === o.value ? 'selected' : ''}>${esc(o.label)}</option>`)).join('');
  // Existing cases (excluding self) selectable as an already-created bump target.
  const caseOpts = Store.cases.filter(x => x.id !== c.id)
    .map(x => `<option value="${x.id}" ${c.bumpsIntoId === x.id ? 'selected' : ''}>${esc(x.name)} — ${esc(x.position)}</option>`).join('');
  const receiptViaOpts = ['', 'Email', 'Signature', 'Meeting', 'Other']
    .map(v => `<option value="${v}" ${c.receiptConfirmedVia === v ? 'selected' : ''}>${v || '— select —'}</option>`).join('');
  const eventList = knownEventLabels();

  return `
    <div class="form-warning" id="formWarning" hidden></div>

    <div class="form-section-title">Identity</div>
    <div class="form-row autocomplete">
      <label>Name <span class="req">*</span></label>
      <input type="text" id="f_name" value="${esc(c.name)}" autocomplete="off" placeholder="Start typing — suggestions from seniority list" />
      <div class="autocomplete-list" id="nameAuto" hidden></div>
      <input type="hidden" id="f_employeeId" value="${esc(c.employeeId)}" />
      <div class="field-hint">Pick from the seniority list to auto-fill Site, Position, Hours, Status &amp; Hire Date.</div>
    </div>

    <div class="form-row two">
      <div><label>Site <span class="req">*</span></label><input type="text" id="f_site" value="${esc(c.site)}" /></div>
      <div><label>Position <span class="req">*</span></label><input type="text" id="f_position" value="${esc(c.position)}" /></div>
    </div>

    <div class="form-row two">
      <div><label>Seniority Hours <span class="req">*</span></label><input type="number" step="any" id="f_seniorityHours" value="${esc(c.seniorityHours)}" /></div>
      <div><label>Employment Status</label><input type="text" id="f_employmentStatus" value="${esc(c.employmentStatus)}" placeholder="Regular / Casual / Temporary" /></div>
    </div>

    <div class="form-row two">
      <div><label>Hire / Seniority Date</label><input type="date" id="f_hireDate" value="${esc(c.hireDate)}" />
        <div class="field-hint">Drives the scaled 13.4 notice period.</div></div>
      <div><label>Event / Restructuring <span class="muted">(optional grouping)</span></label>
        <input type="text" id="f_eventLabel" value="${esc(c.eventLabel)}" list="eventLabelSuggestions" placeholder="e.g. Sturgeon Place – Jul 2026" />
        <datalist id="eventLabelSuggestions">${eventList.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
      </div>
    </div>

    <div class="form-row">
      <label>Status</label><select id="f_status">${statusOpts}</select>
      <div class="field-hint" id="gateHint"></div>
    </div>

    ${snapshotPanelHTML(c)}

    <div class="form-section-title">Notice &amp; List Timeline</div>
    <div class="form-row two">
      <div><label>S.54 Notice Date <span class="req">*</span></label><input type="date" id="f_noticeDate" value="${esc(c.noticeDate)}" /></div>
      <div><label>Effective Date <span class="req">*</span></label><input type="date" id="f_effectiveDate" value="${esc(c.effectiveDate)}" /></div>
    </div>
    <div class="form-row two">
      <div><label>Seniority List Provided (11.2)</label><input type="date" id="f_seniorityListProvidedDate" value="${esc(c.seniorityListProvidedDate)}" /></div>
      <div><label>Vacancy List Provided</label><input type="date" id="f_vacancyListProvidedDate" value="${esc(c.vacancyListProvidedDate)}" /></div>
    </div>
    <div class="form-row two">
      <div><label>List Receipt Confirmed <span class="req">*</span></label><input type="date" id="f_seniorityListReceiptConfirmedDate" value="${esc(c.seniorityListReceiptConfirmedDate)}" />
        <div class="field-hint">The REAL 7-day clock start (13.3) — not the notice date.</div></div>
      <div><label>Receipt Confirmed Via</label><select id="f_receiptConfirmedVia">${receiptViaOpts}</select></div>
    </div>
    <div class="form-row two">
      <div>
        <label>7-Day Decision Deadline (auto)</label>
        <input type="text" id="f_deadline" value="" readonly style="background:#f0f4f8;" />
        <div class="field-hint computed" id="deadlineHint"></div>
      </div>
      <div>
        <label>13.4 Notice Period Ends (auto)</label>
        <input type="text" id="f_noticePeriodEnd" value="" readonly style="background:#f0f4f8;" />
        <div class="field-hint computed" id="noticePeriodHint"></div>
      </div>
    </div>
    <div class="form-row">
      <label>13.5 Recall Expiry, if Laid Off (auto)</label>
      <input type="text" id="f_recallExpiry" value="" readonly style="background:#f0f4f8;" />
      <div class="field-hint computed" id="recallHint"></div>
    </div>

    <div class="form-row checkbox-row">
      <input type="checkbox" id="f_stewardPresent" ${c.stewardPresent ? 'checked' : ''} />
      <label for="f_stewardPresent">Union steward present at options meeting (13.2(b))</label>
    </div>
    <div class="form-row">
      <label>Union Notified At <span class="muted">(13.2(c) — required within 24h if this results in layoff)</span></label>
      <input type="datetime-local" id="f_unionNotifiedAt" value="${esc(toDatetimeLocal(c.unionNotifiedAt))}" />
    </div>

    <div class="form-section-title">Leave of Absence</div>
    <div class="form-row checkbox-row">
      <input type="checkbox" id="f_onLeave" ${c.onLeave ? 'checked' : ''} />
      <label for="f_onLeave">Staff member is currently on a leave of absence</label>
    </div>
    <div class="form-row two" id="leaveFields" ${c.onLeave ? '' : 'hidden'}>
      <div><label>Expected Return Date <span class="req">*</span></label><input type="date" id="f_leaveReturnDate" value="${esc(c.leaveReturnDate)}" /></div>
      <div><label>Leave Type <span class="muted">(optional)</span></label><input type="text" id="f_leaveType" value="${esc(c.leaveType)}" placeholder="e.g. Medical, Parental, WCB" /></div>
    </div>
    <div class="form-warning" id="leaveWarning" hidden></div>

    <div class="form-section-title">Decision &amp; Election</div>
    <div class="form-row checkbox-row">
      <input type="checkbox" id="f_decisionMade" ${c.decisionMade ? 'checked' : ''} />
      <label for="f_decisionMade">Decision made</label>
      ${c.decisionMade && c.decisionMadeAt ? `<span class="field-hint" style="margin:0 0 0 8px;">recorded ${esc(fmtDateTime(c.decisionMadeAt))}</span>` : ''}
    </div>

    <div class="form-row">
      <label>Elected Option</label>
      <select id="f_electedOption">${optionOpts}</select>
    </div>

    <div id="optionFields">${optionFieldsHTML(c)}</div>

    <div class="form-row">
      <label>Notes</label>
      <textarea id="f_notes" rows="2">${esc(c.notes)}</textarea>
    </div>

    ${editingId ? documentButtonsHTML() : ''}
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

// Renders the fields specific to whichever option is currently selected
// (or blank when no option — or a non-bump option with no extra fields —
// is elected). Re-rendered live as the operator changes the select.
function optionFieldsHTML(c) {
  if (c.electedOption === 'Post to Vacancy') {
    return `<div class="subfields">
      <div class="form-row"><label>Vacancy Position <span class="req">*</span></label>
        <input type="text" id="f_vacancyPosition" value="${esc(c.vacancyPosition)}" placeholder="Which posted vacancy (12.3)" /></div>
    </div>`;
  }
  if (c.electedOption === 'Bump Junior Employee') {
    return `<div class="subfields">
      <div class="form-row autocomplete">
        <label>Bumps Into <span class="muted">(creates the next case automatically)</span> <span class="req">*</span></label>
        <input type="text" id="f_bumpsInto" autocomplete="off" placeholder="Type a name from the seniority list…" value="${esc(c.bumpsIntoId && Store.getCase(c.bumpsIntoId) ? Store.getCase(c.bumpsIntoId).name : '')}" />
        <div class="autocomplete-list" id="bumpAuto" hidden></div>
        <input type="hidden" id="f_bumpsIntoId" value="${esc(c.bumpsIntoId)}" />
        ${Store.cases.filter(x => x.id !== c.id).length ? `<div class="field-hint">…or link an existing case:
          <select id="f_bumpExisting"><option value="">— none —</option>${Store.cases.filter(x => x.id !== c.id).map(x => `<option value="${x.id}" ${c.bumpsIntoId === x.id ? 'selected' : ''}>${esc(x.name)} — ${esc(x.position)}</option>`).join('')}</select></div>` : ''}
        <div class="field-hint">Selecting someone here records the domino: this person → that person.</div>
        <div id="eligibleTargets"></div>
      </div>
      <div class="form-row two">
        <div><label>Ability Assessed By</label><input type="text" id="f_abilityAssessedBy" value="${esc(c.abilityAssessedBy)}" placeholder="Who assessed ability to perform" /></div>
        <div><label>Assessment Basis</label><input type="text" id="f_abilityAssessmentBasis" value="${esc(c.abilityAssessmentBasis)}" placeholder="On what basis (e.g. skills matrix, trial shift)" /></div>
      </div>
    </div>`;
  }
  if (c.electedOption === 'Transfer to Casual') {
    return `<div class="subfields"><div class="field-hint">Transfer to casual (29.7) — no additional fields required.</div></div>`;
  }
  if (c.electedOption === 'Voluntary Layoff') {
    return `<div class="subfields">
      <div class="form-row checkbox-row">
        <input type="checkbox" id="f_electsCasualRegistration" ${c.electsCasualRegistration ? 'checked' : ''} />
        <label for="f_electsCasualRegistration">Elects casual registration during recall</label>
      </div>
    </div>`;
  }
  if (c.electedOption === 'Apply to Other Posting') {
    return `<div class="subfields">
      <div class="form-row"><label>Other Posting Details <span class="req">*</span></label>
        <textarea id="f_otherPostingDetails" rows="2">${esc(c.otherPostingDetails)}</textarea></div>
    </div>`;
  }
  return '';
}

function documentButtonsHTML() {
  return `<div class="form-row">
    <label>Generate Documents <span class="muted">(draft — review before sending)</span></label>
    <div class="form-actions" style="border-top:none;padding-top:0;margin-top:0;">
      <div class="right" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost btn-sm" id="btnGenLetter">Displacement Letter</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btnGenUnionNotice">Union Notification Email</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btnPrintCaseFile">Printable Case File</button>
      </div>
    </div>
  </div>`;
}

/* Seniority snapshot panel: shows the frozen record, or offers to capture one. */
function snapshotPanelHTML(c) {
  if (c.senioritySnapshot) {
    const s = c.senioritySnapshot;
    return `<div class="snapshot-panel ok">
      <div class="snapshot-title">📌 Seniority snapshot on record</div>
      <div class="snapshot-body">${esc(s.name)} — ${esc(s.position) || 'no position'}, ${esc(s.site) || 'no site'}, <strong>${esc(s.seniorityHours) || '—'}h</strong>${s.employmentStatus ? `, ${esc(s.employmentStatus)}` : ''}
      <br><span class="muted">Captured ${esc(fmtDateTime(s.capturedAt))}${s.listUploadedAt ? ` · from list loaded ${esc(fmtDateTime(s.listUploadedAt))}` : ''}.</span></div>
      <button type="button" class="btn btn-ghost btn-sm" id="btnReSnapshot">Refresh from current list</button>
    </div>`;
  }
  const canCapture = Store.seniority.length > 0;
  return `<div class="snapshot-panel warn">
    <div class="snapshot-title">⚠️ No seniority snapshot</div>
    <div class="snapshot-body muted">A snapshot freezes this employee's seniority as it stands when captured — your defensible record of what the list showed at that point. ${canCapture ? 'Click below (or pick the name from the list) to capture it.' : 'Upload a seniority list first to enable this.'}</div>
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
  const electedOption = val('f_electedOption');
  return {
    name: val('f_name').trim(),
    employeeId: val('f_employeeId').trim(),
    site: val('f_site').trim(),
    position: val('f_position').trim(),
    seniorityHours: val('f_seniorityHours').trim(),
    employmentStatus: val('f_employmentStatus').trim(),
    hireDate: val('f_hireDate'),
    eventLabel: val('f_eventLabel').trim(),
    noticeDate: val('f_noticeDate'),
    effectiveDate: val('f_effectiveDate'),
    seniorityListProvidedDate: val('f_seniorityListProvidedDate'),
    vacancyListProvidedDate: val('f_vacancyListProvidedDate'),
    seniorityListReceiptConfirmedDate: val('f_seniorityListReceiptConfirmedDate'),
    receiptConfirmedVia: val('f_receiptConfirmedVia'),
    stewardPresent: document.getElementById('f_stewardPresent').checked,
    unionNotifiedAt: fromDatetimeLocal(val('f_unionNotifiedAt')),
    onLeave: document.getElementById('f_onLeave').checked,
    leaveReturnDate: val('f_leaveReturnDate'),
    leaveType: val('f_leaveType').trim(),
    decisionMade: document.getElementById('f_decisionMade').checked,
    electedOption,
    vacancyPosition: elVal('f_vacancyPosition').trim(),
    electsCasualRegistration: !!(document.getElementById('f_electsCasualRegistration') && document.getElementById('f_electsCasualRegistration').checked),
    otherPostingDetails: elVal('f_otherPostingDetails').trim(),
    bumpsIntoId: elVal('f_bumpsIntoId'),
    abilityAssessedBy: elVal('f_abilityAssessedBy').trim(),
    abilityAssessmentBasis: elVal('f_abilityAssessmentBasis').trim(),
    status: val('f_status'),
    notes: val('f_notes').trim(),
  };
}
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
// Like val(), but safe for fields that only exist for some elected options.
function elVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocal(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}

function updateComputed() {
  const notice = val('f_noticeDate');
  const receipt = val('f_seniorityListReceiptConfirmedDate');
  // 7-day decision deadline (from CONFIRMED RECEIPT, per 13.3).
  setDeadlineField('f_deadline', 'deadlineHint', addDays(receipt, CONFIG.DECISION_WINDOW_DAYS));
  // 13.4 scaled notice period end.
  const provisional = Object.assign({}, readForm());
  const npEnd = noticePeriodEndDate(provisional);
  setDeadlineField('f_noticePeriodEnd', 'noticePeriodHint', npEnd, !provisional.hireDate ? 'Hire date needed to compute' : '');
  // 13.5 recall expiry (only meaningful once Laid Off, but shown for planning).
  const recall = recallExpiryDate(provisional);
  setDeadlineField('f_recallExpiry', 'recallHint', recall, !provisional.hireDate ? 'Hire date needed to compute' : '');
  updateLeaveWarning();
  updateEligibleTargets();
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

// Eligible-target finder: shown only while "Bump Junior Employee" is elected.
function updateEligibleTargets() {
  const host = document.getElementById('eligibleTargets');
  if (!host) return;
  const bumper = readForm();
  if (bumper.electedOption !== 'Bump Junior Employee') { host.innerHTML = ''; return; }
  const targets = eligibleBumpTargets(bumper);
  if (!targets.length) {
    host.innerHTML = `<div class="field-hint">No eligible junior/Regular targets found in the loaded seniority list.</div>`;
    return;
  }
  host.innerHTML = `<div class="field-hint">Eligible targets (more junior, Regular, ranked by closest seniority) — ability review is still required for every candidate:</div>
    <div class="target-list">
      ${targets.map(t => `<div class="target-item ${t.alreadyTargeted ? 'target-flagged' : ''}" data-pick-target="${esc(t.name)}">
        <span>${esc(t.name)} <span class="muted">— ${esc(t.position) || 'no position'}, ${esc(t.site) || 'no site'}</span>${t.alreadyTargeted ? ' <span class="flag">already targeted</span>' : ''}</span>
        <span class="delta">${t.delta !== null ? (t.delta + ' hrs') : (t.seniorityHours || '—')}</span>
      </div>`).join('')}
    </div>`;
}

function setDeadlineField(inputId, hintId, dl, overrideHint) {
  const input = document.getElementById(inputId);
  const hint = document.getElementById(hintId);
  if (!input || !hint) return;
  if (dl) {
    input.value = fmtDate(dl);
    const d = daysUntil(dl);
    hint.textContent = d < 0 ? `${Math.abs(d)} day(s) ago` : `${d} day(s) remaining`;
    hint.style.color = d < 0 ? 'var(--danger)' : 'var(--teal-dark)';
  } else {
    input.value = overrideHint || '—';
    hint.textContent = '';
  }
}

/* Project the form's effect on save: attaches the resolved bump target (if
   any) onto the object so gates/validators can evaluate junior/casual-temp
   checks BEFORE the domino auto-create runs. Used for gate evaluation. */
function projectedCase(data) {
  const p = Object.assign({}, data);
  if (p.electedOption === 'Bump Junior Employee') {
    const t = resolveTypedBumpTarget();
    p._target = t;
    if (t) p.bumpsIntoId = t.id || 'pending';
  } else {
    p._target = null;
  }
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

  // ---- ENFORCEMENT 2: an invalid bump BLOCKS the save outright ----
  const blockers = bumpBlockers(data);
  if (blockers.length) {
    warn.hidden = false;
    warn.className = 'form-warning form-error';
    warn.innerHTML = `⛔ Cannot save this bump:<ul style="margin:6px 0 0 18px;padding:0;">${blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
    return;
  }

  // ---- ENFORCEMENT 3: status gates BLOCK advancing without data ----
  // Gate against the PROJECTED state: an elected bump will, on save, set
  // bumpsIntoId (see handleBumpLink), so count it now.
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
  if (stagedSnapshot) target.senioritySnapshot = stagedSnapshot;
  else if (!target.senioritySnapshot) {
    const auto = captureSnapshot(target.name, target.employeeId);
    if (auto) target.senioritySnapshot = auto;
  }

  target.updatedAt = new Date().toISOString();

  // ---- AUTO CHAIN CREATION ----
  handleBumpLink(target, data);

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

/* Ensure target.bumpsIntoId points at a real case, creating one if needed.
   Only applies when "Bump Junior Employee" was elected — unlike the old
   behaviour, this does NOT force the status to a completed state: electing
   to bump someone is not, by itself, a decided/placed case. The operator
   confirms "Decision made" and advances status explicitly. */
function handleBumpLink(target, data) {
  if (data.electedOption !== 'Bump Junior Employee') {
    if (target.bumpsIntoId && !Store.getCase(target.bumpsIntoId)) target.bumpsIntoId = '';
    return;
  }
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
      const sen = findSeniorityPerson({ name: typedName });
      bumped = newCase({
        name: typedName,
        site: sen ? sen.site : '',
        position: sen ? sen.position : '',
        seniorityHours: sen ? sen.seniorityHours : '',
        employmentStatus: sen ? sen.employmentStatus : '',
        hireDate: sen ? sen.hireDate : '',
        employeeId: sen ? sen.employeeId : '',
        payRate: sen ? sen.payRate : '',
        eventLabel: target.eventLabel,
        status: 'Notice Issued',   // they now start their own S.54 process
        senioritySnapshot: captureSnapshot(typedName, sen ? sen.employeeId : ''),
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
    const snap = captureSnapshot(val('f_name').trim(), val('f_employeeId').trim());
    if (!snap) { alert('No matching name in the current seniority list — cannot capture a snapshot.'); return; }
    pendingSnapshot = snap;
    toast('Snapshot staged — saves with the case');
    const panel = document.querySelector('.snapshot-panel');
    if (panel) {
      panel.outerHTML = snapshotPanelHTML(Object.assign({}, readForm(), { senioritySnapshot: snap }));
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
      `<div class="autocomplete-item" data-name="${esc(p.name)}">${esc(p.name)} <small>— ${esc(p.position) || 'no position'}, ${esc(p.site) || 'no site'}${p.seniorityHours ? ', ' + esc(p.seniorityHours) + 'h' : ''}${p.employmentStatus ? ', ' + esc(p.employmentStatus) : ''}</small></div>`
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
   DOCUMENT GENERATION  (drafts only — merge fields from the case object)
   ============================================================ */
function openGeneratedDoc(html) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const DOC_DISCLAIMER = `<div style="background:#fdf6e3;border:1px solid #f0e0b8;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:24px;">⚠️ Draft generated from case data — review for accuracy and required legal/contract language before sending. Not legal advice.</div>`;
const DOC_STYLE = `body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:40px auto;line-height:1.6;color:#222;padding:0 20px;} h1{font-size:18px;} table{border-collapse:collapse;width:100%;} td,th{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:13px;} @media print { button, .no-print { display:none; } }`;

function electedOptionSummary(c) {
  if (!c.electedOption) return '[no option elected yet]';
  if (c.electedOption === 'Bump Junior Employee') return `Bump Junior Employee${c.bumpsIntoId ? ' — displacing ' + caseName(c.bumpsIntoId) : ''}`;
  if (c.electedOption === 'Post to Vacancy') return `Post to Vacancy${c.vacancyPosition ? ' — ' + c.vacancyPosition : ''}`;
  if (c.electedOption === 'Voluntary Layoff') return `Voluntary Layoff${c.electsCasualRegistration ? ' (elects casual registration during recall)' : ''}`;
  if (c.electedOption === 'Apply to Other Posting') return `Apply to Other Posting${c.otherPostingDetails ? ' — ' + c.otherPostingDetails : ''}`;
  return c.electedOption;
}

function generateLetterHTML(c) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Displacement Letter — ${esc(c.name)}</title><style>${DOC_STYLE}</style></head><body>
    ${DOC_DISCLAIMER}
    <p>${esc(fmtDate(today()))}</p>
    <p>Dear ${esc(c.name)},</p>
    <p>This letter confirms that, effective <strong>${esc(fmtDate(c.effectiveDate))}</strong>, your position as ${esc(c.position) || '[position]'} at ${esc(c.site) || '[site]'} is affected under Article 13 (Section 54) of the Collective Agreement, further to the notice provided on ${esc(fmtDate(c.noticeDate))}.</p>
    <p>Per the options meeting${c.stewardPresent ? ' (held with your union steward present)' : ''}, you have elected: <strong>${esc(electedOptionSummary(c))}</strong>.</p>
    <p>Your notice period under Article 13.4, scaled to your years of service, ends on <strong>${esc(fmtDate(noticePeriodEndDate(c)) || '[unknown — hire date not on file]')}</strong>.</p>
    ${(c.status === 'Laid Off' || c.status === 'Recall Period') ? `<p>Your recall period under Article 13.5 extends to <strong>${esc(fmtDate(recallExpiryDate(c)) || '[unknown]')}</strong>.</p>` : ''}
    <p>Please contact Labour Relations with any questions.</p>
    <p>Sincerely,<br>HR / Labour Relations</p>
    <button onclick="window.print()">Print</button>
  </body></html>`;
}

function generateUnionNoticeHTML(c) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Union Notification — ${esc(c.name)}</title><style>${DOC_STYLE}</style></head><body>
    ${DOC_DISCLAIMER}
    <p><strong>To:</strong> BCGEU Representative<br><strong>Re:</strong> Article 13.2(c) notification of layoff</p>
    <p>This confirms notice of layoff for the following employee:</p>
    <table>
      <tr><th>Name</th><td>${esc(c.name)}</td></tr>
      <tr><th>Employee ID</th><td>${esc(c.employeeId) || '—'}</td></tr>
      <tr><th>Position</th><td>${esc(c.position) || '—'}</td></tr>
      <tr><th>Site</th><td>${esc(c.site) || '—'}</td></tr>
      <tr><th>S.54 Notice Date</th><td>${esc(fmtDate(c.noticeDate))}</td></tr>
      <tr><th>Effective Date</th><td>${esc(fmtDate(c.effectiveDate))}</td></tr>
      <tr><th>Notice Period Ends (13.4)</th><td>${esc(fmtDate(noticePeriodEndDate(c)) || '—')}</td></tr>
      <tr><th>Recall Expiry (13.5)</th><td>${esc(fmtDate(recallExpiryDate(c)) || '—')}</td></tr>
    </table>
    <p>Please confirm receipt of this notification.</p>
    <p>Regards,<br>HR / Labour Relations</p>
    <button onclick="window.print()">Print</button>
  </body></html>`;
}

function generateCaseFileHTML(c) {
  const rows = [
    ['Name', c.name], ['Employee ID', c.employeeId], ['Site', c.site], ['Position', c.position],
    ['Seniority Hours', c.seniorityHours], ['Employment Status', c.employmentStatus], ['Hire Date', fmtDate(c.hireDate)],
    ['Event / Restructuring', c.eventLabel], ['Status', c.status],
    ['S.54 Notice Date', fmtDate(c.noticeDate)], ['Effective Date', fmtDate(c.effectiveDate)],
    ['Seniority List Provided', fmtDate(c.seniorityListProvidedDate)], ['Vacancy List Provided', fmtDate(c.vacancyListProvidedDate)],
    ['List Receipt Confirmed', fmtDate(c.seniorityListReceiptConfirmedDate)], ['Receipt Confirmed Via', c.receiptConfirmedVia],
    ['7-Day Decision Deadline', fmtDate(decisionDeadline(c))],
    ['Notice Period Ends (13.4)', fmtDate(noticePeriodEndDate(c))], ['Recall Expiry (13.5)', fmtDate(recallExpiryDate(c))],
    ['Steward Present (13.2(b))', c.stewardPresent ? 'Yes' : 'No'], ['Union Notified At (13.2(c))', fmtDateTime(c.unionNotifiedAt)],
    ['On Leave', c.onLeave ? 'Yes' : 'No'], ['Leave Return Date', fmtDate(c.leaveReturnDate)], ['Leave Type', c.leaveType],
    ['Elected Option', electedOptionSummary(c)],
    ['Ability Assessed By', c.abilityAssessedBy], ['Ability Assessment Basis', c.abilityAssessmentBasis],
    ['Decision Made', c.decisionMade ? 'Yes' : 'No'], ['Decision Timestamp', fmtDateTime(c.decisionMadeAt)],
    ['Notes', c.notes],
  ];
  const history = Store.audit.filter(a => a.caseId === c.id).map(a =>
    `<li>${esc(fmtDateTime(a.at))} — ${esc(a.details || a.action)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Case File — ${esc(c.name)}</title><style>${DOC_STYLE}</style></head><body>
    <h1>Case File — ${esc(c.name)}</h1>
    <table>${rows.map(([k, v]) => `<tr><th style="width:220px;">${esc(k)}</th><td>${esc(v) || '—'}</td></tr>`).join('')}</table>
    <h1 style="margin-top:24px;">Audit History</h1>
    <ul>${history || '<li>No audit entries.</li>'}</ul>
    <button onclick="window.print()">Print</button>
  </body></html>`;
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wireFormEvents(c) {
  pendingSnapshot = null;
  document.getElementById('btnCancel').addEventListener('click', closeCaseForm);
  document.getElementById('caseForm').addEventListener('submit', saveCase);
  ['f_noticeDate', 'f_seniorityListReceiptConfirmedDate', 'f_hireDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateComputed);
  });
  const del = document.getElementById('btnDelete');
  if (del) del.addEventListener('click', deleteCase);

  // Live status-gate feedback as the operator changes status/decision/outcome.
  ['f_status', 'f_decisionMade'].forEach(id => {
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

  // Elected option: swap in the option-specific sub-fields and re-wire them.
  const optionEl = document.getElementById('f_electedOption');
  if (optionEl) optionEl.addEventListener('change', () => {
    const data = readForm();
    document.getElementById('optionFields').innerHTML = optionFieldsHTML(data);
    wireOptionSubfields();
    updateGateHint();
  });
  wireOptionSubfields();

  // Delegated clicks for dynamically-rendered buttons/lists inside the form.
  document.getElementById('caseForm').addEventListener('click', e => {
    if (e.target && e.target.id === 'btnUseReturnDate') {
      document.getElementById('f_effectiveDate').value = val('f_leaveReturnDate');
      updateLeaveWarning();
      updateGateHint();
    }
    const pick = e.target.closest && e.target.closest('[data-pick-target]');
    if (pick) {
      const name = pick.dataset.pickTarget;
      const bumpsInto = document.getElementById('f_bumpsInto');
      if (bumpsInto) {
        bumpsInto.value = name;
        document.getElementById('f_bumpsIntoId').value = '';
        const sel = document.getElementById('f_bumpExisting');
        if (sel) sel.value = '';
        updateGateHint();
      }
    }
    if (e.target && e.target.id === 'btnGenLetter') openGeneratedDoc(generateLetterHTML(Object.assign({}, Store.getCase(editingId), readForm())));
    if (e.target && e.target.id === 'btnGenUnionNotice') openGeneratedDoc(generateUnionNoticeHTML(Object.assign({}, Store.getCase(editingId), readForm())));
    if (e.target && e.target.id === 'btnPrintCaseFile') openGeneratedDoc(generateCaseFileHTML(Object.assign({}, Store.getCase(editingId), readForm())));
  });

  // Capture / refresh the seniority snapshot from the current list.
  wireSnapshotButton();

  // Name autocomplete → auto-fill site/position/hours/status/hire date/id.
  attachAutocomplete('f_name', 'nameAuto', person => {
    document.getElementById('f_name').value = person.name;
    document.getElementById('f_employeeId').value = person.employeeId || '';
    if (!val('f_site')) document.getElementById('f_site').value = person.site || '';
    if (!val('f_position')) document.getElementById('f_position').value = person.position || '';
    if (!val('f_seniorityHours')) document.getElementById('f_seniorityHours').value = person.seniorityHours || '';
    if (!val('f_employmentStatus')) document.getElementById('f_employmentStatus').value = person.employmentStatus || '';
    if (!val('f_hireDate') && person.hireDate) document.getElementById('f_hireDate').value = person.hireDate;
    updateComputed();
  });
}

// Wires the Bumps Into autocomplete + eligible-target list + existing-case
// dropdown. Called on initial render and again whenever the elected-option
// sub-fields are swapped in (since those elements only exist conditionally).
function wireOptionSubfields() {
  attachAutocomplete('f_bumpsInto', 'bumpAuto', person => {
    document.getElementById('f_bumpsInto').value = person.name;
    document.getElementById('f_bumpsIntoId').value = '';
    const sel = document.getElementById('f_bumpExisting');
    if (sel) sel.value = '';
    updateEligibleTargets();
    updateGateHint();
  });

  const bumpsInto = document.getElementById('f_bumpsInto');
  if (bumpsInto) bumpsInto.addEventListener('input', () => {
    document.getElementById('f_bumpsIntoId').value = '';
    updateGateHint();
  });

  const existing = document.getElementById('f_bumpExisting');
  if (existing) existing.addEventListener('change', () => {
    document.getElementById('f_bumpsIntoId').value = existing.value;
    const linked = existing.value ? Store.getCase(existing.value) : null;
    document.getElementById('f_bumpsInto').value = linked ? linked.name : '';
    updateGateHint();
  });

  ['f_vacancyPosition', 'f_otherPostingDetails', 'f_electsCasualRegistration', 'f_abilityAssessedBy', 'f_abilityAssessmentBasis'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', updateGateHint);
  });

  updateEligibleTargets();
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
  const eventFilter = document.getElementById('eventFilter');
  if (eventFilter) eventFilter.addEventListener('change', () => {
    App.eventFilter = eventFilter.value;
    render();
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

  // Vacancies CRUD.
  const addVacancy = document.getElementById('btnAddVacancy');
  if (addVacancy) addVacancy.addEventListener('click', () => {
    const position = val('v_position').trim();
    if (!position) { alert('Position is required.'); return; }
    const vac = {
      id: 'V' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      position, site: val('v_site').trim(), postedDate: val('v_postedDate'), closingDate: val('v_closingDate'),
      notes: val('v_notes').trim(), createdAt: new Date().toISOString(),
    };
    Store.vacancies.push(vac);
    Store.saveVacancies();
    recordAudit('vacancy-add', null, [], `Vacancy added: ${vac.position}${vac.site ? ' — ' + vac.site : ''}`);
    render();
    toast('Vacancy added');
  });
  document.querySelectorAll('[data-del-vacancy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.delVacancy;
      const v = Store.vacancies.find(x => x.id === id);
      Store.vacancies = Store.vacancies.filter(x => x.id !== id);
      Store.saveVacancies();
      recordAudit('vacancy-delete', null, [], `Vacancy deleted: ${v ? v.position : id}`);
      render();
      toast('Vacancy deleted');
    });
  });
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

/* Whole-database JSON export/import (cases, seniority, audit, vacancies) —
   localStorage-only means a browser wipe would otherwise be unrecoverable. */
function exportAllData() {
  const json = JSON.stringify(Store.exportAll(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `s54-tracker-backup-${today()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Data exported');
}
async function importAllData(file) {
  if (!confirm('Import will REPLACE all current cases, seniority data, vacancies, and audit log with the contents of this file. Continue?')) return;
  try {
    const data = JSON.parse(await file.text());
    Store.importAll(data);
    recordAudit('data-import', null, [], `Imported from "${file.name}"`);
    toast('Data imported');
    render();
  } catch (err) {
    alert('Could not import "' + file.name + '":\n\n' + err.message);
  }
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

  // Whole-database export/import.
  document.getElementById('btnExportData').addEventListener('click', exportAllData);
  document.getElementById('btnImportData').addEventListener('click', () => document.getElementById('importDataFile').click());
  document.getElementById('importDataFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importAllData(file);
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
