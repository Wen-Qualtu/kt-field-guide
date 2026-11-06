import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSite } from '../scripts/build-site.mjs';

function appLogic() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bstart\(\);/, '');
  const control = { addEventListener() {} };
  return runInNewContext(`${script}\n({ referenceBody, teamSummaryData, opponentSelection, ruleSourceBadges, state })`, {
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

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'kt-site-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Fixture</title>');
  writeFileSync(join(root, 'data', 'operatives.json'), '[]');
  writeFileSync(join(root, 'output', 'card.jpg'), 'fixture');
  writeFileSync(join(root, 'private.txt'), 'not public');
  return root;
}

test('production publishes only public entries and security headers', (context) => {
  const root = fixture(context);
  const destination = buildSite(root, 'main');
  assert.equal(readFileSync(join(destination, 'data', 'operatives.json'), 'utf8'), '[]');
  assert.equal(readFileSync(join(destination, 'output', 'card.jpg'), 'utf8'), 'fixture');
  assert.equal(existsSync(join(destination, 'private.txt')), false);
  const headers = readFileSync(join(destination, '_headers'), 'utf8');
  assert.match(headers, /frame-ancestors 'none'/);
  assert.doesNotMatch(headers, /X-Robots-Tag/);
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