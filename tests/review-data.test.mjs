import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyRemovals, buildCandidate, buildInventory, candidateLabels,
  createTasks, finalize, findRuleMentions, isAutomaticCopy, prepare, reviewIsCurrent, safeDestination, slug, sourceTimestamp,
  uncertaintyMarkdown, updateUncertaintyList, validateResult } from '../scripts/review-data.mjs';

test('automatic copy classifies selection and explicit guides, not marker rules or operative names', () => {
  assert.equal(isAutomaticCopy({ category: 'operatives_selection', name: 'Selection', raw: {} }), true);
  assert.equal(isAutomaticCopy({ category: 'faction_rules', name: 'Tokens and Markers', raw: {} }), true);
  assert.equal(isAutomaticCopy({ category: 'faction_rules', name: 'Reference', raw: { card_type: 'Token Marker Guide' } }), true);
  assert.equal(isAutomaticCopy({ category: 'faction_rules', name: 'Markerlights', raw: {} }), false);
  assert.equal(isAutomaticCopy({ category: 'datacards', name: 'SPECTRE GUIDE', raw: {} }), false);
  assert.equal(isAutomaticCopy({ category: 'datacards', name: 'MV7 MARKER DRONE', raw: {} }), false);
});

test('one current uncertainty list replaces only reviewed cards and retains open entry numbers', () => {
  const records = ['one', 'two', 'three'].map((id) => ({ id, team: 'team', name: id, pointer: '/cards/0',
    raw: { name: id, description: 'Original text.' }, sourceUpdatedAt: timestamp,
    segments: [{ pointer: '/cards/0/description', text: 'Original text.' }] }));
  const issue = id => ({ id, team: 'team', pointer: '/cards/0/description', notes: ['Needs weapon-rule review.'], decisions: [] });
  const report = { policyVersion: 1, runId: 'first', uncertainties: [issue('one'), issue('two')] };
  const original = updateUncertaintyList(null, report, records);
  const before = structuredClone(original);
  const retry = { policyVersion: 3, runId: 'retry', scope: { kind: 'targeted', recordIds: ['one', 'three'] }, uncertainties: [issue('three')] };
  const current = updateUncertaintyList(original, retry, records);
  assert.deepEqual(original, before);
  assert.deepEqual(current.entries.map(entry => [entry.id, entry.number]), [['two', 2], ['three', 3]]);
  assert.equal(current.completeBaseline, true);
  const repeated = updateUncertaintyList(current, retry, records);
  assert.deepEqual(repeated, current);
  const text = uncertaintyMarkdown(current);
  assert.match(text, /2 open segments/);
  assert.match(text, /### 2\. two/);
  assert.doesNotMatch(text, /### 1\. one/);
  const full = updateUncertaintyList(current, { ...report, runId: 'full', uncertainties: [issue('two')] }, records);
  assert.deepEqual(full.entries.map(entry => entry.number), [2]);
  assert.throws(() => updateUncertaintyList(current, { ...retry, uncertainties: [issue('two')] }, records), /outside reviewed scope/);
  assert.throws(() => updateUncertaintyList(current, { ...retry, uncertainties: [issue('three'), issue('three')] }, records), /Duplicate uncertainty/);
  const partial = updateUncertaintyList(null, retry, records);
  assert.equal(partial.completeBaseline, false);
  assert.match(uncertaintyMarkdown(partial), /Coverage is partial/);
});

const timestamp = '2026-11-09T10:00:00Z';
const policyVersion = 1;

function inventoryFor(raw, baseline, catalog) {
  return buildInventory([{ team: raw.team, sourcePath: 'output/test-team/data/test-team-team-data.json',
    raw, integrationUpdatedAt: timestamp }], baseline, catalog, policyVersion, timestamp);
}

test('known weapon-rule candidates survive line wrapping without changing source text', () => {
  const text = 'Its weapons have Piercing \n1 and Lethal\n5+. Move 1 inch; improve its Save by 1.';
  assert.deepEqual(candidateLabels(text, ['Piercing x', 'Lethal x+']), ['Piercing 1', 'Lethal 5+']);
  assert.deepEqual(candidateLabels('Add 1 inch to Move; improve its Save by 1.', ['Brutal', 'Ceaseless']), []);
  assert.ok(text.includes('\n'));
});

test('ordinary rule-system notes do not block verbatim text with no weapon-rule effects', () => {
  const { raw, baseline, catalog, result } = fixture();
  const text = 'Use this rule up to four times per battle. Perform this action for 0AP. Select one additional operative.';
  raw.equipment[0].text = text;
  baseline.teamContent.teams['test-team'].equipment[0].text = text;
  const [task] = createTasks(inventoryFor(raw, baseline, catalog), policyVersion, 'fixture-run');
  result.notes.push('Nonblocking source note: another ordinary rule mentions three uses. Preserve both supplied values.');
  const { candidate, report } = buildCandidate(baseline, [task], [result]);
  const entry = candidate.teamContent.teams['test-team'].equipment[0];
  assert.equal(entry.text, text);
  assert.deepEqual(entry.weaponRuleEffects, []);
  assert.equal(entry.semanticReview.uncertain, false);
  assert.equal(report.uncertainties.length, 0);
  assert.equal(report.reviewNotes.length, 1);
});

test('ordinary candidate-free prose still reaches cleanup workers without deeper weapon analysis', () => {
  const { raw, baseline, catalog, result } = fixture();
  raw.equipment[0].text = 'Lore. Perform this action for 0AP.';
  baseline.teamContent.teams['test-team'].equipment[0].text = raw.equipment[0].text;
  const [task] = createTasks(inventoryFor(raw, baseline, catalog), policyVersion, 'fixture-run');
  const record = task.records.find(record => record.category === 'equipment');
  assert.equal(record.segments[0].analysisMode, 'copy-only');
  result.unchanged = [];
  result.entries.push({ id: record.id, segments: [{ pointer: record.segments[0].pointer,
    remove: [{ text: 'Lore. ', kind: 'flavour', reason: 'Narrative only.' }], decisions: [], uncertain: false, notes: [] }],
  assemblies: [], notes: [] });
  const { candidate, report } = buildCandidate(baseline, [task], [result]);
  assert.equal(candidate.teamContent.teams['test-team'].equipment[0].text, 'Perform this action for 0AP.');
  assert.deepEqual(candidate.teamContent.teams['test-team'].equipment[0].weaponRuleEffects, []);
  assert.equal(report.uncertainties.length, 0);
});

test('preprocessing gates ordinary text and operative selection before model analysis', () => {
  const { raw, baseline, catalog } = fixture();
  raw.equipment[0].text = 'Worsen the Hit stat by 1. Reduce damage by 1. Custom Ability applies.';
  baseline.teamContent.teams['test-team'].equipment[0].text = raw.equipment[0].text;
  raw.operatives_selection = [{ name: 'Selection', text: 'Select a Leader with Lethal 5+.' }];
  baseline.teamContent.teams['test-team'].operativeSelection = structuredClone(raw.operatives_selection);
  const inventory = inventoryFor(raw, baseline, catalog);
  const equipment = inventory.records.find(record => record.category === 'equipment');
  const selection = inventory.records.find(record => record.category === 'operatives_selection');
  assert.equal(equipment.segments[0].analysisMode, 'copy-only');
  assert.deepEqual(equipment.segments[0].candidates, []);
  assert.equal(selection.segments[0].analysisMode, 'copy-only');
  assert.deepEqual(selection.segments[0].candidates, []);
  assert.deepEqual(candidateLabels('If visible, ranged weapons have Seek Light.', ['Seek']), ['Seek Light']);
  const data = fixture();
  const plain = data.result.entries[1].segments.find(segment => segment.decisions.length === 0);
  plain.uncertain = true;
  plain.notes = ['An unrelated action cost is missing.'];
  assert.throws(() => validateResult(data.task, data.result), /Copy-only text/);
});

test('source timestamps inherit team metadata and any changed revision requires review', () => {
  const timestamp = '2026-11-09T10:00:00Z';
  assert.equal(sourceTimestamp({ generated_at: timestamp }), timestamp);
  assert.equal(sourceTimestamp({ name: 'Card' }, timestamp), timestamp);
  assert.equal(sourceTimestamp({ updated_at: '2026-11-09T11:00:00Z' }, timestamp), '2026-11-09T11:00:00Z');
  assert.equal(sourceTimestamp({ generated_at: '2026-11-10T00:00:00Z', metadata: {
    updated_at: '2026-11-09T11:00:00Z', modified_at: '2026-11-09T12:00:00Z' } }), '2026-11-09T12:00:00Z');
  assert.throws(() => sourceTimestamp({ updated_at: 'invalid' }, timestamp), /Invalid source timestamp/);
  assert.throws(() => sourceTimestamp({}), /Missing source timestamp/);
  const current = { sourceUpdatedAt: timestamp, contextUpdatedAt: timestamp, integrationUpdatedAt: timestamp,
    catalogUpdatedAt: timestamp, policyVersion: 1, reviewVersion: 1, sourcePath: 'source.json', pointer: '/datacards/0' };
  assert.equal(reviewIsCurrent(null, current), false);
  assert.equal(reviewIsCurrent({ ...current }, current), true);
  for (const field of Object.keys(current)) assert.equal(reviewIsCurrent({ ...current, [field]: 'changed' }, current), false);
  assert.equal(reviewIsCurrent({ ...current, sourceUpdatedAt: '2026-11-10T00:00:00Z' }, current), false);
});

function fixture() {
  const card = { name: 'Leader', weapons: [{ name: 'Gun', special_rules: 'Lethal 5+, Custom rule' }],
    passive_abilities: [{ name: 'Tactic', description: 'Lore. Give this weapon Balanced while ready.' }], unique_actions: [] };
  const raw = { team: 'test-team', generated_at: timestamp, datacards: [card], faction_rules: [{ name: 'Doctrine', text: '',
    options: [{ name: 'Choice', text: 'Enemy weapons lose Lethal 5+.' }] }], strategy_ploys: [],
    firefight_ploys: [], equipment: [{ name: 'Kit', text: 'Keep this custom factual text.' }], operatives_selection: [] };
  const baseline = { operatives: [{ id: 'test-team:leader', weapons: structuredClone(card.weapons),
    passiveAbilities: structuredClone(card.passive_abilities), uniqueActions: [] }],
  teamContent: { teams: { 'test-team': { factionRules: structuredClone(raw.faction_rules), strategyPloys: [],
    firefightPloys: [], equipment: structuredClone(raw.equipment), operativeSelection: [] } } } };
  const catalog = { Balanced: 'Reroll.', 'Lethal x+': 'Critical.' };
  const inventory = inventoryFor(raw, baseline, catalog);
  const [task] = createTasks(inventory, policyVersion, 'fixture-run');
  const result = { batchId: task.batchId, runId: task.runId, policyVersion: task.policyVersion,
    entries: task.records.filter(record => record.segments.some(segment => segment.candidates.length)).map(record => ({
      id: record.id, segments: record.segments.map(segment => ({ pointer: segment.pointer,
        remove: segment.text.startsWith('Lore.') ? [{ text: 'Lore. ', reason: 'Narrative only.', kind: 'flavour' }] : [],
        decisions: segment.candidates.map(rule => ({ rule, kind: rule === 'Balanced' ? 'grant' : 'counter',
          evidence: rule === 'Balanced' ? 'Give this weapon Balanced while ready.' : segment.text,
          target: rule === 'Balanced' ? 'this weapon' : 'enemy weapons', condition: 'while ready', reason: 'Explicit source wording.' })),
        uncertain: false, notes: [] })), notes: [] })),
    unchanged: task.records.filter(record => record.segments.every(segment => !segment.candidates.length)).map(record => record.id), notes: [] };
  return { baseline, raw, catalog, policyVersion, inventory, task, result };
}

test('inventory inherits team timestamps, prefers card updates and rejects unsupported metadata', () => {
  const { raw, baseline, catalog, inventory } = fixture();
  assert.equal(inventory.records[0].sourceUpdatedAt, timestamp);
  raw.datacards[0].metadata = { updated_at: '2026-11-09T11:00:00Z' };
  raw.modified_at = '2026-11-09T12:00:00Z';
  const again = inventoryFor(raw, baseline, catalog);
  assert.equal(again.records[0].sourceUpdatedAt, '2026-11-09T11:00:00Z');
  assert.equal(again.records[0].contextUpdatedAt, '2026-11-09T12:00:00Z');
  raw.metadata = { unknown: [] };
  assert.throws(() => inventoryFor(raw, baseline, catalog), /Unsupported team metadata/);
});

test('baseline matcher mirrors the current UI including case, boundaries and numeric parameters', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bstart\(\);/, '');
  const control = { addEventListener() {} };
  const app = runInNewContext(`${script}\n({ findRuleMentions })`, {
    document: { querySelector: () => control, querySelectorAll: () => [] },
  });
  const text = 'balanced BALANCED, Lethal 5+ and Lethal; Piercing Crits 1, Torrent 2\u2033, Hotshot.';
  const names = ['Piercing Crits x', 'Lethal x+', 'Balanced', 'Torrent x', 'Hot'];
  assert.deepEqual(findRuleMentions(text, names), Array.from(app.findRuleMentions(text, names)));
  assert.deepEqual(candidateLabels('Lethal 5+ then Lethal with no fixed value.', ['Lethal x+']), ['Lethal 5+', 'Lethal']);
  assert.deepEqual(candidateLabels('', names), []);
  assert.equal(slug("Caf\u00e9's Leader."), 'cafes-leader');
});

