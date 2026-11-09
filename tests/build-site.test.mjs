import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSite } from '../scripts/build-site.mjs';
import { createHash } from 'node:crypto';

function appLogic() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bstart\(\);/, '');
  const control = { addEventListener() {} };
  return runInNewContext(`${script}\n({ referenceBody, teamSummaryData, opponentSelection, briefingSetup, turningPointSelection, selectedTeamContent, renderOpponentSetup, operativeSourceLink, isKnownWeaponRule, findRuleMentions, ruleSourceBadges, state })`, {
    document: { querySelector: () => control, querySelectorAll: () => [] },
  });
}

test('reference display strips verified card headers without changing body or input', () => {
  const { referenceBody } = appLogic();
  const entry = { name: 'adjust-doctrine', text: 'ANGEL OF DEATH\nFIREFIGHT PLOY\nADJUST DOCTRINE\nLore.\nUse this ploy.' };
  assert.equal(referenceBody(entry), 'Lore.\nUse this ploy.');
  assert.match(entry.text, /^ANGEL OF DEATH/);
  assert.equal(referenceBody({ name: 'other', text: entry.text }), entry.text);
  assert.equal(referenceBody({ name: 'long-title', text: 'TEAM\nFACTION RULE\nLONG\nTITLE\nBody.' }), 'Body.');
  assert.equal(referenceBody({ name: 'rule', text: 'IMPORTANT\nDo not remove this.' }), 'IMPORTANT\nDo not remove this.');
});

test('v1 tags accept only catalog rules and documented variants, retaining custom profile text', () => {
  const { isKnownWeaponRule, findRuleMentions, teamSummaryData, state } = appLogic();
  state.weaponRuleNames = ['Lethal x+', 'Seek', 'Heavy', 'Balanced', 'Piercing Crits x'];
  for (const label of ['Lethal', 'Lethal 5+', 'Seek Light', 'Heavy (Dash only)', 'Heavy (Reposition only)', 'Piercing Crits 1']) {
    assert.equal(isKnownWeaponRule(label), true, label);
  }
  for (const label of ['Concealed Position*', 'Detonate*', 'Custom Ability', 'Balanced Blade', 'Lethal Mutation']) {
    assert.equal(isKnownWeaponRule(label), false, label);
  }
  assert.deepEqual(Array.from(findRuleMentions('Its ranged weapons have Seek Light.', state.weaponRuleNames)), ['Seek Light']);
  const operative = { name: 'Operative', weapons: [{ name: 'Weapon', special_rules: 'Balanced, Detonate*, Concealed Position*' }] };
  const before = JSON.stringify(operative);
  const result = teamSummaryData([operative], {});
  assert.deepEqual(Array.from(result.rules, entry => entry.name), ['Balanced']);
  assert.equal(JSON.stringify(operative), before);
});

test('reviewed grants replace lexical matches and include nested faction options', () => {
  const { teamSummaryData, state } = appLogic();
  state.weaponRuleNames = ['Brutal', 'Shock', 'Lethal x+', 'Seek', 'Balanced', 'Saturate'];
  const content = {
    firefightPloys: [{ name: 'Assault', type: 'Firefight ploy', text: 'Brutal narrative. Gain Shock.',
      weaponRuleEffects: [{ rule: 'Shock', kind: 'grant' }] }],
    equipment: [{ name: 'Shield', type: 'Equipment', text: 'Enemy Lethal 5+ does not apply.',
      weaponRuleEffects: [{ rule: 'Lethal 5+', kind: 'counter' }] }],
    factionRules: [{ name: 'Markerlights', type: 'Faction rule', text: 'Markerlight conditions.', weaponRuleEffects: [],
      options: [{ name: 'Benefits', text: '1 Saturate and Balanced. 4 Seek Light. 5 Seek.',
        weaponRuleEffects: ['Saturate', 'Balanced', 'Seek Light', 'Seek'].map(rule => ({ rule, kind: 'grant' })) }] }],
  };
  const result = teamSummaryData([], content);
  assert.deepEqual(Array.from(result.rules, rule => rule.name), ['Balanced', 'Saturate', 'Seek', 'Seek Light', 'Shock']);
  assert.equal(result.rules.find(rule => rule.name === 'Seek').ploys.values().next().value.type, 'Faction rule');
});

test('opponent selection starts full, remembers empty selections and isolates teams', () => {
  const { opponentSelection } = appLogic();
  const roster = [{ id: 'one' }, { id: 'two' }];
  const selected = opponentSelection('team', roster);
  assert.equal(selected.size, 2);
  selected.clear();
  assert.equal(opponentSelection('team', roster).size, 0);
  assert.equal(opponentSelection('other', roster).size, 2);
});

