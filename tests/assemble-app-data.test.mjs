import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { aggregateReviewedData, assembleAppData, REVIEW_RUNS } from '../scripts/assemble-app-data.mjs';

const timestamp = '2026-11-09T10:00:00Z';

function fixture() {
  const content = { factionRules: [{ name: 'Rule', text: 'Original rule.', options: [{ name: 'Option', text: 'Original option.' }] }],
    strategyPloys: [], firefightPloys: [], equipment: [], operativeSelection: [{ name: 'Selection', text: 'Select one.' }] };
  const operative = { id: 'team:one', team: 'team', name: 'One', apl: 2, weapons: [{ name: 'Gun', damage: '3/4' }],
    frontImage: './output/team/front.jpg', backImage: './output/team/back.jpg',
    cards: [{ frontImage: './output/team/front.jpg', backImage: './output/team/back.jpg' }],
    passiveAbilities: [{ name: 'Ability', description: 'Original ability.' }] };
  const baseline = { operatives: [operative], teamContent: { schemaVersion: 1, teams: { team: content }, weaponRuleNames: ['Balanced'] } };
  const records = [['one', 'datacards', '/operatives/0', '/datacards/0'],
    ['rule', 'faction_rules', '/teamContent/teams/team/factionRules/0', '/faction_rules/0'],
    ['selection', 'operatives_selection', '/teamContent/teams/team/operativeSelection/0', '/operatives_selection/0']]
    .map(([id, category, normalizedBase, pointer]) => ({ id, team: 'team', category, normalizedBase, pointer,
      sourcePath: 'output/team/data/team-team-data.json', sourceUpdatedAt: timestamp, contextUpdatedAt: timestamp,
      integrationUpdatedAt: timestamp, catalogUpdatedAt: timestamp }));
  const rawBaseline = structuredClone(baseline);
  const parent = (dataset, record) => record.normalizedBase.split('/').slice(1).reduce((value, key) => value[key], dataset);
  const annotate = (dataset, record, policyVersion) => {
    const { normalizedBase, id, team, category, ...freshness } = record;
    parent(dataset, record).semanticReview = { ...freshness, reviewVersion: 1, policyVersion, status: 'report-only', uncertain: false };
  };
  for (const record of records) annotate(baseline, record, 1);
  baseline.teamContent.semanticReview = { uncertain: true, status: 'report-only' };
  const baseReport = { runId: 'base', policyVersion: 1, reviewVersion: 1, completeCoverage: true,
    coverage: { records: 3, datacards: 1, teams: 1 }, uncertainties: [] };
  const makeOverlay = (ids, runId = 'retry', policyVersion = 2, bypass = false) => {
    const candidate = structuredClone(baseline);
    for (const id of ids) {
      const record = records.find(item => item.id === id);
      if (bypass) {
        const target = parent(candidate, record);
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, structuredClone(parent(rawBaseline, record)));
      } else annotate(candidate, record, policyVersion);
    }
    const scope = { kind: 'targeted', sourceRecords: records.length, selectedRecords: ids.length, recordIds: ids };
    const report = { runId, policyVersion, reviewVersion: 1, scope, assignedCoverageComplete: true,
      coverage: { records: ids.length, automaticCopies: bypass ? ids.length : 0, reviewedRecords: bypass ? 0 : ids.length },
      automaticCopies: bypass ? ids.map(id => ({ id, status: 'automatic-copy' })) : [], uncertainties: [] };
    return { candidate, report, manifest: { runId, policyVersion, scope, records: structuredClone(records), baseline: structuredClone(rawBaseline) } };
  };
  return { baseline, records, baseReport, overlays: [], uncertaintyList: { entries: [] }, makeOverlay, rawBaseline };
}