test('inventory includes all parents, empty and nested descriptions, complete raw profiles and stable occurrence IDs', () => {
  const { inventory, raw, baseline, catalog } = fixture();
  assert.equal(inventory.records.length, 3);
  assert.deepEqual(inventory.records[0].raw.weapons, raw.datacards[0].weapons);
  assert.equal(inventory.records[1].segments.length, 2);
  assert.equal(inventory.records[1].issues[0].kind, 'empty-description');
  assert.equal(inventory.records[1].segments[1].normalizedPointer, '/teamContent/teams/test-team/factionRules/0/options/0/text');
  raw.equipment.push({ name: 'Kit', text: 'Second kit.' });
  baseline.teamContent.teams['test-team'].equipment.push({ name: 'Kit', text: 'Second kit.' });
  const again = inventoryFor(raw, baseline, catalog);
  assert.equal(again.records.at(-1).id, 'test-team/equipment/kit/2');
});

test('malformed inventory and integration disagreements fail instead of empty success', () => {
  const { raw, baseline, catalog } = fixture();
  const build = () => inventoryFor(raw, baseline, catalog);
  baseline.teamContent.teams['test-team'].factionRules[0].text = 'Different';
  assert.throws(build, /text mismatch/);
  raw.faction_rules = undefined;
  assert.throws(build, /Expected array/);
  assert.throws(() => buildInventory([], baseline, catalog, policyVersion, timestamp), /Empty review inventory/);
});

test('absent categories are empty only if the baseline also has no records; missing nested prose is reported', () => {
  const { raw, baseline, catalog } = fixture();
  delete raw.operatives_selection;
  raw.datacards[0].passive_abilities.push({ name: 'Missing text' });
  baseline.operatives[0].passiveAbilities.push({ name: 'Missing text' });
  const build = () => inventoryFor(raw, baseline, catalog);
  assert.equal(build().records[0].issues[0].kind, 'missing-description');
  baseline.teamContent.teams['test-team'].operativeSelection.push({ name: 'Lost', text: 'Not empty.' });
  assert.throws(build, /category coverage mismatch/);
});

test('complete results include unchanged only when eligible and every segment even empty ones', () => {
  const { task, result } = fixture();
  assert.equal(validateResult(task, result).reviewed.length, 3);
  result.unchanged.push(result.entries.shift().id);
  assert.throws(() => validateResult(task, result), /Ineligible unchanged/);
});

test('missing, duplicate, foreign IDs and missing segments fail', () => {
  for (const mutate of [
    result => result.entries.pop(),
    result => result.entries.push(structuredClone(result.entries[0])),
    result => result.unchanged.push('foreign'),
    result => result.entries[1].segments.shift(),
  ]) {
    const { task, result } = fixture(); mutate(result);
    assert.throws(() => validateResult(task, result), /Missing|Duplicate|Unknown/);
  }
});

test('stale result run identities, record versions and unexpected fields fail', () => {
  for (const key of ['batchId', 'runId', 'policyVersion']) {
    const { task, result } = fixture(); result[key] = 'stale';
    assert.throws(() => validateResult(task, result), /Stale result/);
  }
  const { task, result } = fixture();
  task.records[0].reviewVersion = -1;
  assert.throws(() => validateResult(task, result), /Stale record version/);
  const other = fixture(); other.result.fullRewrite = 'unsafe';
  assert.throws(() => validateResult(other.task, other.result), /Malformed fields/);
});

test('all candidate labels must be classified exactly once with present evidence and explicit fields', () => {
  for (const mutate of [
    segment => { segment.decisions = []; },
    segment => { segment.decisions[0].rule = 'Invented'; },
    segment => { segment.decisions.push(structuredClone(segment.decisions[0])); },
    segment => { segment.decisions[0].evidence = 'not a quote'; },
    segment => { segment.decisions[0].target = ''; },
    segment => { segment.decisions[0].kind = 'invented'; },
    segment => { segment.decisions[0].kind = 'uncertain'; },
    segment => { segment.uncertain = true; },
  ]) {
    const { task, result } = fixture(); mutate(result.entries[0].segments[0]);
    assert.throws(() => validateResult(task, result));
  }
});