test('selected operatives narrow stats and rules while shared sources retain combination badges', () => {
  const { teamSummaryData, ruleSourceBadges, state } = appLogic();
  state.weaponRuleNames = ['Lethal x+', 'Balanced'];
  const roster = [
    { name: 'Leader', save: '3+', weapons: [{ name: 'Blade', special_rules: 'Lethal 5+' }] },
    { name: 'Trooper', save: '4+', weapons: [{ name: 'Gun', special_rules: 'Balanced' }] },
  ];
  const content = {
    equipment: [{ name: 'Upgrade', type: 'Equipment', text: 'Balanced' }],
    firefightPloys: [{ name: 'Ploy', type: 'Firefight ploy', text: 'Balanced' }],
    strategyPloys: [{ name: 'Strategy', type: 'Strategy ploy', text: 'Balanced' }],
  };
  const result = teamSummaryData(roster.slice(1), content);
  assert.equal(result.stats.find(stat => stat.label === 'Save').values.length, 1);
  assert.equal(result.stats.find(stat => stat.label === 'Save').values[0][0], '4+');
  assert.equal(result.rules.some(rule => rule.name === 'Lethal 5+'), false);
  const badges = ruleSourceBadges(result.rules[0]);
  for (const label of ['Weapon', 'Equipment', 'Firefight ploy', 'Strategy ploy']) {
    assert.ok(badges.includes(`aria-label="${label}"`));
  }
  const empty = teamSummaryData([], content);
  assert.equal(empty.rules[0].weapons.size, 0);
  assert.equal(empty.rules[0].ploys.size, 3);
});

test('equipment and ploys default to all, filter sources, and keep rounds and teams independent', () => {
  const { briefingSetup, turningPointSelection, selectedTeamContent, teamSummaryData, state } = appLogic();
  state.weaponRuleNames = ['Balanced', 'Lethal x+', 'Severe'];
  const content = {
    factionRules: [{ name: 'Faction', type: 'Faction rule', text: 'Balanced' }],
    equipment: [{ name: 'Upgrade', type: 'Equipment', text: 'Lethal 5+' }],
    strategyPloys: [{ name: 'Strategy', type: 'Strategy ploy', text: 'Severe' }],
    firefightPloys: [{ name: 'Firefight', type: 'Firefight ploy', text: 'Balanced' }],
  };
  const setup = briefingSetup('team', content);
  assert.equal(selectedTeamContent('team', content).equipment.length, 1);
  const roundOne = turningPointSelection(setup, content);
  setup.equipment.clear();
  roundOne.strategyPloys.clear();
  roundOne.firefightPloys.clear();
  const selected = selectedTeamContent('team', content);
  assert.equal(selected.equipment.length, 0);
  assert.equal(selected.strategyPloys.length, 0);
  assert.equal(selected.firefightPloys.length, 0);
  assert.equal(teamSummaryData([], selected).rules.length, 1);
  assert.equal(teamSummaryData([], selected).rules[0].name, 'Balanced');
  setup.round = 2;
  assert.equal(selectedTeamContent('team', content).strategyPloys.length, 1);
  assert.equal(selectedTeamContent('team', content).equipment.length, 0);
  setup.round = 1;
  assert.equal(selectedTeamContent('team', content).strategyPloys.length, 0);
  assert.equal(selectedTeamContent('other', content).equipment.length, 1);
  assert.equal(content.strategyPloys.length, 1);
});

test('setup renders accessible tabs, round-specific ploys and escaped selection labels', () => {
  const { renderOpponentSetup, briefingSetup, turningPointSelection } = appLogic();
  const roster = [{ id: 'team:leader', name: 'Leader <one>' }];
  const content = {
    equipment: [{ name: 'field-kit', text: 'Kit description' }],
    strategyPloys: [{ name: 'strategy', text: 'Strategy description' }],
    firefightPloys: [{ name: 'reaction', text: 'Reaction description' }],
  };
  const setup = briefingSetup('team', content);
  const selected = new Set(['team:leader']);
  let html = renderOpponentSetup(roster, content, selected, setup);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tabpanel" aria-labelledby="setup-tab-operatives"/);
  assert.match(html, /Leader &lt;one&gt;/);
  assert.match(html, /data-opponent-id="team:leader"/);
  setup.tab = 'equipment';
  html = renderOpponentSetup(roster, content, selected, setup);
  assert.match(html, /data-setup-group="equipment"/);
  assert.match(html, /field kit/);
  assert.match(html, /Kit description/);
  setup.tab = 'ploys';
  setup.round = 3;
  turningPointSelection(setup, content).strategyPloys.clear();
  html = renderOpponentSetup(roster, content, selected, setup);
  assert.match(html, /Turning point 3/);
  assert.match(html, /Ploys<small>1\/2<\/small>/);
  assert.match(html, /data-setup-group="strategyPloys"/);
  assert.match(html, /data-setup-group="firefightPloys"/);
});

