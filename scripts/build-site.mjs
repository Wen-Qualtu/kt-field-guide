import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const curated = join(root, 'app-data', 'current');
  const hasCurated = existsSync(curated);
  if (hasCurated) {
    validateEntry(curated);
    const release = JSON.parse(readFileSync(join(curated, 'release.json'), 'utf8'));
    if (release.status !== 'accepted-curated' || release.unresolvedFindings !== 0 || !release.completeCoverage) {
      throw new Error('Curated app data is not approved for acceptance');
    }
    if (branch === 'main' && release.productionApproved !== true) {
      throw new Error('Curated app data is acceptance-only; production release approval is required');
    }
    for (const filename of ['operatives.json', 'team-content.json']) {
      const digest = createHash('sha256').update(readFileSync(join(curated, filename))).digest('hex');
      if (digest !== release.files?.[filename]?.sha256) throw new Error(`Curated release integrity mismatch: ${filename}`);
    }
  }
  const entries = publicEntries.filter(entry => !hasCurated || entry !== 'data');
  for (const entry of entries) {
    const source = join(root, entry);
    validateEntry(source);
    const stat = lstatSync(source);
    if (entry === 'index.html' ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Unexpected public entry type: ${entry}`);
    }
  }
  mkdirSync(destination);
  for (const entry of entries) {
    cpSync(join(root, entry), join(destination, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  if (hasCurated) {
    const published = join(destination, 'app-data', 'current');
    mkdirSync(published, { recursive: true });
    mkdirSync(join(destination, 'data'));
    for (const filename of ['operatives.json', 'team-content.json', 'release.json']) {
      cpSync(join(curated, filename), join(published, filename));
      cpSync(join(curated, filename), join(destination, 'data', filename));
    }
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