test('cleanup uses only unique disjoint exact spans and preserves all other text verbatim', () => {
  const removal = text => ({ text, kind: 'heading', reason: 'Repeated header.' });
  assert.deepEqual(applyRemovals('  HEADER\nKeep\nall.  ', [removal('HEADER\n')]).cleanText, 'Keep\nall.');
  assert.equal(applyRemovals('  Keep.  ', []).cleanText, '  Keep.  ');
  assert.throws(() => applyRemovals('repeat repeat', [removal('repeat')]), /Nonunique/);
  assert.throws(() => applyRemovals('abcdef', [removal('abcd'), removal('cdef')]), /Overlapping/);
  assert.throws(() => applyRemovals('abcdef', [removal('absent')]), /absent/);
  const { task, result } = fixture();
  result.entries[0].segments[0].remove = [removal('Give this weapon Balanced while ready.')];
  assert.throws(() => validateResult(task, result), /Mechanical evidence removed/);
});

test('candidate maps nested text and effects, preserves profiles and keeps flavour/reasoning in audit only', () => {
  const { task, result, baseline } = fixture();
  const before = structuredClone(baseline);
  const { candidate, report, audit } = buildCandidate(baseline, [task], [result]);
  assert.deepEqual(baseline, before);
  assert.deepEqual(candidate.operatives[0].weapons, before.operatives[0].weapons);
  assert.equal(candidate.operatives[0].passiveAbilities[0].description, 'Give this weapon Balanced while ready.');
  assert.equal(candidate.operatives[0].passiveAbilities[0].weaponRuleEffects[0].kind, 'grant');
  assert.equal(candidate.teamContent.teams['test-team'].factionRules[0].options[0].weaponRuleEffects[0].kind, 'counter');
  assert.doesNotMatch(JSON.stringify(candidate), /Lore\.|Narrative only|Explicit source wording|evidence|reason/);
  assert.match(JSON.stringify(audit), /Lore\./);
  assert.doesNotMatch(JSON.stringify(report), /Lore\.|"evidence"/);
  assert.equal(report.cleanup.spans, 1);
  assert.equal(report.coverage.records, 3);
  assert.equal(report.grantsKept.length, 1);
  assert.equal(report.suppressedLexicalTags[0].kind, 'counter');
  assert.equal(report.sourceIssues.length, 1);
  assert.equal(report.completeCoverage, true);
  assert.equal(report.readyToPublish, false);
  assert.equal(report.semanticCorrectnessProven, false);
  assert.throws(() => buildCandidate(baseline, [task], []), /Missing result batches/);
});

test('uncertainty is explicit and policy proposals stay separate from ordinary review notes', () => {
  const { baseline, task, result } = fixture();
  result.notes.push('policy-proposal: Clarify conditional grants.', 'Batch uncertainty for human review.');
  const segment = result.entries[1].segments[1];
  segment.decisions[0].kind = 'uncertain'; segment.uncertain = true; segment.notes.push('Target unclear.');
  const { candidate, report } = buildCandidate(baseline, [task], [result]);
  assert.equal(report.policyImprovements.length, 1);
  assert.equal(report.reviewNotes.length, 2);
  assert.equal(report.uncertainties.length, 1);
  assert.equal(candidate.teamContent.semanticReview.uncertain, true);
  assert.equal(candidate.teamContent.teams['test-team'].factionRules[0].options[0].weaponRuleEffects[0].kind, 'uncertain');
});

function diskFixture(context) {
  const options = prepareFixture(context);
  const { root } = options;
  prepare(options);
  const write = (relative, value) => options.write(root, relative, value);
  const work = 'staging/semantic-review';
  const task = JSON.parse(readFileSync(join(root, work, 'tasks/batch-01.json')));
  const { result } = fixture();
  result.runId = task.runId;
  write(`${work}/${task.resultPath}`, result);
  return { root, work, write, task };
}

test('finalize verifies frozen values and safely reruns only known candidate/report files', context => {
  const { root, write } = diskFixture(context);
  write('data/operatives.json', 'public sentinel'); write('output/keep.txt', 'image sentinel');
  write('app-data/candidate/unrelated.txt', 'keep');
  const first = finalize({ root });
  assert.equal(first.status, 'report-only');
  const bytes = readFileSync(join(root, 'app-data/candidate/operatives.json'), 'utf8');
  assert.deepEqual(finalize({ root }), first);
  assert.equal(readFileSync(join(root, 'app-data/candidate/operatives.json'), 'utf8'), bytes);
  assert.equal(readFileSync(join(root, 'app-data/candidate/unrelated.txt'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(root, 'data/operatives.json'), 'utf8'), 'public sentinel');
  assert.equal(readFileSync(join(root, 'output/keep.txt'), 'utf8'), 'image sentinel');
  write('review/policy.md', 'changed policy');
  assert.throws(() => finalize({ root }), /Policy changed/);
});

test('finalize rejects missing batches, changed snapshots and changed tasks before writing', context => {
  for (const mode of ['result', 'source', 'task']) {
    const { root, work, write, task } = diskFixture(context);
    if (mode === 'result') rmSync(join(root, work, task.resultPath));
    if (mode === 'source') write(`${work}/source/config/weapon_rules.json`, {});
    if (mode === 'task') write(`${work}/tasks/${task.batchId}.json`, {});
    assert.throws(() => finalize({ root }), /Cannot read JSON|Stale snapshot|Stale task/);
  }
});

test('path guards reject escapes and symlinked destination ancestors and outputs', context => {
  const { root, work } = diskFixture(context);
  assert.throws(() => safeDestination(root, join(root, '..', 'escape')), /escapes/);
  assert.throws(() => finalize({ root, work: 'data/unsafe' }), /escapes/);
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(root, 'app-data'), 'junction');
  assert.throws(() => finalize({ root, work }), /Symlinked/);
});

test('finalize preflights every generated file before replacing any candidate', context => {
  const { root, write } = diskFixture(context);
  write('app-data/candidate/operatives.json', 'sentinel');
  mkdirSync(join(root, 'review/reports/latest.md'), { recursive: true });
  assert.throws(() => finalize({ root }), /not a regular file/);
  assert.equal(readFileSync(join(root, 'app-data/candidate/operatives.json'), 'utf8'), 'sentinel');
});

function prepareFixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'kt-review-prepare-'));
  const source = mkdtempSync(join(tmpdir(), 'kt-review-source-'));
  context.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); });
  const { raw, baseline, catalog } = fixture();
  function write(base, relative, value) {
    const target = join(base, relative); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  }
  write(root, 'review/policy.md', 'Policy version: 1\r\n\r\nOriginal policy bytes.\r\n'); write(root, 'scripts/sync.py', 'fixture builder');
  write(source, 'config/weapon_rules.json', catalog);
  write(source, 'output/test-team/data/test-team-team-data.json', raw);
  write(source, 'layers/integration/test-team/content/test-team-content.json', raw);
  return { root, source, write, baseline, raw, buildBaseline: () => ({ ...structuredClone(baseline), warnings: [] }) };
}

function addAutomaticCopies(options) {
  options.raw.operatives_selection = [{ name: 'Selection', text: 'Lore. Select a Leader with Balanced and Lethal 5+.',
    options: [{ name: 'Roster choice without a description or cost' }] }];
  options.raw.faction_rules.push({ name: 'Tokens and Markers', text: '', options: [{ name: 'Counter' }] },
    { name: 'Reference', card_type: 'Marker Guide', description: 'Lore. Balanced and Lethal 5+ marker labels.' });
  options.baseline.teamContent.teams['test-team'].operativeSelection = structuredClone(options.raw.operatives_selection);
  options.baseline.teamContent.teams['test-team'].factionRules = structuredClone(options.raw.faction_rules);
  options.write(options.source, 'output/test-team/data/test-team-team-data.json', options.raw);
  return inventoryFor(options.raw, options.baseline, fixture().catalog).records.filter(isAutomaticCopy);
}

