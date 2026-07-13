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
  });

  assert.strictEqual(cleanHours('1,234.567'), '1234.57');
  assert.strictEqual(cleanHours('not available'), 'not available');

  assert.deepStrictEqual(
    statusGateMissing({ decisionMade: true, optionChosen: '', bumpsIntoId: '', onLeave: false, effectiveDate: '', leaveReturnDate: '' }, 'Laid Off'),
    ['resolution']
  );
  assert.deepStrictEqual(
    statusGateMissing({ decisionMade: true, optionChosen: 'Accept layoff', bumpsIntoId: '', onLeave: false, effectiveDate: '', leaveReturnDate: '' }, 'Laid Off'),
    []
  );

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