test('operative source links use stable IDs and escape untrusted names', () => {
  const { operativeSourceLink } = appLogic();
  const roster = [{ id: 'team:leader', name: '<Leader>' }];
  assert.match(operativeSourceLink('<Leader>', roster), /data-source-operative="team:leader"/);
  assert.match(operativeSourceLink('<Leader>', roster), /&lt;Leader&gt;/);
  assert.equal(operativeSourceLink('<Unknown>', roster), '&lt;Unknown&gt;');
});

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'kt-site-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Fixture</title>');
  writeFileSync(join(root, 'data', 'operatives.json'), '[]');
  writeFileSync(join(root, 'output', 'card.jpg'), 'fixture');
  writeFileSync(join(root, 'private.txt'), 'not public');
  for (const directory of ['staging', 'review', 'app-data']) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, 'private-review.json'), '{"audit":"not public"}');
  }
  return root;
}

test('production publishes only public entries and security headers', (context) => {
  const root = fixture(context);
  const destination = buildSite(root, 'main');
  assert.equal(readFileSync(join(destination, 'data', 'operatives.json'), 'utf8'), '[]');
  assert.equal(readFileSync(join(destination, 'output', 'card.jpg'), 'utf8'), 'fixture');
  assert.equal(existsSync(join(destination, 'private.txt')), false);
  for (const directory of ['staging', 'review', 'app-data']) {
    assert.equal(existsSync(join(destination, directory)), false);
  }
  const headers = readFileSync(join(destination, '_headers'), 'utf8');
  assert.match(headers, /frame-ancestors 'none'/);
  assert.doesNotMatch(headers, /X-Robots-Tag/);
});

test('staging publishes only approved current app data and rejects tampering or production promotion', (context) => {
  function current(root) {
    const directory = join(root, 'app-data', 'current');
    mkdirSync(directory, { recursive: true });
    const files = { 'operatives.json': '[{"id":"reviewed"}]', 'team-content.json': '{"teams":{}}' };
    const release = { status: 'accepted-curated', unresolvedFindings: 0, completeCoverage: true, productionApproved: false, files: {} };
    for (const [filename, value] of Object.entries(files)) {
      writeFileSync(join(directory, filename), value);
      release.files[filename] = { sha256: createHash('sha256').update(value).digest('hex') };
    }
    writeFileSync(join(directory, 'release.json'), JSON.stringify(release));
    return directory;
  }
  const root = fixture(context);
  current(root);
  const destination = buildSite(root, 'staging');
  assert.match(readFileSync(join(destination, 'app-data/current/operatives.json'), 'utf8'), /reviewed/);
  assert.equal(readFileSync(join(destination, 'data/operatives.json'), 'utf8'), readFileSync(join(destination, 'app-data/current/operatives.json'), 'utf8'));
  assert.equal(existsSync(join(destination, 'app-data/private-review.json')), false);
  const production = fixture(context);
  current(production);
  assert.throws(() => buildSite(production, 'main'), /production release approval/);
  assert.equal(existsSync(join(production, 'public')), false);
  const tampered = fixture(context);
  const directory = current(tampered);
  writeFileSync(join(directory, 'operatives.json'), '[{"id":"tampered"}]');
  assert.throws(() => buildSite(tampered, 'staging'), /integrity mismatch/);
  assert.equal(existsSync(join(tampered, 'public')), false);
});

test('staging and feature previews discourage search indexing', (context) => {
  for (const branch of ['staging', 'feature/new-ui']) {
    const root = fixture(context);
    const destination = buildSite(root, branch);
    assert.match(readFileSync(join(destination, '_headers'), 'utf8'), /X-Robots-Tag: noindex, nofollow, noarchive/);
  }
});

test('an unsafe snapshot fails before creating a public directory', (context) => {
  const root = fixture(context);
  symlinkSync(join(root, 'data'), join(root, 'output', 'linked-data'), 'junction');
  assert.throws(() => buildSite(root), /symbolic links/);
  assert.equal(existsSync(join(root, 'public')), false);
});

test('an existing build is never overwritten', (context) => {
  const root = fixture(context);
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public', 'keep.txt'), 'keep');
  assert.throws(() => buildSite(root), /already exists/);
  assert.equal(readFileSync(join(root, 'public', 'keep.txt'), 'utf8'), 'keep');
});