test('prepare bypasses selection and explicit guides before tasks and contexts and preserves normalized objects exactly', context => {
  const options = prepareFixture(context);
  const copies = addAutomaticCopies(options);
  const summary = prepare(options);
  assert.equal(summary.records, 6);
  assert.equal(summary.selectedRecords, 6);
  assert.equal(summary.automaticCopies, 3);
  assert.equal(summary.agentQueued, 3);
  const manifest = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/manifest.json')));
  assert.equal(manifest.records.length, 6);
  assert.equal(manifest.records.filter(record => record.dirty).length, 3);
  const task = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json')));
  assert.deepEqual(task, manifest.tasks[0]);
  assert.equal(task.records.length, 3);
  assert.ok(task.records.every(record => !isAutomaticCopy(record)));
  const completeInventory = inventoryFor(options.raw, options.baseline, fixture().catalog);
  assert.deepEqual(completeInventory.contexts['test-team'].factionRules, options.raw.faction_rules);
  assert.deepEqual(task.contexts['test-team'].factionRules, [options.raw.faction_rules[0]]);
  assert.doesNotMatch(JSON.stringify(task), /Tokens and Markers|Marker Guide|Roster choice|marker labels/);
  assert.ok(copies.every(record => record.issues.length === 0));
  const { result } = fixture();
  result.runId = summary.runId;
  options.write(options.root, `staging/semantic-review/${task.resultPath}`, result);
  const done = finalize({ root: options.root });
  assert.equal(done.records, 6);
  assert.equal(done.reviewedRecords, 3);
  assert.equal(done.automaticCopies, 3);
  assert.equal(done.agentQueued, 3);
  assert.equal(done.workerBatches, 1);
  assert.equal(done.sourceIssues, 1);
  assert.equal(done.uncertainties, 0);
  const candidate = JSON.parse(readFileSync(join(options.root, 'app-data/candidate/team-content.json')));
  assert.deepEqual(candidate.teams['test-team'].operativeSelection, options.raw.operatives_selection);
  assert.deepEqual(candidate.teams['test-team'].factionRules.slice(1), options.raw.faction_rules.slice(1));
  assert.doesNotMatch(JSON.stringify(candidate.teams['test-team'].operativeSelection), /semanticReview|weaponRuleEffects/);
  const report = JSON.parse(readFileSync(join(options.root, 'review/reports/latest.json')));
  assert.deepEqual(report.automaticCopies.map(record => record.id), copies.map(record => record.id));
  assert.ok(report.automaticCopies.every(record => record.status === 'automatic-copy'));
  assert.equal(report.coverage.unchanged, 1);
  const state = JSON.parse(readFileSync(join(options.root, 'staging/review-state.json')));
  assert.equal(state.records.length, 3);
  assert.ok(state.records.every(record => !copies.some(copy => copy.id === record.id)));
});

test('bypass-only targeted runs need zero workers or results and clear only selected stale current findings', context => {
  const options = prepareFixture(context);
  const copies = addAutomaticCopies(options);
  const records = inventoryFor(options.raw, options.baseline, fixture().catalog).records;
  const selection = copies.find(record => record.category === 'operatives_selection');
  const ordinary = records[0];
  const issue = record => ({ id: record.id, team: record.team, pointer: record.segments[0].pointer,
    notes: ['Stale interpretation.'], decisions: [] });
  const previous = updateUncertaintyList(null, { policyVersion: 1, runId: 'old', uncertainties: [issue(selection), issue(ordinary)] }, records);
  options.write(options.root, 'review/reports/uncertainties.json', previous);
  options.write(options.root, 'staging/review-state.json', 'untouched shared cache');
  const work = 'staging/bypass-only';
  const summary = prepare({ ...options, work, recordIds: copies.map(record => record.id), all: true });
  assert.equal(summary.tasks, 0);
  assert.equal(summary.agentQueued, 0);
  assert.equal(summary.cached, 0);
  assert.equal(summary.automaticCopies, 3);
  const manifest = JSON.parse(readFileSync(join(options.root, work, 'manifest.json')));
  assert.deepEqual(manifest.tasks, []);
  assert.equal(existsSync(join(options.root, work, 'tasks')), false);
  rmSync(join(options.root, work, 'results'), { recursive: true });
  const done = finalize({ root: options.root, work });
  assert.equal(done.workerBatches, 0);
  assert.equal(done.batches, 0);
  assert.equal(done.reviewedRecords, 0);
  assert.equal(done.records, 3);
  assert.equal(done.automaticCopies, 3);
  assert.equal(done.agentQueued, 0);
  assert.equal(done.sourceIssues, 0);
  assert.equal(done.uncertainties, 0);
  assert.equal(done.openUncertainties, 1);
  const current = JSON.parse(readFileSync(join(options.root, 'review/reports/uncertainties.json')));
  assert.deepEqual(current.entries, [previous.entries[1]]);
  assert.equal(current.latestPass.reviewedRecords, 3);
  const candidate = JSON.parse(readFileSync(join(options.root, 'app-data/targeted-bypass-only/team-content.json')));
  assert.deepEqual(candidate.teams, options.baseline.teamContent.teams);
  assert.equal(readFileSync(join(options.root, 'staging/review-state.json'), 'utf8'), 'untouched shared cache');
  assert.deepEqual(finalize({ root: options.root, work }), done);
});

test('automatic copies never enter timestamp cache or --all queues while eligible cached reviews retain coverage', context => {
  const options = prepareFixture(context);
  addAutomaticCopies(options);
  const first = prepare(options);
  const { result } = fixture();
  result.runId = first.runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  finalize({ root: options.root });
  const state = readFileSync(join(options.root, 'staging/review-state.json'), 'utf8');
  const next = prepare({ ...options, work: 'staging/cached-copies' });
  assert.equal(next.tasks, 0);
  assert.equal(next.cached, 3);
  assert.equal(next.agentQueued, 0);
  assert.equal(next.automaticCopies, 3);
  const done = finalize({ root: options.root, work: 'staging/cached-copies' });
  assert.equal(done.records, 6);
  assert.equal(done.reviewedRecords, 3);
  assert.equal(done.automaticCopies, 3);
  assert.equal(done.cached, 3);
  assert.equal(done.workerBatches, 0);
  assert.equal(done.agentQueued, 0);
  assert.equal(readFileSync(join(options.root, 'staging/review-state.json'), 'utf8'), state);
  const forced = prepare({ ...options, work: 'staging/forced-copies', all: true });
  assert.equal(forced.cached, 0);
  assert.equal(forced.agentQueued, 3);
  assert.equal(forced.automaticCopies, 3);
  const task = JSON.parse(readFileSync(join(options.root, 'staging/forced-copies/tasks/batch-01.json')));
  assert.ok(task.records.every(record => !isAutomaticCopy(record)));
  result.runId = forced.runId;
  options.write(options.root, `staging/forced-copies/${task.resultPath}`, result);
  assert.equal(finalize({ root: options.root, work: 'staging/forced-copies' }).agentQueued, 3);
});

test('createTasks defaults to excluding automatic copies and direct candidate validation rejects agent edits to bypass IDs', () => {
  const { raw, baseline, catalog, result } = fixture();
  raw.operatives_selection = [{ name: 'Selection', text: 'Lore. Balanced and Lethal 5+.' }];
  baseline.teamContent.teams['test-team'].operativeSelection = structuredClone(raw.operatives_selection);
  const inventory = inventoryFor(raw, baseline, catalog);
  const copy = inventory.records.find(isAutomaticCopy);
  const [task] = createTasks(inventory, policyVersion, 'fixture-run');
  assert.equal(task.records.length, 3);
  assert.deepEqual(createTasks({ ...inventory, records: [copy] }, policyVersion), []);
  task.records.push(copy);
  result.entries.push({ id: copy.id, segments: copy.segments.map(segment => ({ pointer: segment.pointer,
    remove: [{ text: 'Lore. ', reason: 'Narrative only.', kind: 'flavour' }], decisions: [], uncertain: false, notes: [] })),
  assemblies: [], notes: [] });
  const before = structuredClone(baseline);
  assert.throws(() => validateResult(task, result), /Automatic-copy record cannot be assigned/);
  assert.throws(() => buildCandidate(baseline, [task], [result]), /Automatic-copy record cannot be assigned/);
  assert.deepEqual(baseline, before);
  task.records.pop();
  assert.throws(() => buildCandidate(baseline, [task], [result]), /Unknown review ID/);
});

test('Markerlights, Marker Drones and Guide operatives still reach the cleanup worker', () => {
  const { raw, baseline, catalog } = fixture();
  raw.faction_rules.push({ name: 'Markerlights', text: 'Weapons have Balanced.' });
  baseline.teamContent.teams['test-team'].factionRules = structuredClone(raw.faction_rules);
  for (const name of ['SPECTRE GUIDE', 'MV7 MARKER DRONE']) {
    raw.datacards.push({ name, weapons: [], passive_abilities: [{ name: 'Rule', description: 'Weapons have Balanced.' }] });
    baseline.operatives.push({ id: `test-team:${slug(name)}`, weapons: [],
      passiveAbilities: structuredClone(raw.datacards.at(-1).passive_abilities) });
  }
  const inventory = inventoryFor(raw, baseline, catalog);
  const [task] = createTasks(inventory, policyVersion);
  assert.equal(task.records.length, 6);
  for (const name of ['Markerlights', 'SPECTRE GUIDE', 'MV7 MARKER DRONE']) {
    assert.ok(task.records.some(record => record.name === name && record.segments.some(segment => segment.candidates.includes('Balanced'))));
  }
  assert.ok(task.contexts['test-team'].factionRules.some(rule => rule.name === 'Markerlights'));
});

