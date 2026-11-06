import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicEntries = ['index.html', 'data', 'output'];

function validateEntry(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Public snapshot must not contain symbolic links: ${path}`);
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      validateEntry(join(path, entry));
    }
  } else if (!stat.isFile()) {
    throw new Error(`Public snapshot contains a non-regular file: ${path}`);
  }
}

export function buildSite(root, branch = 'main') {
  const destination = join(root, 'public');
  if (existsSync(destination)) {
    throw new Error('public already exists; remove the previous build explicitly before rebuilding');
  }
  for (const entry of publicEntries) {
    const source = join(root, entry);
    validateEntry(source);
    const stat = lstatSync(source);
    if (entry === 'index.html' ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Unexpected public entry type: ${entry}`);
    }
  }
  mkdirSync(destination);
  for (const entry of publicEntries) {
    cpSync(join(root, entry), join(destination, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const headers = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    "  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  ];
  if (branch !== 'main') {
    headers.push('  X-Robots-Tag: noindex, nofollow, noarchive');
  }
  writeFileSync(join(destination, '_headers'), `${headers.join('\n')}\n`);
  return destination;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const destination = buildSite(process.cwd(), process.env.CF_PAGES_BRANCH || 'main');
  console.log(`Static site assembled in ${destination}`);
}