test('only explicit scopes overlay whole original parents, in order, preserving effects and provenance', () => {
  const input = fixture();
  const first = input.makeOverlay(['rule']);
  first.candidate.teamContent.teams.team.factionRules[0].text = 'Reviewed rule.';
  first.candidate.teamContent.teams.team.factionRules[0].options = [];
  first.candidate.teamContent.teams.team.factionRules[0].weaponRuleEffects = [{ rule: 'Balanced', kind: 'grant', condition: 'One token' }];
  first.candidate.teamContent.teams.team.factionRules[0].provenance = ['original/option/0'];
  first.candidate.operatives[0].passiveAbilities[0].description = 'Unscoped change must not leak.';
  const second = input.makeOverlay(['one'], 'later', 3);
  second.candidate.operatives[0].passiveAbilities[0].description = 'Reviewed ability.';
  input.overlays = [first, second];
  const before = structuredClone(input.baseline);
  const result = aggregateReviewedData(input);
  assert.equal(result.teamContent.teams.team.factionRules[0].text, 'Reviewed rule.');
  assert.deepEqual(result.teamContent.teams.team.factionRules[0].options, []);
  assert.deepEqual(result.teamContent.teams.team.factionRules[0].weaponRuleEffects, first.candidate.teamContent.teams.team.factionRules[0].weaponRuleEffects);
  assert.deepEqual(result.teamContent.teams.team.factionRules[0].provenance, ['original/option/0']);
  assert.equal(result.operatives[0].passiveAbilities[0].description, 'Reviewed ability.');
  assert.deepEqual(result.teamContent.teams.team.operativeSelection, input.baseline.teamContent.teams.team.operativeSelection);
  assert.deepEqual(input.baseline, before);
  assert.equal(result.teamContent.teams.team.factionRules[0].semanticReview.policyVersion, 2);
  assert.equal(result.teamContent.semanticReview.productionApproved, false);
  assert.deepEqual(result.release.policyVersions, [1, 2, 3]);
  assert.deepEqual(result, aggregateReviewedData(input));
  result.teamContent.teams.team.factionRules[0].provenance.push('no mutation');
  assert.equal(first.candidate.teamContent.teams.team.factionRules[0].provenance.length, 1);
});

test('unknown and duplicate scoped IDs, source revisions, missing reports and incomplete coverage fail closed', () => {
  for (const [change, pattern] of [
    [input => { input.overlays[0].manifest.scope.recordIds[0] = 'unknown'; }, /Unknown scoped ID/],
    [input => { input.overlays[0].manifest.scope.recordIds.push('rule'); }, /duplicate scope/],
    [input => { input.overlays[0].manifest.records[0].sourceUpdatedAt = 'different'; }, /Source revision mismatch/],
    [input => { input.overlays[0].candidate.teamContent.teams.team.factionRules[0].semanticReview.sourceUpdatedAt = 'different'; }, /Source revision mismatch/],
    [input => { delete input.overlays[0].report; }, /Expected object/],
    [input => { input.overlays[0].report.assignedCoverageComplete = false; }, /Incomplete assigned/],
    [input => { input.overlays[0].report.coverage.records = 0; }, /Incomplete assigned/],
    [input => { delete input.overlays[0].candidate.teamContent.teams.team.factionRules[0].semanticReview; }, /review metadata/],
    [input => { input.baseReport.completeCoverage = false; }, /full reviewed coverage/],
    [input => { input.records.pop(); }, /Full mapping coverage/],
    [input => { input.overlays[0].candidate.teamContent.teams.team.factionRules = []; }, /parent coverage/],
  ]) {
    const input = fixture();
    input.overlays = [input.makeOverlay(['rule'])];
    change(input);
    assert.throws(() => aggregateReviewedData(input), pattern);
  }
});