test('prepare snapshots original relative paths, policy bytes and timestamps and refuses to overwrite a run', context => {
  const options = prepareFixture(context);
  mkdirSync(join(options.source, 'output/_generic-tts-objects'), { recursive: true });
  mkdirSync(join(options.source, 'output/terrain/data'), { recursive: true });
  const summary = prepare({ ...options, all: true });
  assert.equal(summary.records, 3); assert.equal(summary.sourceFiles, 3); assert.equal(summary.tasks, 1);
  assert.equal(summary.generatedFiles, 8);
  const task = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json')));
  assert.equal(task.records[0].sourceUpdatedAt, timestamp);
  assert.equal(task.records[0].catalogUpdatedAt, JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/manifest.json'))).sources[0].updatedAt);
  assert.deepEqual(readFileSync(join(options.root, 'staging/semantic-review/policy.md')), readFileSync(join(options.root, 'review/policy.md')));
  assert.doesNotMatch(JSON.stringify(task), /hash/i);
  assert.match(task.runId, /^[0-9a-f-]{36}$/);
  assert.equal(task.resultPath, 'results/batch-01.json');
  assert.throws(() => prepare(options), /nonempty/);
  assert.doesNotMatch(readFileSync(join(options.root, 'staging/semantic-review/manifest.json'), 'utf8'), /[A-Za-z]:\\|kt-review-source-/);
});

test('prepare fails before staging on warnings, changed raw inputs, unknown fields or escaping source links', context => {
  for (const mode of ['warnings', 'change', 'unknown', 'symlink']) {
    const options = prepareFixture(context);
    if (mode === 'warnings') options.buildBaseline = () => ({ ...options.baseline, warnings: ['Missing image'] });
    if (mode === 'change') options.buildBaseline = () => {
      options.write(options.source, 'config/weapon_rules.json', { Changed: 'changed' });
      return { ...options.baseline, warnings: [] };
    };
    if (mode === 'unknown') {
      options.raw.unknown = []; options.write(options.source, 'output/test-team/data/test-team-team-data.json', options.raw);
    }
    if (mode === 'symlink') {
      rmSync(join(options.source, 'config'), { recursive: true });
      symlinkSync(join(options.root, 'review'), join(options.source, 'config'), 'junction');
    }
    assert.throws(() => prepare(options), /warnings|Source changed|Unsupported|ENOENT|escapes/);
    assert.throws(() => readFileSync(join(options.root, 'staging/semantic-review/manifest.json')), /ENOENT/);
  }
});

test('48 teams are assigned exactly once in 12 batches of four with complete contexts', () => {
  const { inventory } = fixture();
  const teams = Array.from({ length: 48 }, (_, index) => `team-${String(index).padStart(2, '0')}`);
  const expanded = { contexts: Object.fromEntries(teams.map(team => [team, inventory.contexts['test-team']])),
    records: teams.flatMap(team => inventory.records.map(record => ({ ...record, team, id: `${team}/${record.id}` }))) };
  const tasks = createTasks(expanded, policyVersion);
  assert.equal(tasks.length, 12);
  assert.equal(new Set(tasks.flatMap(task => task.records.map(record => record.id))).size, 144);
  for (const task of tasks) {
    assert.equal(Object.keys(task.contexts).length, 4);
    assert.equal(task.records.length, 12);
  }
});

test('fixture prepare and worker results round-trip through finalize without Python or live data', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  result.runId = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json'))).runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  const summary = finalize({ root: options.root });
  assert.equal(summary.records, 3);
  assert.equal(summary.batches, 1);
  assert.equal(summary.generatedFiles, 8);
});

test('operatives without prose still receive complete review coverage without a false missing-description issue', () => {
  const { raw, baseline, catalog } = fixture();
  raw.datacards[0].passive_abilities = [];
  baseline.operatives[0].passiveAbilities = [];
  const inventory = inventoryFor(raw, baseline, catalog);
  assert.equal(inventory.records[0].segments.length, 0);
  assert.deepEqual(inventory.records[0].issues, []);
});

test('cache skips current records, aggregates complete coverage and --all forces review', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  result.runId = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json'))).runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  finalize({ root: options.root });
  const state = readFileSync(join(options.root, 'staging/review-state.json'), 'utf8');
  const next = prepare({ ...options, work: 'staging/second' });
  assert.equal(next.tasks, 0); assert.equal(next.dirty, 0); assert.equal(next.cached, 3);
  assert.notEqual(next.runId, result.runId);
  const summary = finalize({ root: options.root, work: 'staging/second' });
  assert.equal(summary.records, 3); assert.equal(summary.workerBatches, 0); assert.equal(summary.cached, 3);
  assert.equal(readFileSync(join(options.root, 'staging/review-state.json'), 'utf8'), state);
  const forced = prepare({ ...options, work: 'staging/forced', all: true });
  assert.equal(forced.dirty, 3); assert.equal(forced.cached, 0); assert.equal(forced.tasks, 1);
});

test('changed card timestamp reviews only that record and failed finalize preserves previous state', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  result.runId = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json'))).runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  finalize({ root: options.root });
  const saved = readFileSync(join(options.root, 'staging/review-state.json'), 'utf8');
  options.raw.datacards[0].updated_at = '2026-11-08T10:00:00Z';
  options.write(options.source, 'output/test-team/data/test-team-team-data.json', options.raw);
  const next = prepare({ ...options, work: 'staging/changed' });
  assert.equal(next.dirty, 1); assert.equal(next.cached, 2);
  assert.throws(() => finalize({ root: options.root, work: 'staging/changed' }), /Cannot read JSON/);
  assert.equal(readFileSync(join(options.root, 'staging/review-state.json'), 'utf8'), saved);
  const task = JSON.parse(readFileSync(join(options.root, 'staging/changed/tasks/batch-01.json')));
  const partial = { ...result, runId: task.runId, entries: [result.entries[0]], unchanged: [] };
  options.write(options.root, 'staging/changed/results/batch-01.json', partial);
  const done = finalize({ root: options.root, work: 'staging/changed' });
  assert.equal(done.records, 3); assert.equal(done.cached, 2);
});

test('catalog mtime, team/integration changes and explicit policy bumps invalidate cached reviews', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  result.runId = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json'))).runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  finalize({ root: options.root });
  options.write(options.root, 'review/policy.md', 'Policy version: 1\nEdited wording, same version.');
  assert.equal(prepare({ ...options, work: 'staging/wording' }).dirty, 0);
  options.write(options.root, 'review/policy.md', 'Policy version: 2\nHuman bumped version.');
  assert.equal(prepare({ ...options, work: 'staging/policy' }).dirty, 3);
  options.write(options.root, 'review/policy.md', 'Policy version: 1');
  for (const [index, relative] of ['output/test-team/data/test-team-team-data.json',
    'layers/integration/test-team/content/test-team-content.json'].entries()) {
    options.write(options.source, relative, { ...options.raw, generated_at: '2026-11-08T00:00:00Z' });
    assert.equal(prepare({ ...options, work: `staging/timestamp-${index}` }).dirty, 3);
    options.write(options.source, relative, options.raw);
  }
  utimesSync(join(options.source, 'config/weapon_rules.json'), new Date('2025-01-01'), new Date('2025-01-01'));
  assert.equal(prepare({ ...options, work: 'staging/catalog' }).dirty, 3);
});

test('missing or invalid required JSON timestamps fail; only timestamp-free catalog uses mtime', context => {
  for (const [index, relative] of ['output/test-team/data/test-team-team-data.json',
    'layers/integration/test-team/content/test-team-content.json', 'config/weapon_rules.json'].entries()) {
    const options = prepareFixture(context);
    const value = index === 2 ? { updated_at: 'invalid' } : { ...options.raw };
    if (index !== 2) delete value.generated_at;
    options.write(options.source, relative, value);
    assert.throws(() => prepare(options), /Missing source timestamp|Invalid source timestamp/);
  }
});

test('finalize rejects edited worker policy, builder, baseline, raw task and stale run output before writes', context => {
  for (const mode of ['policy', 'builder', 'baseline', 'task', 'run']) {
    const { root, work, write, task } = diskFixture(context);
    write('app-data/candidate/operatives.json', 'sentinel');
    if (mode === 'policy') write(`${work}/policy.md`, 'Policy version: 1\nWorker edit');
    if (mode === 'builder') write('scripts/sync.py', 'edited builder');
    if (mode === 'baseline') write(`${work}/baseline/operatives.json`, []);
    if (mode === 'task') {
      task.records[0].raw.name = 'Edited';
      write(`${work}/tasks/batch-01.json`, task);
    }
    if (mode === 'run') {
      const { result } = fixture();
      write(`${work}/results/batch-01.json`, result);
    }
    assert.throws(() => finalize({ root }), /Policy changed|builder changed|Stale baseline|Stale task|Stale result runId/);
    assert.equal(readFileSync(join(root, 'app-data/candidate/operatives.json'), 'utf8'), 'sentinel');
    assert.throws(() => readFileSync(join(root, 'staging/review-state.json')), /ENOENT/);
  }
});

