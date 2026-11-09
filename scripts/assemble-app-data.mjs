import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REVIEW_RUNS = Object.freeze([
  'semantic-review-three-v2', 'semantic-review-scope-v3', 'semantic-review-match-first-v4',
  'semantic-review-core-only-v5', 'semantic-review-bypass-v6',
  'semantic-review-parent-context-v6', 'semantic-review-markerlights-v7',
]);
const CATEGORIES = { faction_rules: 'factionRules', strategy_ploys: 'strategyPloys',
  firefight_ploys: 'firefightPloys', equipment: 'equipment', operatives_selection: 'operativeSelection' };
const FRESHNESS = ['sourceUpdatedAt', 'contextUpdatedAt', 'integrationUpdatedAt', 'catalogUpdatedAt', 'sourcePath', 'pointer'];
const REVIEW_KEYS = new Set(['status', 'reviewVersion', 'sourceUpdatedAt', 'contextUpdatedAt',
  'integrationUpdatedAt', 'catalogUpdatedAt', 'policyVersion', 'sourcePath', 'pointer',
  'uncertain', 'assembly', 'provenance']);
const PRIVATE_KEYS = new Set(['raw', 'audit', 'reason', 'reasoning', 'notes', 'reviewNotes',
  'policyImprovements', 'changedCards', 'findings', 'logicalText', 'removals', 'flavour']);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `Expected object: ${label}`);
  return value;
}

function array(value, label) {
  requireThat(Array.isArray(value), `Expected array: ${label}`);
  return value;
}

function parts(pointer) {
  requireThat(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/.test(pointer), `Invalid pointer: ${pointer}`);
  const result = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  requireThat(!result.some(part => ['__proto__', 'prototype', 'constructor'].includes(part)), `Unsafe pointer: ${pointer}`);
  return result;
}

function at(value, pointer) {
  for (const part of parts(pointer)) {
    requireThat(value !== null && typeof value === 'object' && Object.hasOwn(value, part), `Missing pointer: ${pointer}`);
    value = value[part];
  }
  return value;
}

function replace(value, pointer, replacement) {
  const keys = parts(pointer);
  const key = keys.pop();
  let parent = value;
  for (const part of keys) parent = parent[part];
  requireThat(Object.hasOwn(parent, key), `Missing pointer: ${pointer}`);
  parent[key] = structuredClone(replacement);
}

function equal(actual, expected, message) {
  requireThat(isDeepStrictEqual(actual, expected), message);
}

function counts(dataset) {
  array(dataset.operatives, 'operatives');
  const teams = object(dataset.teamContent?.teams, 'teams');
  return { teams: Object.keys(teams).length, operatives: dataset.operatives.length };
}

function parentPointers(dataset) {
  const pointers = dataset.operatives.map((operative, index) => `/operatives/${index}`);
  for (const [team, content] of Object.entries(dataset.teamContent.teams)) {
    requireThat(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team), `Invalid team: ${team}`);
    for (const category of Object.values(CATEGORIES)) {
      array(content[category], `${team}/${category}`).forEach((entry, index) => {
        object(entry, `${team}/${category}/${index}`);
        pointers.push(`/teamContent/teams/${team}/${category}/${index}`);
      });
    }
  }
  return pointers.sort();
}

function walk(value, visit, pointer = '') {
  if (!value || typeof value !== 'object') return;
  visit(value, pointer);
  for (const [key, child] of Object.entries(value)) walk(child, visit, `${pointer}/${key}`);
}

function protectedFields(dataset) {
  const fields = {};
  walk(dataset, (value, pointer) => {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'weapons' || key === 'cards' || /image/i.test(key)) fields[`${pointer}/${key}`] = child;
    }
  });
  return fields;
}

function immutableParent(parent) {
  return Object.fromEntries(Object.entries(parent).filter(([key]) => ![
    'text', 'description', 'options', 'passiveAbilities', 'uniqueActions',
    'weaponRuleEffects', 'semanticReview', 'provenance',
  ].includes(key)));
}

function freshness(actual, expected, label) {
  for (const key of FRESHNESS) {
    requireThat(typeof expected[key] === 'string' && expected[key].length > 0, `Missing mapping ${key}: ${expected.id}`);
    equal(actual?.[key], expected[key], `Source revision mismatch (${key}): ${label}`);
  }
}

function identity(report, label) {
  object(report, `${label} report`);
  requireThat(typeof report.runId === 'string' && report.runId.length > 0, `Missing run ID: ${label}`);
  requireThat(Number.isSafeInteger(report.policyVersion) && report.policyVersion > 0, `Missing policy version: ${label}`);
  requireThat(report.reviewVersion === 1, `Unsupported review version: ${label}`);
  array(report.uncertainties, `${label} uncertainties`);
}