test('all uncertainty gates are independent and record flags are never auto-cleared', () => {
  for (const [change, pattern] of [
    [input => { input.uncertaintyList.entries.push({ id: 'rule' }); }, /list is not empty/],
    [input => { input.overlays[0].report.uncertainties.push({ id: 'rule' }); }, /Unresolved report uncertainty/],
    [input => { input.baseline.operatives[0].passiveAbilities[0].semanticReview = {
      ...input.baseline.operatives[0].semanticReview, pointer: '/datacards/0/passive_abilities/0/description', uncertain: true,
    }; }, /Unresolved semantic/],
    [input => { input.overlays[0].candidate.teamContent.teams.team.factionRules[0].weaponRuleEffects = [{ kind: 'uncertain' }]; }, /Unresolved weapon effect/],
    [input => { input.overlays[0].candidate.teamContent.teams.team.factionRules[0].semanticReview.uncertain = true; }, /Unresolved semantic/],
  ]) {
    const input = fixture();
    input.overlays = [input.makeOverlay(['rule'])];
    change(input);
    assert.throws(() => aggregateReviewedData(input), pattern);
  }
  const input = fixture();
  input.baseline.teamContent.teams.team.factionRules[0].semanticReview.uncertain = true;
  input.overlays = [input.makeOverlay(['rule'])];
  assert.equal(aggregateReviewedData(input).teamContent.semanticReview.uncertain, false);
});

test('a later confirmed scoped review resolves historical report uncertainty', () => {
  const input = fixture();
  input.baseReport.uncertainties = [{ id: 'rule' }];
  const earlier = input.makeOverlay(['rule'], 'earlier', 6);
  earlier.report.uncertainties = [{ id: 'rule' }];
  earlier.candidate.teamContent.teams.team.factionRules[0].semanticReview.uncertain = true;
  const confirmed = input.makeOverlay(['rule'], 'confirmed', 7);
  input.overlays = [earlier, confirmed];
  assert.equal(aggregateReviewedData(input).release.unresolvedFindings, 0);
  input.overlays = [earlier];
  assert.throws(() => aggregateReviewedData(input), /Unresolved report uncertainty/);
});

test('parent reviews may cite their own text segment but never another card', () => {
  const input = fixture();
  input.baseline.teamContent.teams.team.factionRules[0].semanticReview.pointer += '/text';
  assert.equal(aggregateReviewedData(input).release.unresolvedFindings, 0);
  input.baseline.teamContent.teams.team.factionRules[0].semanticReview.pointer = '/faction_rules/99/text';
  assert.throws(() => aggregateReviewedData(input), /Review pointer mismatch/);
});

test('weapons, images, cards, counts and parent mechanics cannot change', () => {
  for (const change of [
    overlay => { overlay.candidate.operatives[0].weapons[0].damage = '9/9'; },
    overlay => { overlay.candidate.operatives[0].frontImage = './output/other.jpg'; },
    overlay => { overlay.candidate.operatives[0].cards = []; },
    overlay => { overlay.candidate.operatives.push(structuredClone(overlay.candidate.operatives[0])); },
    overlay => { overlay.candidate.operatives[0].apl = 9; },
  ]) {
    const input = fixture();
    input.overlays = [input.makeOverlay(['one'])];
    change(input.overlays[0]);
    assert.throws(() => aggregateReviewedData(input), /profiles|image|counts|mechanics/);
  }
});

test('automatic copies need no task metadata and must equal normalized baseline verbatim', () => {
  const input = fixture();
  input.overlays = [input.makeOverlay(['selection'], 'bypass', 6, true)];
  const result = aggregateReviewedData(input);
  assert.deepEqual(result.teamContent.teams.team.operativeSelection, input.rawBaseline.teamContent.teams.team.operativeSelection);
  input.overlays[0].candidate.teamContent.teams.team.operativeSelection[0].text = 'Guessed text';
  assert.throws(() => aggregateReviewedData(input), /Bypass must be verbatim/);
});

test('private review fields are not published, without rewriting rule text or provenance', () => {
  const input = fixture();
  input.baseline.operatives[0].semanticReview.reasoning = 'Private reasoning';
  input.baseline.operatives[0].semanticReview.sourceIssues = [{ kind: 'historical audit' }];
  const result = aggregateReviewedData(input);
  assert.equal(result.operatives[0].semanticReview.reasoning, undefined);
  assert.equal(result.operatives[0].semanticReview.sourceIssues, undefined);
  input.baseline.operatives[0].audit = 'private';
  assert.throws(() => aggregateReviewedData(input), /Private audit field/);
});