function assemblyFixture(kind = 'corpseman') {
  const { raw, baseline, catalog } = fixture();
  const card = raw.datacards[0];
  if (kind === 'corpseman') {
    card.name = 'Corpseman';
    card.passive_abilities = [
      { name: 'Regular Dosage', description: 'Select one other friendly operative before deployment.' },
      { name: 'STIMM Rules', description: '' },
      { name: 'Rejuvenated', description: 'The operative regains up to 2D3 lost wounds.' },
      { name: 'Enraged', description: 'Its melee weapons have Balanced while ready.' },
      { name: 'Fortified', description: 'On a 5+, subtract 1 from inflicted damage of 3 or more.' },
    ];
    card.unique_actions = [{ name: 'STIMMS (1AP)', description: 'Select one friendly operative within control range once per battle.' }];
  } else if (kind === 'magus') {
    card.name = 'Magus';
    card.passive_abilities = [
      { name: 'Spiritual Leader', description: 'STRATEGIC GAMBIT. Select one of the following for friendly BROOD' },
      { name: 'BROTHER operatives to have until the end of the turning point or until this operative is incapacitated (whichever comes first)',
        description: '\u2022 Ignore Piercing when shooting a friendly BROOD BROTHER operative.\n\u2022 Ignore injured stats.\n\u2022 Ignore APL changes.' },
    ];
    catalog['Piercing x'] = 'Piercing.';
  } else {
    raw.faction_rules = [{ name: 'Obelisk Node Matrix', text: 'Place three markers.\nCONTINUES ON OTHER SIDE', options: [
      { name: 'Whenever one of your OBELISK NODE markers is',
        text: 'within 6" of another marker, ranged weapons have Balanced. Add 1 to APL (maximum 3). Diagram caption.' },
      { name: 'NODE MATRIX', text: 'Combined' },
    ] }];
  }
  baseline.operatives[0] = { ...baseline.operatives[0], id: `test-team:${slug(card.name)}`,
    passiveAbilities: structuredClone(card.passive_abilities), uniqueActions: structuredClone(card.unique_actions) };
  baseline.teamContent.teams['test-team'].factionRules = structuredClone(raw.faction_rules);
  const inventory = inventoryFor(raw, baseline, catalog);
  const record = inventory.records[kind === 'faction' ? 1 : 0];
  const [task] = createTasks({ ...inventory, records: [record] }, policyVersion, 'assembly-run');
  const entry = { id: record.id, segments: record.segments.map(segment => ({ pointer: segment.pointer, remove: [],
    decisions: segment.candidates.map(rule => ({ rule, kind: kind === 'magus' ? 'counter' : 'grant',
      evidence: segment.text, target: kind === 'magus' ? 'enemy weapons' : 'friendly weapons',
      condition: kind === 'magus' ? 'until the end of the turning point or incapacitation' : 'while ready', reason: 'Exact source.' })),
    uncertain: false, notes: [] })), assemblies: [], notes: [] };
  const prefix = kind === 'faction' ? record.pointer : `${record.pointer}/passive_abilities`;
  const part = (pointer, separator = '') => ({ pointer, separator });
  let assembly;
  if (kind === 'corpseman') {
    assembly = { target: `${prefix}/1`, consume: [2, 3, 4].map(index => `${prefix}/${index}`),
      parts: [2, 3, 4].flatMap((index, position) => [part(`${prefix}/${index}/name`, position ? '\n\n' : ''),
        part(`${prefix}/${index}/description`, '\n')]), omitNames: [], reason: 'The heading groups the following named effects.' };
  } else if (kind === 'magus') {
    assembly = { target: `${prefix}/0`, consume: [`${prefix}/1`], parts: [part(`${prefix}/0/description`),
      part(`${prefix}/1/name`, ' '), part(`${prefix}/1/description`, '\n')], omitNames: [],
    reason: 'The name continues the sentence before three bullets.' };
  } else {
    for (const segment of entry.segments) {
      const source = record.segments.find(item => item.pointer === segment.pointer);
      for (const text of ['\nCONTINUES ON OTHER SIDE', ' Diagram caption.', 'Combined']) {
        if (source.text.includes(text)) segment.remove.push({ text, kind: 'heading', reason: 'Structural caption.' });
      }
      if (segment.remove.length && segment.decisions.length) {
        segment.decisions[0].evidence = 'within 6" of another marker, ranged weapons have Balanced.';
      }
    }
    assembly = { target: prefix, consume: [`${prefix}/options/0`, `${prefix}/options/1`], parts: [part(`${prefix}/text`),
      part(`${prefix}/options/0/name`, '\n\n'), part(`${prefix}/options/0/text`, ' ')],
    omitNames: [{ pointer: `${prefix}/options/1/name`, reason: 'Structural diagram caption only.' }],
    reason: 'The back-side sentence continues the front-side rule.' };
  }
  entry.assemblies.push(assembly);
  const result = { batchId: task.batchId, runId: task.runId, policyVersion: task.policyVersion,
    entries: [entry], unchanged: [], notes: [] };
  return { raw, baseline, inventory, record, task, result, entry, assembly };
}

test('Corpseman grouping assembles exact named effects and resolves only the repaired empty heading', () => {
  const { baseline, record, task, result, assembly } = assemblyFixture();
  const before = structuredClone({ baseline, task, result });
  const { candidate, report, audit } = buildCandidate(baseline, [task], [result]);
  const card = candidate.operatives[0];
  assert.equal(card.passiveAbilities.length, 2);
  assert.equal(card.passiveAbilities[1].name, 'STIMM Rules');
  assert.equal(card.passiveAbilities[1].description,
    'Rejuvenated\nThe operative regains up to 2D3 lost wounds.\n\nEnraged\nIts melee weapons have Balanced while ready.\n\nFortified\nOn a 5+, subtract 1 from inflicted damage of 3 or more.');
  assert.deepEqual(card.passiveAbilities[0], { ...baseline.operatives[0].passiveAbilities[0],
    semanticReview: card.passiveAbilities[0].semanticReview, weaponRuleEffects: [] });
  assert.equal(card.uniqueActions[0].description, baseline.operatives[0].uniqueActions[0].description);
  assert.deepEqual(card.weapons, baseline.operatives[0].weapons);
  assert.deepEqual(report.sourceIssues, []);
  assert.equal(report.resolvedSourceIssues[0].pointer, `${assembly.target}/description`);
  assert.deepEqual(card.semanticReview.sourceIssues, []);
  assert.deepEqual(card.passiveAbilities[1].semanticReview.sourceIssues, []);
  assert.equal(record.objectPointers[assembly.target], '/operatives/0/passiveAbilities/1');
  assert.deepEqual({ baseline, task, result }, before);
  assert.match(JSON.stringify(audit), /heading groups/);
  assert.doesNotMatch(JSON.stringify(candidate), /heading groups|Exact source|reason/);
});

test('Magus continuation preserves exact target, duration, all three bullets and counter evidence', () => {
  const { baseline, task, result, record } = assemblyFixture('magus');
  const { candidate, audit } = buildCandidate(baseline, [task], [result]);
  const abilities = candidate.operatives[0].passiveAbilities;
  assert.equal(abilities.length, 1);
  const [front, back] = record.raw.passive_abilities;
  assert.equal(abilities[0].name, front.name);
  assert.equal(abilities[0].description, `${front.description} ${back.name}\n${back.description}`);
  assert.equal(abilities[0].description.match(/\u2022/g).length, 3);
  assert.equal(abilities[0].weaponRuleEffects[0].kind, 'counter');
  assert.equal(abilities[0].weaponRuleEffects[0].condition, 'until the end of the turning point or incapacitation');
  assert.equal(audit[0].reviewed[0].segments[1].decisions[0].evidence, back.description);
  assert.deepEqual(candidate.operatives[0].weapons, baseline.operatives[0].weapons);
});

