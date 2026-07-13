const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const appCode = fs.readFileSync('public/app.js', 'utf8');
const pureCode = appCode.slice(0, appCode.indexOf('/* ============================================================\n   BOOTSTRAP'));

const harness = `
(function runTests() {
  const csvRows = parseCSV('Name,Site,Position,Seniority Hours\\n"Doe, Jane",Main,"Role, Senior","1,234"\\n\\n');
  assert.deepStrictEqual(csvRows, [
    ['Name', 'Site', 'Position', 'Seniority Hours'],
    ['Doe, Jane', 'Main', 'Role, Senior', '1,234'],
  ]);

  const seniorityCsv = parseCSV(sampleSeniority);
  const seniority = rowsToSeniority(seniorityCsv);
  assert.strictEqual(seniority.length, 8);
  assert.deepStrictEqual(seniority[0], {
    name: 'Alice Johnson',
    site: 'North Plant',
    position: 'Senior Machinist',
    seniorityHours: '18450',
    employeeId: '',
    employmentStatus: '',
    hireDate: '',
    payRate: '',
  });

  // Optional columns (employeeId / employmentStatus / hireDate / payRate)
  // are captured when present, and degrade to '' when absent — a report
  // missing them must never hard-fail the import.
  const extendedRows = parseCSV(
    'Name,Employee ID,Site,Position,Seniority Hours,Employment Status,Hire Date\\n' +
    'Dave Casual,E004,North Plant,General Labourer,3000,Casual,2023-01-01\\n'
  );
  const extended = rowsToSeniority(extendedRows);
  assert.strictEqual(extended[0].employeeId, 'E004');
  assert.strictEqual(extended[0].employmentStatus, 'Casual');
  assert.strictEqual(extended[0].hireDate, '2023-01-01');

  assert.strictEqual(cleanHours('1,234.567'), '1234.57');
  assert.strictEqual(cleanHours('not available'), 'not available');

  // --- Status gates (real 8-stage affiliate lifecycle, not the old 4-state model) ---
  assert.deepStrictEqual(
    statusGateMissing({ decisionMade: false, electedOption: '', bumpsIntoId: '', onLeave: false, effectiveDate: '', leaveReturnDate: '', hireDate: '', noticeDate: '' }, 'Laid Off'),
    ['decisionMade']
  );
  assert.deepStrictEqual(
    statusGateMissing({ decisionMade: true, electedOption: '', bumpsIntoId: '', onLeave: false, effectiveDate: '', leaveReturnDate: '', hireDate: '', noticeDate: '' }, 'Laid Off'),
    []
  );

  // --- Bump-validity: junior test and casual/temp block ---
  const bumper = { id: 'B', name: 'Alice', seniorityHours: '18450', electedOption: 'Bump Junior Employee' };
  const seniorTarget = { id: 'T', name: 'Erin', seniorityHours: '21300', employmentStatus: 'Regular' };
  assert.strictEqual(juniorViolation(Object.assign({}, bumper, { _target: seniorTarget })), true, 'bumping a MORE senior target should violate the junior test');
  const juniorTarget = { id: 'T2', name: 'Bob', seniorityHours: '14200', employmentStatus: 'Regular' };
  assert.strictEqual(juniorViolation(Object.assign({}, bumper, { _target: juniorTarget })), false, 'bumping a genuinely junior target should be valid');
  const casualTarget = { id: 'T3', name: 'Dave', seniorityHours: '3000', employmentStatus: 'Casual' };
  assert.strictEqual(targetCasualTempViolation(Object.assign({}, bumper, { _target: casualTarget })), true, 'a Casual target should never be a valid bump target');

  // --- 13.4 scaled notice period ---
  assert.strictEqual(noticePeriodWeeks({ hireDate: '2015-06-01', noticeDate: '2026-01-10' }), 8, 'long-service employee should be capped at 8 weeks');
  assert.strictEqual(noticePeriodWeeks({ hireDate: '2024-06-01', noticeDate: '2026-01-10' }), 4, 'short-service (post-probation, <3yr) employee should get the 4-week base');
  assert.strictEqual(noticePeriodWeeks({ hireDate: '', noticeDate: '2026-01-10' }), null, 'unknown hire date must not be treated as a violation');

  // --- Snapshot rename migration (safety net for pre-rename browser data) ---
  Store.cases = [{ id: 'C1', seniaritySnapshot: { name: 'Legacy Person' } }];
  Store.migrateCases();
  assert.deepStrictEqual(Store.cases[0].senioritySnapshot, { name: 'Legacy Person' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Store.cases[0], 'seniaritySnapshot'), false);
})();
`;

const context = {
  assert,
  sampleSeniority: fs.readFileSync('public/sample-seniority.csv', 'utf8'),
  console,
  localStorage: { setItem() {}, getItem() { return null; } },
};
vm.createContext(context);
vm.runInContext(`${pureCode}\n${harness}`, context, { filename: 'app-test-harness.js' });
console.log('All tests passed');
