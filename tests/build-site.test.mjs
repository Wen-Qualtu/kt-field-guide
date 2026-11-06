import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSite } from '../scripts/build-site.mjs';

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