test('logicalText preserves complete ordered Magus names and bodies as context without rewriting source or provenance', () => {
  const { raw, baseline, inventory, record, task, result } = assemblyFixture('magus');
  const card = raw.datacards[0];
  card.text = 'Parent body with exact wording.';
  card.description = 'Additional parent description.';
  card.unique_actions = [{ name: 'Action (1AP)', description: 'Select a target.',
    options: [{ name: 'Choice continues', text: 'with its complete mechanical text.' }] }];
  card.metadata = { name: 'Ignore metadata name', description: 'Ignore metadata body' };
  const expected = [card.name, ...card.passive_abilities.flatMap(ability => [ability.name, ability.description]),
    'Action (1AP)', 'Select a target.', 'Choice continues', 'with its complete mechanical text.', card.text, card.description];
  baseline.operatives[0].text = card.text;
  baseline.operatives[0].description = card.description;
  baseline.operatives[0].uniqueActions = structuredClone(card.unique_actions);
  const before = structuredClone({ raw, baseline });
  const updated = inventoryFor(raw, baseline, fixture().catalog);
  const [updatedTask] = createTasks(updated, policyVersion);
  assert.equal(updatedTask.records[0].logicalText, expected.join(' '));
  assert.doesNotMatch(updatedTask.records[0].logicalText, /Ignore metadata/);
  assert.ok(record.logicalText.includes('friendly BROOD BROTHER operatives to have until the end of the turning point'));
  assert.equal(record.logicalText, [record.raw.name,
    ...record.raw.passive_abilities.flatMap(ability => [ability.name, ability.description])].join(' '));
  assert.doesNotMatch(record.logicalText, /Custom rule|special_rules|Critical\./);
  assert.match(task.contract.rules.join(' '), /Read record.logicalText and the complete raw parent/);
  assert.match(task.contract.rules.join(' '), /field break alone never proves missing mechanics/);
  assert.deepEqual({ raw, baseline }, before);
  assert.equal(inventory.records[0].segments[1].pointer, '/datacards/0/passive_abilities/1/description');
  assert.equal(result.entries[0].segments[1].decisions[0].evidence, record.raw.passive_abilities[1].description);
});

test('back-side faction options join only cleaned fragments with explicit structural heading omission', () => {
  const { baseline, task, result, assembly } = assemblyFixture('faction');
  const { candidate, audit } = buildCandidate(baseline, [task], [result]);
  const rule = candidate.teamContent.teams['test-team'].factionRules[0];
  assert.equal(rule.text, 'Place three markers.\n\nWhenever one of your OBELISK NODE markers is within 6" of another marker, ranged weapons have Balanced. Add 1 to APL (maximum 3).');
  assert.deepEqual(rule.options, []);
  assert.equal(rule.name, 'Obelisk Node Matrix');
  assert.equal(rule.weaponRuleEffects[0].condition, 'while ready');
  assert.deepEqual(rule.semanticReview.assembly.omitNames, [`${assembly.target}/options/1/name`]);
  assert.match(JSON.stringify(audit), /Diagram caption|Combined|Structural diagram/);
  assert.doesNotMatch(JSON.stringify(candidate), /Diagram caption|Combined|Structural diagram|back-side sentence/);
});

test('assemblies propagate pre-existing effects and provenance without losing conditions', () => {
  const { baseline, task, result, assembly } = assemblyFixture();
  const effect = { rule: 'Custom', kind: 'modify', condition: 'only within 2 inches', pointer: `${assembly.consume[0]}/description` };
  baseline.operatives[0].passiveAbilities[2].weaponRuleEffects = [effect];
  baseline.operatives[0].passiveAbilities[2].provenance = [{ pointer: assembly.consume[0] }];
  baseline.operatives[0].passiveAbilities[2].semanticReview = { provenance: [`${assembly.consume[0]}/name`] };
  const { candidate } = buildCandidate(baseline, [task], [result]);
  const target = candidate.operatives[0].passiveAbilities[1];
  assert.deepEqual(target.weaponRuleEffects[0], effect);
  assert.equal(target.weaponRuleEffects[1].rule, 'Balanced');
  assert.deepEqual(target.provenance, [{ pointer: assembly.consume[0] }]);
  assert.ok(target.semanticReview.provenance.includes(`${assembly.consume[1]}/description`));
  assert.ok(target.semanticReview.provenance.includes(`${assembly.consume[0]}/name`));
});

test('assembly validation rejects escapes, profiles, scalar or unknown locations, lost fields and malformed joins', () => {
  const mutations = [
    ({ assembly }) => { assembly.target = '/datacards/1/passive_abilities/0'; },
    ({ assembly }) => { assembly.consume[0] = '/datacards/1/passive_abilities/0'; },
    ({ assembly }) => { assembly.consume[0] = '/datacards/0/weapons/0'; },
    ({ assembly }) => { assembly.target = '/datacards/0/weapons/0'; },
    ({ assembly }) => { assembly.target = '/datacards/0/apl'; },
    ({ assembly }) => { assembly.consume[0] = '/datacards/0/apl'; },
    ({ assembly }) => { assembly.parts[0].pointer = '/datacards/0/weapons/0/name'; },
    ({ assembly }) => { assembly.consume[0] = '/datacards/0/unknown/0'; },
    ({ assembly }) => { assembly.parts.splice(1, 1); },
    ({ assembly }) => { assembly.parts.shift(); },
    ({ assembly }) => { assembly.parts[0].separator = 'and '; },
    ({ assembly }) => { assembly.parts[0].separator = '\n'; },
    ({ assembly }) => { assembly.parts.push({ ...assembly.parts[0] }); },
    ({ assembly }) => { assembly.parts.reverse(); },
    ({ assembly }) => { assembly.consume.push(assembly.consume[0]); },
    ({ assembly }) => { assembly.consume.push(assembly.target); },
    ({ entry, assembly }) => { entry.assemblies.push(structuredClone(assembly)); },
    ({ assembly }) => { assembly.omitNames.push({ pointer: `${assembly.target}/name`, reason: 'Not consumed.' }); },
    ({ assembly }) => { assembly.omitNames.push({ pointer: `${assembly.consume[0]}/name`, reason: 'Already used.' }); },
    ({ record }) => { record.raw.passive_abilities[2].apl = 2; },
    ({ record }) => { record.raw.passive_abilities[2].options = [{ name: 'Child', text: 'Keep mechanics.' }]; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const data = assemblyFixture(); mutate(data);
    const before = structuredClone(data.baseline);
    assert.throws(() => buildCandidate(data.baseline, [data.task], [data.result]), undefined, `Mutation ${index}`);
    assert.deepEqual(data.baseline, before);
  }
  const data = assemblyFixture('faction');
  data.entry.segments.at(-1).remove = [];
  assert.throws(() => validateResult(data.task, data.result), /loses source field/);
  data.entry.segments.at(-1).remove = [{ text: 'Combined', kind: 'heading', reason: 'Diagram only.' }];
  data.assembly.omitNames = [];
  assert.throws(() => validateResult(data.task, data.result), /loses source field/);
});

test('all assemblies validate before any candidate mutation, including remaining target prose', () => {
  const data = assemblyFixture();
  data.record.raw.passive_abilities[1].text = 'Retain this additional mechanical constraint.';
  data.record.segments.push({ pointer: `${data.assembly.target}/text`, normalizedPointer: '/operatives/0/passiveAbilities/1/text',
    text: data.record.raw.passive_abilities[1].text, candidates: [], baselineTags: [] });
  data.entry.segments.push({ pointer: `${data.assembly.target}/text`, remove: [], decisions: [], uncertain: false, notes: [] });
  assert.throws(() => validateResult(data.task, data.result), /loses source field/);
  const empty = assemblyFixture('faction');
  empty.assembly.parts = [];
  assert.throws(() => validateResult(empty.task, empty.result), /Empty assembly join/);
  const renamed = assemblyFixture();
  renamed.baseline.operatives[0].passiveAbilities[1].name = 'An arbitrary replacement';
  assert.throws(() => buildCandidate(renamed.baseline, [renamed.task], [renamed.result]), /name mismatch/);
});

test('nested consumed entries and overlapping assemblies cannot orphan or double-claim content', () => {
  const data = assemblyFixture('faction');
  const prefix = `${data.record.pointer}/options/0/options/0`;
  data.record.raw.options[0].options = [{ name: 'Child', text: 'Remaining mechanics.' }];
  data.assembly.consume.push(prefix);
  assert.throws(() => validateResult(data.task, data.result), /ancestor\/descendant ambiguity/);
  const overlap = assemblyFixture('faction');
  overlap.entry.assemblies.push({ ...structuredClone(overlap.assembly), target: `${overlap.record.pointer}/options/0` });
  assert.throws(() => validateResult(overlap.task, overlap.result), /overlapping|Overlapping/);
});

test('multiple disjoint assemblies retain original pointer updates and splice array entries in reverse order', () => {
  const data = assemblyFixture();
  const prefix = '/datacards/0/passive_abilities';
  data.assembly.consume = [`${prefix}/2`];
  data.assembly.parts = data.assembly.parts.slice(0, 2);
  data.entry.assemblies.push({ target: `${prefix}/3`, consume: [`${prefix}/4`],
    parts: [{ pointer: `${prefix}/3/description`, separator: '' }, { pointer: `${prefix}/4/name`, separator: '\n' },
      { pointer: `${prefix}/4/description`, separator: '\n' }], omitNames: [], reason: 'Explicit source grouping.' });
  const { candidate } = buildCandidate(data.baseline, [data.task], [data.result]);
  const abilities = candidate.operatives[0].passiveAbilities;
  assert.deepEqual(abilities.map(entry => entry.name), ['Regular Dosage', 'STIMM Rules', 'Enraged']);
  assert.equal(abilities[2].weaponRuleEffects[0].rule, 'Balanced');
  assert.match(abilities[2].description, /Fortified\nOn a 5\+/);
});

test('targeted prepare/finalize isolates reports, candidate and shared cache and exposes partial source coverage', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  result.runId = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json'))).runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  finalize({ root: options.root });
  const protectedPaths = ['review/reports/latest.json', 'review/reports/latest.md', 'app-data/candidate/operatives.json',
    'app-data/candidate/team-content.json', 'staging/review-state.json'];
  const originals = protectedPaths.map(relative => readFileSync(join(options.root, relative)));
  const recordIds = [result.unchanged[0], ...result.entries.map(entry => entry.id)];
  const summary = prepare({ ...options, work: 'staging/retry-three', recordIds });
  assert.equal(summary.records, 3); assert.equal(summary.selectedRecords, 3);
  assert.equal(summary.dirty, 3); assert.equal(summary.cached, 0);
  assert.equal(summary.scope.kind, 'targeted');
  const manifest = JSON.parse(readFileSync(join(options.root, 'staging/retry-three/manifest.json')));
  assert.equal(manifest.fullReview, false);
  assert.deepEqual(new Set(manifest.tasks.flatMap(task => task.records.map(record => record.id))), new Set(recordIds));
  result.runId = manifest.runId;
  options.write(options.root, 'staging/retry-three/results/batch-01.json', result);
  const done = finalize({ root: options.root, work: 'staging/retry-three' });
  assert.equal(done.readyToPublish, false); assert.equal(done.wholeSourceCoverage, false);
  assert.equal(done.assignedCoverageComplete, true);
  assert.equal(done.generatedFiles, 7);
  for (const [index, relative] of protectedPaths.entries()) assert.deepEqual(readFileSync(join(options.root, relative)), originals[index]);
  assert.ok(existsSync(join(options.root, 'app-data/targeted-retry-three/operatives.json')));
  assert.ok(existsSync(join(options.root, 'staging/retry-three/audit/batch-01.json')));
  const report = JSON.parse(readFileSync(join(options.root, 'staging/retry-three/report.json')));
  assert.equal(report.completeCoverage, false);
  assert.deepEqual(report.scope, summary.scope);
  assert.match(readFileSync(join(options.root, 'staging/retry-three/report.md'), 'utf8'), /whole-source coverage: no/);
  assert.ok(existsSync(join(options.root, 'review/reports/uncertainties.json')));
  assert.ok(existsSync(join(options.root, 'review/reports/uncertainties.md')));
  assert.equal(existsSync(join(options.root, 'review/reports/targeted-retry-three.md')), false);
});

