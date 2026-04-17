import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectBackend, loadFile, persistFile } from '../persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '.fixtures');

describe('detectBackend', () => {
  it('returns "local" when no tokens are set', () => {
    assert.equal(detectBackend({}), 'local');
  });

  it('returns "github" when GITHUB_TOKEN and GITHUB_REPO are set', () => {
    const env = { GITHUB_TOKEN: 'tok', GITHUB_REPO: 'owner/repo' };
    assert.equal(detectBackend(env), 'github');
  });

  it('returns "gitlab" when GITLAB_TOKEN and GITLAB_PROJECT_ID are set', () => {
    const env = { GITLAB_TOKEN: 'tok', GITLAB_PROJECT_ID: '123' };
    assert.equal(detectBackend(env), 'gitlab');
  });

  it('prefers gitlab over github when both are set', () => {
    const env = {
      GITHUB_TOKEN: 'tok', GITHUB_REPO: 'owner/repo',
      GITLAB_TOKEN: 'tok', GITLAB_PROJECT_ID: '123'
    };
    assert.equal(detectBackend(env), 'gitlab');
  });

  it('explicit PERSISTENCE_BACKEND overrides auto-detection', () => {
    const env = {
      PERSISTENCE_BACKEND: 'local',
      GITHUB_TOKEN: 'tok', GITHUB_REPO: 'owner/repo'
    };
    assert.equal(detectBackend(env), 'local');
  });

  it('accepts all valid backend values', () => {
    for (const backend of ['local', 'github', 'gitlab']) {
      assert.equal(detectBackend({ PERSISTENCE_BACKEND: backend }), backend);
    }
  });
});

describe('loadFile', () => {
  const fixtureFile = 'test/.fixtures/load-test.json';
  const fullPath = path.join(__dirname, '..', fixtureFile);

  before(() => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify([{ id: 1 }]) + '\n');
  });

  after(() => {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  });

  it('returns parsed JSON for an existing file', () => {
    const data = loadFile(fixtureFile);
    assert.deepEqual(data, [{ id: 1 }]);
  });

  it('returns null for a missing file', () => {
    const data = loadFile('nonexistent-file-12345.json');
    assert.equal(data, null);
  });
});

describe('persistFile (local backend)', () => {
  const testFile = 'test/.fixtures/persist-test.json';
  const fullPath = path.join(__dirname, '..', testFile);

  before(() => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  });

  after(() => {
    if (fs.existsSync(FIXTURES_DIR)) fs.rmSync(FIXTURES_DIR, { recursive: true });
  });

  it('writes JSON data to disk', async () => {
    const testData = [{ id: 1, name: 'test' }];
    await persistFile(testFile, testData, 'test commit');

    const written = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.deepEqual(written, testData);
  });

  it('overwrites existing file', async () => {
    await persistFile(testFile, { v: 1 }, 'first');
    await persistFile(testFile, { v: 2 }, 'second');

    const written = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.deepEqual(written, { v: 2 });
  });

  it('serializes concurrent writes', async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      persistFile(testFile, { seq: i }, `write ${i}`)
    );
    await Promise.all(writes);

    const written = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.equal(written.seq, 4);
  });
});