function validateReview(parent, record, report) {
  const metadata = object(parent.semanticReview, `review metadata: ${record.id}`);
  requireThat(metadata.pointer === record.pointer || metadata.pointer?.startsWith(`${record.pointer}/`),
    `Review pointer mismatch: ${record.id}`);
  freshness({ ...metadata, pointer: record.pointer }, record, record.id);
  equal(metadata.policyVersion, report.policyVersion, `Review policy mismatch: ${record.id}`);
  equal(metadata.reviewVersion, report.reviewVersion, `Review version mismatch: ${record.id}`);
  requireThat(typeof metadata.uncertain === 'boolean', `Missing review uncertainty: ${record.id}`);
  walk(parent, value => {
    if (value.semanticReview) {
      const review = value.semanticReview;
      for (const key of FRESHNESS.filter(key => key !== 'pointer')) {
        equal(review[key], record[key], `Source revision mismatch (${key}): ${record.id}`);
      }
      requireThat(review.pointer === record.pointer || review.pointer?.startsWith(`${record.pointer}/`), `Review pointer mismatch: ${record.id}`);
      equal(review.policyVersion, report.policyVersion, `Review policy mismatch: ${record.id}`);
    }
  });
}

function publicCopy(dataset) {
  const copy = structuredClone(dataset);
  walk(copy, value => {
    if (value.semanticReview) {
      value.semanticReview = Object.fromEntries(Object.entries(value.semanticReview).filter(([key]) => REVIEW_KEYS.has(key)));
    }
  });
  walk(copy, (value, pointer) => {
    for (const key of Object.keys(value)) requireThat(!PRIVATE_KEYS.has(key), `Private audit field: ${pointer}/${key}`);
  });
  return copy;
}