test('finalize maintains one list across targeted resolution and repeated passes', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  const task = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json')));
  result.runId = task.runId;
  for (const entry of result.entries) {
    const segment = entry.segments.find(item => item.decisions.length);
    segment.decisions[0].kind = 'uncertain';
    segment.uncertain = true;
    segment.notes = ['Weapon-rule target needs review.'];
  }
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  finalize({ root: options.root });
  const listPath = join(options.root, 'review/reports/uncertainties.json');
  assert.equal(JSON.parse(readFileSync(listPath)).entries.length, 2);
  const id = result.entries[0].id;
  prepare({ ...options, work: 'staging/resolved', recordIds: [id] });
  const retryTask = JSON.parse(readFileSync(join(options.root, 'staging/resolved/tasks/batch-01.json')));
  const retry = fixture().result;
  retry.runId = retryTask.runId;
  retry.entries = retry.entries.filter(entry => entry.id === id);
  retry.unchanged = [];
  options.write(options.root, 'staging/resolved/results/batch-01.json', retry);
  const done = finalize({ root: options.root, work: 'staging/resolved' });
  const current = JSON.parse(readFileSync(listPath));
  assert.equal(done.openUncertainties, 1);
  assert.equal(current.entries.length, 1);
  assert.equal(current.entries[0].number, 2);
  assert.notEqual(current.entries[0].id, id);
  assert.equal(existsSync(join(options.root, 'review/reports/targeted-resolved.md')), false);
  finalize({ root: options.root, work: 'staging/resolved' });
  assert.deepEqual(JSON.parse(readFileSync(listPath)), current);
});

test('a blocked current-list output fails before replacing candidate data', context => {
  const options = prepareFixture(context);
  prepare(options);
  const { result } = fixture();
  result.runId = JSON.parse(readFileSync(join(options.root, 'staging/semantic-review/tasks/batch-01.json'))).runId;
  options.write(options.root, 'staging/semantic-review/results/batch-01.json', result);
  options.write(options.root, 'app-data/candidate/operatives.json', 'sentinel');
  mkdirSync(join(options.root, 'review/reports/uncertainties.json'), { recursive: true });
  assert.throws(() => finalize({ root: options.root }), /not a regular file/);
  assert.equal(readFileSync(join(options.root, 'app-data/candidate/operatives.json'), 'utf8'), 'sentinel');
});

test('targeted selection is exact, ignores shared cache and still validates unselected source baseline', context => {
  const options = prepareFixture(context);
  const { inventory } = fixture();
  const id = inventory.records[0].id;
  options.write(options.root, 'staging/review-state.json', 'not JSON: targeted runs must not read shared cache');
  const summary = prepare({ ...options, work: 'staging/one', recordIds: [id] });
  assert.equal(summary.scope.sourceRecords, 3); assert.equal(summary.scope.selectedRecords, 1);
  const task = JSON.parse(readFileSync(join(options.root, 'staging/one/tasks/batch-01.json')));
  assert.deepEqual(task.records.map(record => record.id), [id]);
  const { result } = fixture();
  result.runId = task.runId; result.entries = result.entries.filter(entry => entry.id === id); result.unchanged = [];
  options.write(options.root, 'staging/one/results/batch-01.json', result);
  const done = finalize({ root: options.root, work: 'staging/one' });
  assert.equal(done.records, 1); assert.equal(done.scope.sourceRecords, 3);
  assert.equal(readFileSync(join(options.root, 'staging/review-state.json'), 'utf8'), 'not JSON: targeted runs must not read shared cache');
  assert.equal(existsSync(join(options.root, 'review/reports/latest.json')), false);
  for (const [index, recordIds] of [[id, id], ['unknown'], []].entries()) {
    const work = `staging/invalid-${index}`;
    assert.throws(() => prepare({ ...options, work, recordIds }), /Duplicate requested|Unknown requested|Empty recordIds/);
    assert.equal(existsSync(join(options.root, work)), false);
  }
  options.baseline.teamContent.teams['test-team'].equipment[0].text = 'Mismatched unselected source.';
  assert.throws(() => prepare({ ...options, work: 'staging/invalid-baseline', recordIds: [id] }), /text mismatch/);
  assert.equal(existsSync(join(options.root, 'staging/invalid-baseline')), false);
});

test('targeted reports distinguish 1207 validated source records from three assigned reviews', context => {
  const options = prepareFixture(context);
  const extra = Array.from({ length: 1204 }, (_, index) => ({ name: `Equipment ${index}`, text: 'Retain exact source text.' }));
  options.raw.equipment.push(...extra);
  options.baseline.teamContent.teams['test-team'].equipment.push(...structuredClone(extra));
  options.write(options.source, 'output/test-team/data/test-team-team-data.json', options.raw);
  const { inventory, result } = fixture();
  const recordIds = inventory.records.map(record => record.id);
  const summary = prepare({ ...options, work: 'staging/three-of-1207', recordIds });
  assert.equal(summary.records, 1207);
  assert.equal(summary.selectedRecords, 3);
  assert.deepEqual(summary.scope, { kind: 'targeted', sourceRecords: 1207, selectedRecords: 3, recordIds });
  result.runId = summary.runId;
  options.write(options.root, 'staging/three-of-1207/results/batch-01.json', result);
  finalize({ root: options.root, work: 'staging/three-of-1207' });
  const report = JSON.parse(readFileSync(join(options.root, 'staging/three-of-1207/report.json')));
  assert.equal(report.coverage.records, 3);
  assert.equal(report.scope.sourceRecords, 1207);
  assert.equal(report.assignedCoverageComplete, true);
  assert.equal(report.wholeSourceCoverage, false);
  assert.equal(report.readyToPublish, false);
  const candidate = JSON.parse(readFileSync(join(options.root, 'app-data/targeted-three-of-1207/team-content.json')));
  assert.deepEqual(candidate.semanticReview.scope, summary.scope);
  assert.equal(candidate.semanticReview.completeCoverage, false);
  assert.equal(candidate.teams['test-team'].equipment.length, 1205);
  assert.deepEqual(candidate.teams['test-team'].equipment.at(-1), extra.at(-1));
  assert.match(readFileSync(join(options.root, 'staging/three-of-1207/report.md'), 'utf8'), /Selected records: 3\. Source records: 1207\./);
});