function temporaryRoot(context) {
  const root = mkdtempSync(path.join(tmpdir(), 'assemble-app-data-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, value) {
  const filename = path.join(root, relative);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
}

function diskFixture(context) {
  const root = temporaryRoot(context);
  const input = fixture();
  const raw = { updated_at: timestamp, datacards: [{ name: 'One' }], faction_rules: [{ name: 'Rule' }], operatives_selection: [{ name: 'Selection' }] };
  for (const record of input.records) record.raw = record.pointer.split('/').slice(1).reduce((value, key) => value[key], raw);
  raw.datacards[0].weapons = structuredClone(input.baseline.operatives[0].weapons);
  const save = (work, run, full = false) => {
    const task = { batchId: 'batch-01', records: full ? input.records : [], runId: run.report.runId };
    const manifest = { ...run.manifest, sources: [{ path: input.records[0].sourcePath, value: raw }], tasks: full ? [task] : [] };
    write(root, `${work}/manifest.json`, manifest);
    if (full) write(root, `${work}/tasks/batch-01.json`, task);
    write(root, `${work}/source/${input.records[0].sourcePath}`, raw);
    const destination = full ? 'app-data/candidate' : `app-data/targeted-${path.posix.basename(work)}`;
    write(root, `${destination}/operatives.json`, run.candidate.operatives);
    write(root, `${destination}/team-content.json`, run.candidate.teamContent);
    write(root, full ? 'review/reports/latest.json' : `${work}/report.json`, run.report);
  };
  save('staging/semantic-review-full', { candidate: input.baseline, report: input.baseReport,
    manifest: { runId: 'base', policyVersion: 1, records: input.records, baseline: input.rawBaseline } }, true);
  REVIEW_RUNS.forEach((name, index) => save(`staging/${name}`, input.makeOverlay(['selection'], name, index + 2, true)));
  write(root, 'review/reports/uncertainties.json', { entries: [] });
  write(root, 'output/team/front.jpg', 'front image fixture');
  write(root, 'output/team/back.jpg', 'back image fixture');
  return root;
}

test('disk assembly preflights, dry-runs without writes, produces deterministic hashes and preserves unrelated files', context => {
  const root = diskFixture(context);
  const preview = assembleAppData({ root, dryRun: true });
  assert.equal(preview.assets, 2);
  assert.equal(existsSync(path.join(root, 'app-data/current')), false);
  write(root, 'app-data/current/unrelated.txt', 'keep');
  const first = assembleAppData({ root });
  const filenames = ['operatives.json', 'team-content.json', 'release.json'];
  const bytes = filenames.map(name => readFileSync(path.join(root, 'app-data/current', name), 'utf8'));
  assert.deepEqual(first.release, preview.release);
  for (const [index, name] of filenames.slice(0, 2).entries()) {
    assert.equal(first.release.files[name].sha256, createHash('sha256').update(bytes[index]).digest('hex'));
  }
  assembleAppData({ root });
  assert.deepEqual(filenames.map(name => readFileSync(path.join(root, 'app-data/current', name), 'utf8')), bytes);
  assert.equal(readFileSync(path.join(root, 'app-data/current/unrelated.txt'), 'utf8'), 'keep');
  assert.equal(bytes.some(value => value.includes(root)), false);
});

test('missing reports, raw timestamp drift and missing images fail before creating outputs', context => {
  for (const sabotage of [
    root => rmSync(path.join(root, 'staging/semantic-review-markerlights-v7/report.json')),
    root => write(root, 'staging/semantic-review-full/source/output/team/data/team-team-data.json', { updated_at: '2020-01-01', datacards: [] }),
    root => rmSync(path.join(root, 'output/team/back.jpg')),
    root => write(root, 'review/reports/uncertainties.json', { entries: [{ id: 'pending' }] }),
  ]) {
    const root = diskFixture(context);
    sabotage(root);
    assert.throws(() => assembleAppData({ root }), /Missing path|snapshot mismatch|list is not empty/);
    assert.equal(existsSync(path.join(root, 'app-data/current')), false);
  }
});

test('all output paths are preflighted before any known output changes', context => {
  for (const sabotage of [
    root => mkdirSync(path.join(root, 'app-data/current/release.json')),
    root => write(root, 'app-data/current/release.json.assembling', 'do not overwrite'),
  ]) {
    const root = diskFixture(context);
    write(root, 'app-data/current/operatives.json', 'old data');
    sabotage(root);
    assert.throws(() => assembleAppData({ root }), /Non-regular path|Temporary output already exists/);
    assert.equal(readFileSync(path.join(root, 'app-data/current/operatives.json'), 'utf8'), 'old data');
    assert.equal(existsSync(path.join(root, 'app-data/current/team-content.json')), false);
  }
});

test('asset escapes and symlinked input/output paths are rejected', context => {
  const root = diskFixture(context);
  const outside = temporaryRoot(context);
  write(outside, 'file.jpg', 'outside');
  const link = path.join(root, 'app-data/current');
  try { symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { context.skip('Symlink permissions unavailable'); return; } throw error; }
  assert.throws(() => assembleAppData({ root }), /Symlink path/);
  assert.equal(existsSync(path.join(outside, 'release.json')), false);
  rmSync(link);
  rmSync(path.join(root, 'output/team'), { recursive: true });
  symlinkSync(outside, path.join(root, 'output/team'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assembleAppData({ root }), /Symlink path/);
});

test('image URL escapes are rejected even when consistent across all input snapshots', context => {
  for (const image of ['./output/../outside.jpg', 'https://example.test/image.jpg', 'output/%2e%2e/outside.jpg', 'output\\team\\front.jpg']) {
    const root = diskFixture(context);
    const files = ['app-data/candidate/operatives.json', ...REVIEW_RUNS.map(name => `app-data/targeted-${name}/operatives.json`)];
    for (const filename of files) {
      const operatives = JSON.parse(readFileSync(path.join(root, filename), 'utf8'));
      operatives[0].frontImage = image;
      write(root, filename, operatives);
    }
    const manifestFile = 'staging/semantic-review-full/manifest.json';
    const manifest = JSON.parse(readFileSync(path.join(root, manifestFile), 'utf8'));
    manifest.baseline.operatives[0].frontImage = image;
    write(root, manifestFile, manifest);
    assert.throws(() => assembleAppData({ root }), /Unsafe path|Image must be under output/);
    assert.equal(existsSync(path.join(root, 'app-data/current')), false);
  }
});

test('base source profiles cannot drift together with a reviewed candidate', () => {
  const input = fixture();
  input.sourceBaseline = input.rawBaseline;
  input.baseline.operatives[0].weapons[0].damage = '9/9';
  assert.throws(() => aggregateReviewedData(input), /Reviewed base profiles/);
});

test('raw payload changes cannot hide behind an unchanged timestamp', context => {
  const root = diskFixture(context);
  const work = `staging/${REVIEW_RUNS[0]}`;
  const manifest = JSON.parse(readFileSync(path.join(root, work, 'manifest.json'), 'utf8'));
  manifest.sources[0].value.datacards[0].name = 'Changed with same timestamp';
  write(root, `${work}/manifest.json`, manifest);
  write(root, `${work}/source/${manifest.sources[0].path}`, manifest.sources[0].value);
  assert.throws(() => assembleAppData({ root }), /Raw review sources changed/);
  assert.equal(existsSync(path.join(root, 'app-data/current')), false);
});

test('CLI root override and dry-run are write-free; unknown options fail', context => {
  const root = diskFixture(context);
  const script = path.resolve('scripts/assemble-app-data.mjs');
  const result = JSON.parse(execFileSync(process.execPath, [script, '--root', root, '--dry-run'], { encoding: 'utf8' }));
  assert.equal(result.dryRun, true);
  assert.equal(result.release.productionApproved, false);
  assert.equal(existsSync(path.join(root, 'app-data/current')), false);
  const invalid = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});