export function aggregateReviewedData({ baseline, sourceBaseline, records, baseReport, overlays, uncertaintyList }) {
  requireThat(array(uncertaintyList?.entries, 'maintained uncertainty entries').length === 0, 'Maintained uncertainty list is not empty');
  const baselineCounts = counts(baseline);
  const expectedPointers = parentPointers(baseline);
  if (sourceBaseline) {
    equal(counts(sourceBaseline), baselineCounts, 'Source baseline counts mismatch');
    equal(parentPointers(sourceBaseline), expectedPointers, 'Source baseline parent coverage mismatch');
    equal(protectedFields(baseline), protectedFields(sourceBaseline), 'Reviewed base profiles or assets changed from source');
  }
  array(records, 'mapping records');
  const mapping = new Map();
  for (const record of records) {
    requireThat(typeof record.id === 'string' && !mapping.has(record.id), `Duplicate or invalid mapping ID: ${record.id}`);
    object(at(baseline, record.normalizedBase), record.id);
    const expected = record.category === 'datacards' ? /^\/operatives\/\d+$/
      : new RegExp(`^/teamContent/teams/${record.team}/${CATEGORIES[record.category]}/\\d+$`);
    requireThat(expected.test(record.normalizedBase), `Invalid parent mapping: ${record.id}`);
    if (sourceBaseline) equal(immutableParent(at(baseline, record.normalizedBase)),
      immutableParent(at(sourceBaseline, record.normalizedBase)), `Reviewed base mechanics changed: ${record.id}`);
    if (record.category === 'datacards' && record.raw) equal(at(baseline, record.normalizedBase).weapons,
      record.raw.weapons ?? [], `Reviewed base direct profiles changed: ${record.id}`);
    mapping.set(record.id, record);
  }
  equal(records.map(record => record.normalizedBase).sort(), expectedPointers, 'Full mapping coverage mismatch');
  identity(baseReport, 'base');
  requireThat(baseReport.completeCoverage === true && baseReport.wholeSourceCoverage !== false
    && baseReport.assignedCoverageComplete !== false, 'Base requires full reviewed coverage');
  equal(baseReport.coverage?.records, records.length, 'Base record coverage mismatch');
  equal(baseReport.coverage?.datacards, baselineCounts.operatives, 'Base operative coverage mismatch');
  equal(baseReport.coverage?.teams, baselineCounts.teams, 'Base team coverage mismatch');
  for (const record of records) validateReview(at(baseline, record.normalizedBase), record, baseReport);
  const aggregate = structuredClone(baseline);
  const runs = [{ runId: baseReport.runId, policyVersion: baseReport.policyVersion,
    kind: 'full', records: records.length, automaticCopies: 0 }];
  const seenRuns = new Set([baseReport.runId]);
  const pendingUncertainties = new Map();
  for (const finding of baseReport.uncertainties) {
    requireThat(mapping.has(finding.id), 'Unknown base uncertainty record');
    pendingUncertainties.set(finding.id, baseReport.runId);
  }
  for (const overlay of array(overlays, 'overlays')) {
    const { report, candidate, manifest } = overlay;
    identity(report, 'overlay');
    requireThat(!seenRuns.has(report.runId), `Duplicate run ID: ${report.runId}`);
    seenRuns.add(report.runId);
    object(manifest, 'overlay manifest');
    equal(report.runId, manifest.runId, 'Manifest/report run mismatch');
    equal(report.policyVersion, manifest.policyVersion, 'Manifest/report policy mismatch');
    requireThat(manifest.scope?.kind === 'targeted' && report.assignedCoverageComplete === true, 'Incomplete assigned coverage');
    equal(report.scope, manifest.scope, 'Manifest/report scope mismatch');
    const ids = array(manifest.scope.recordIds, 'scoped IDs');
    requireThat(ids.length > 0 && new Set(ids).size === ids.length, 'Empty or duplicate scope IDs');
    equal(manifest.scope.sourceRecords, records.length, 'Scope source coverage mismatch');
    equal(manifest.scope.selectedRecords, ids.length, 'Scope selected coverage mismatch');
    equal(report.coverage?.records, ids.length, 'Incomplete assigned record coverage');
    for (const id of ids) pendingUncertainties.delete(id);
    for (const finding of report.uncertainties) {
      requireThat(ids.includes(finding.id), 'Uncertainty outside overlay scope');
      pendingUncertainties.set(finding.id, report.runId);
    }
    const revisions = new Map(array(manifest.records, 'manifest revisions').map(record => [record.id, record]));
    requireThat(revisions.size === manifest.records.length, 'Duplicate manifest record IDs');
    equal([...revisions.keys()].sort(), [...mapping.keys()].sort(), 'Manifest inventory coverage mismatch');
    for (const [id, revision] of revisions) freshness(revision, mapping.get(id), id);
    equal(counts(candidate), baselineCounts, 'Candidate counts mismatch');
    equal(parentPointers(candidate), expectedPointers, 'Candidate parent coverage mismatch');
    equal(protectedFields(candidate), protectedFields(baseline), 'Direct profiles or image URLs/cards changed');
    const bypasses = array(report.automaticCopies ?? [], 'automatic copies');
    const bypassIds = new Set(bypasses.map(entry => entry.id));
    requireThat(bypassIds.size === bypasses.length && [...bypassIds].every(id => ids.includes(id)), 'Invalid automatic-copy scope');
    if (report.coverage.automaticCopies !== undefined) equal(report.coverage.automaticCopies, bypassIds.size, 'Automatic-copy coverage mismatch');
    if (report.coverage.reviewedRecords !== undefined) equal(report.coverage.reviewedRecords, ids.length - bypassIds.size, 'Reviewed coverage mismatch');
    for (const id of ids) {
      const record = mapping.get(id);
      requireThat(record, `Unknown scoped ID: ${id}`);
      const parent = object(at(candidate, record.normalizedBase), id);
      equal(immutableParent(parent), immutableParent(at(baseline, record.normalizedBase)), `Parent mechanics changed: ${id}`);
      if (bypassIds.has(id)) {
        requireThat(bypasses.find(entry => entry.id === id).status === 'automatic-copy', `Invalid bypass: ${id}`);
        requireThat(manifest.baseline, `Missing normalized bypass baseline: ${id}`);
        equal(parent, at(manifest.baseline, record.normalizedBase), `Bypass must be verbatim normalized baseline: ${id}`);
        if (sourceBaseline) equal(parent, at(sourceBaseline, record.normalizedBase), `Bypass source baseline mismatch: ${id}`);
      } else validateReview(parent, record, report);
      replace(aggregate, record.normalizedBase, parent);
    }
    runs.push({ runId: report.runId, policyVersion: report.policyVersion, kind: 'targeted',
      records: ids.length, automaticCopies: bypassIds.size });
  }
  requireThat(pendingUncertainties.size === 0, `Unresolved report uncertainty: ${[...pendingUncertainties.keys()].join(', ')}`);
  const acceptance = { status: 'accepted-curated', acceptanceOnly: true, productionApproved: false,
    semanticCorrectnessProven: false, completeCoverage: true, assignedCoverageComplete: true,
    wholeSourceCoverage: true, uncertain: false, unresolvedFindings: 0,
    mixedProvenance: true, reviewedRuns: runs, policyVersions: [...new Set(runs.map(run => run.policyVersion))] };
  aggregate.teamContent.semanticReview = acceptance;
  walk(aggregate, (value, pointer) => {
    requireThat(value.semanticReview?.uncertain !== true, `Unresolved semantic review: ${pointer}`);
    if (value.weaponRuleEffects !== undefined) {
      requireThat(!array(value.weaponRuleEffects, `effects: ${pointer}`).some(effect => effect.kind === 'uncertain'), `Unresolved weapon effect: ${pointer}`);
    }
  });
  equal(counts(aggregate), baselineCounts, 'Aggregate counts mismatch');
  equal(protectedFields(aggregate), protectedFields(baseline), 'Aggregate profiles or assets changed');
  const result = publicCopy(aggregate);
  result.teamContent.semanticReview = acceptance;
  const files = { 'operatives.json': digest(json(result.operatives)), 'team-content.json': digest(json(result.teamContent)) };
  return { ...result, release: { schemaVersion: 1, ...acceptance, counts: { ...baselineCounts, records: records.length },
    files: Object.fromEntries(Object.entries(files).map(([name, sha256]) => [name, { sha256 }])) } };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function json(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safePath(root, relative, { file = false, missing = false } = {}) {
  requireThat(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\')
    && !relative.includes(':') && !relative.includes('%') && !relative.includes('?') && !relative.includes('#')
    && !path.posix.isAbsolute(relative) && !relative.split('/').some(part => part === '..' || part === ''), `Unsafe path: ${relative}`);
  const destination = path.resolve(root, relative);
  requireThat(destination.startsWith(`${root}${path.sep}`), `Path escapes root: ${relative}`);
  const segments = destination.slice(path.parse(destination).root.length).split(path.sep);
  let current = path.parse(destination).root;
  segments.forEach((segment, index) => {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      let dangling = false;
      try { dangling = lstatSync(current).isSymbolicLink(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      requireThat(!dangling && missing, `Missing path: ${relative}`);
      return;
    }
    const stat = lstatSync(current);
    requireThat(!stat.isSymbolicLink(), `Symlink path rejected: ${relative}`);
    const final = index === segments.length - 1;
    requireThat(final && file ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(), `Non-regular path: ${relative}`);
  });
  return destination;
}

function read(root, relative) {
  return JSON.parse(readFileSync(safePath(root, relative, { file: true }), 'utf8'));
}

function loadRun(root, work, full = false) {
  const manifest = read(root, `${work}/manifest.json`);
  const fallback = full ? ['app-data/candidate/operatives.json', 'app-data/candidate/team-content.json', 'review/reports/latest.json']
    : [`app-data/targeted-${path.posix.basename(work)}/operatives.json`,
      `app-data/targeted-${path.posix.basename(work)}/team-content.json`, `${work}/report.json`];
  const initialReport = read(root, fallback[2]);
  const destinations = initialReport.destinations ?? fallback;
  requireThat(Array.isArray(destinations) && destinations.length >= 3, 'Malformed report destinations');
  for (const [index, name] of ['operatives.json', 'team-content.json'].entries()) {
    requireThat(typeof destinations[index] === 'string' && /^app-data\/[^/]+\/[^/]+$/.test(destinations[index])
      && path.posix.basename(destinations[index]) === name
      && !path.posix.normalize(destinations[index]).startsWith('app-data/current/'), 'Unsafe candidate destinations');
  }
  const report = destinations[2] === fallback[2] ? initialReport : read(root, destinations[2]);
  equal(report.runId, manifest.runId, 'Manifest/report run mismatch');
  equal(report.policyVersion, manifest.policyVersion, 'Manifest/report policy mismatch');
  const candidate = { operatives: read(root, destinations[0]), teamContent: read(root, destinations[1]) };
  const tasks = array(manifest.tasks, 'manifest tasks').map(expected => {
    requireThat(/^[a-zA-Z0-9_-]+$/.test(expected.batchId), 'Unsafe task batch ID');
    const actual = read(root, `${work}/tasks/${expected.batchId}.json`);
    equal(actual, expected, `Task/manifest mismatch: ${expected.batchId}`);
    return actual;
  });
  const records = tasks.flatMap(task => array(task.records, 'task records'));
  const revisions = array(manifest.records, 'manifest records');
  const revisionById = new Map(revisions.map(record => [record.id, record]));
  requireThat(revisionById.size === revisions.length, 'Duplicate manifest record IDs');
  const sources = new Map();
  for (const source of array(manifest.sources, 'manifest sources')) {
    requireThat(!sources.has(source.path), `Duplicate raw source: ${source.path}`);
    const raw = read(root, `${work}/source/${source.path}`);
    equal(raw, source.value, `Raw snapshot mismatch: ${source.path}`);
    sources.set(source.path, raw);
  }
  for (const record of revisions) {
    requireThat(sources.has(record.sourcePath), `Missing raw source: ${record.id}`);
    const raw = sources.get(record.sourcePath);
    let updated = null;
    const parent = at(raw, record.pointer);
    for (const container of [parent, raw]) {
      const stamps = [container, container.metadata].filter(Boolean).flatMap(value =>
        ['modified_at', 'modifiedAt', 'updated_at', 'updatedAt', 'last_modified', 'lastModified', 'generated_at', 'generatedAt']
          .filter(key => Object.hasOwn(value, key)).map(key => ({ key, timestamp: value[key] })));
      const modified = stamps.filter(item => !item.key.startsWith('generated'));
      if (stamps.length) {
        for (const item of stamps) requireThat(typeof item.timestamp === 'string' && Number.isFinite(Date.parse(item.timestamp)), 'Invalid raw source timestamp');
        updated = (modified.length ? modified : stamps).sort((first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp))[0].timestamp;
        break;
      }
    }
    equal(updated, record.sourceUpdatedAt, `Raw source timestamp mismatch: ${record.id}`);
  }
  for (const record of records) {
    freshness(revisionById.get(record.id), record, record.id);
    equal(record.raw, at(sources.get(record.sourcePath), record.pointer), `Task/raw source mismatch: ${record.id}`);
  }
  return { manifest, report, candidate, records, sources: Object.fromEntries(sources) };
}

function validateAssets(root, dataset) {
  const assets = new Set();
  walk(dataset, value => {
    for (const [key, child] of Object.entries(value)) {
      if (!/image(?:url)?$/i.test(key)) continue;
      requireThat(typeof child === 'string' && child.length > 0, `Missing image URL: ${key}`);
      const relative = child.startsWith('./') ? child.slice(2) : child;
      requireThat(relative.startsWith('output/'), `Image must be under output: ${child}`);
      safePath(root, relative, { file: true });
      assets.add(relative);
    }
  });
  return assets.size;
}

export function assembleAppData({ root = ROOT, dryRun = false } = {}) {
  root = path.resolve(root);
  const uncertaintyList = read(root, 'review/reports/uncertainties.json');
  requireThat(array(uncertaintyList.entries, 'maintained uncertainty entries').length === 0, 'Maintained uncertainty list is not empty');
  const full = loadRun(root, 'staging/semantic-review-full', true);
  object(full.manifest.baseline, 'full normalized source baseline');
  const overlays = REVIEW_RUNS.map(name => loadRun(root, `staging/${name}`));
  for (const overlay of overlays) equal(overlay.sources, full.sources, `Raw review sources changed: ${overlay.report.runId}`);
  const dataset = aggregateReviewedData({ baseline: full.candidate, sourceBaseline: full.manifest.baseline, records: full.records,
    baseReport: full.report, overlays, uncertaintyList });
  const assets = validateAssets(root, dataset);
  const filenames = ['operatives.json', 'team-content.json', 'release.json'];
  const values = [dataset.operatives, dataset.teamContent, dataset.release];
  const outputs = filenames.map((name, index) => {
    const relative = `app-data/current/${name}`;
    const destination = safePath(root, relative, { file: true, missing: true });
    const temporary = safePath(root, `${relative}.assembling`, { file: true, missing: true });
    requireThat(!existsSync(temporary), `Temporary output already exists: ${relative}.assembling`);
    return { destination, temporary, bytes: json(values[index]) };
  });
  if (!dryRun) {
    mkdirSync(path.join(root, 'app-data/current'), { recursive: true });
    const owned = new Set();
    try {
      for (const output of outputs) {
        writeFileSync(output.temporary, output.bytes, { flag: 'wx' });
        owned.add(output.temporary);
      }
      for (const output of outputs) {
        renameSync(output.temporary, output.destination);
        owned.delete(output.temporary);
      }
    } finally {
      for (const temporary of owned) unlinkSync(temporary);
    }
  }
  return { dryRun, destinations: filenames.map(name => `app-data/current/${name}`), assets, release: dataset.release };
}

function main(argv) {
  const options = {};
  while (argv.length) {
    const argument = argv.shift();
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--root' && argv.length) options.root = argv.shift();
    else throw new Error('Usage: node scripts/assemble-app-data.mjs [--root path] [--dry-run]');
  }
  console.log(json(assembleAppData(options)).trimEnd());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}