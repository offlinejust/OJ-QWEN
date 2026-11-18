const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createWorkspaceFiles } = require('../extension/lib/workspace-files.js');

// In-memory FileSystemDirectoryHandle / FileSystemFileHandle mock
function makeNotFound(name) {
  const err = new Error('Not found: ' + name);
  err.name = 'NotFoundError';
  return err;
}

class MockFileHandle {
  constructor(name, content = '') {
    this.kind = 'file';
    this.name = name;
    this._bytes = new TextEncoder().encode(content);
    this._mtime = Date.now();
  }
  async getFile() {
    const bytes = this._bytes;
    return {
      size: bytes.length,
      lastModified: this._mtime,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
  async createWritable() {
    let chunks = [];
    const self = this;
    return {
      async write(data) {
        chunks.push(data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)));
      },
      async close() {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        self._bytes = merged;
        self._mtime = Date.now() + 1;
      },
      async abort() {
        chunks = [];
      },
    };
  }
}

class MockDirHandle {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this._entries = new Map();
  }
  async getDirectoryHandle(name, opts = {}) {
    const entry = this._entries.get(name);
    if (entry) {
      if (entry.kind !== 'directory') {
        const e = new Error('TypeMismatch');
        e.name = 'TypeMismatchError';
        throw e;
      }
      return entry;
    }
    if (!opts.create) throw makeNotFound(name);
    const dir = new MockDirHandle(name);
    this._entries.set(name, dir);
    return dir;
  }
  async getFileHandle(name, opts = {}) {
    const entry = this._entries.get(name);
    if (entry) {
      if (entry.kind !== 'file') {
        const e = new Error('TypeMismatch');
        e.name = 'TypeMismatchError';
        throw e;
      }
      return entry;
    }
    if (!opts.create) throw makeNotFound(name);
    const file = new MockFileHandle(name, '');
    this._entries.set(name, file);
    return file;
  }
  async removeEntry(name, opts = {}) {
    const entry = this._entries.get(name);
    if (!entry) throw makeNotFound(name);
    if (entry.kind === 'directory' && entry._entries.size > 0 && !opts.recursive) {
      const err = new Error('Directory is not empty');
      err.name = 'InvalidModificationError';
      throw err;
    }
    this._entries.delete(name);
  }
  async *values() {
    for (const v of this._entries.values()) yield v;
  }
}

function makeMemoryStore() {
  const meta = new Map();
  const backups = new Map();
  return {
    async getMeta(k) { return meta.get(k); },
    async setMeta(k, v) { meta.set(k, structuredClone(v)); },
    async removeMeta(k) { meta.delete(k); },
    async addBackup(rec) { backups.set(rec.id, structuredClone(rec)); return rec; },
    async getBackup(id) { return backups.get(id); },
    async listBackups(chatKey) { return [...backups.values()].filter(b => b.chatKey === chatKey); },
    async markBackupRestored(id) {
      const b = backups.get(id);
      if (b) b.restoredAt = Date.now();
      return b;
    },
  };
}

test('list, search, read (lines), create (auto-mkdir), edit, diff, rename, delete + restore', async () => {
  const store = makeMemoryStore();
  const engine = createWorkspaceFiles({ store, cryptoImpl: webcrypto });
  const root = new MockDirHandle('my-app');
  const chatKey = 'c:test1234';

  // Seed files including normal code with "token" in name (must NOT be blocked!) and secret .env (MUST be blocked!)
  root._entries.set('README.md', new MockFileHandle('README.md', '# App\nstatus: draft\nline3\n'));
  root._entries.set('.env', new MockFileHandle('.env', 'SECRET=123'));
  const src = new MockDirHandle('src');
  src._entries.set('tokenizer.js', new MockFileHandle('tokenizer.js', 'export function tokenize(s) {\n  return s.split(" ");\n}\n'));
  root._entries.set('src', src);

  // 1. list
  const listRes = await engine.batch(chatKey, root, [{ op: 'list' }]);
  assert.deepEqual(listRes.results[0].files, ['README.md', 'src/tokenizer.js']);

  // 2. search
  const searchRes = await engine.batch(chatKey, root, [{ op: 'search', query: 'tokenize' }]);
  assert.equal(searchRes.results[0].matches.length, 1);
  assert.equal(searchRes.results[0].matches[0].path, 'src/tokenizer.js');
  assert.equal(searchRes.results[0].matches[0].line, 1);

  // 3. read with line range
  const readRes = await engine.batch(chatKey, root, [{ op: 'read', path: 'README.md', startLine: 1, endLine: 2 }]);
  const r0 = readRes.results[0];
  assert.equal(r0.text, '# App\nstatus: draft');
  assert.equal(r0.totalLines, 4);
  assert.ok(r0.version);

  // 4. edit + diff + backup restore
  const editRes = await engine.batch(chatKey, root, [
    { op: 'edit', path: 'README.md', version: r0.version, find: 'status: draft', replace: 'status: ready' },
  ]);
  const e0 = editRes.results[0];
  assert.equal(e0.changed, true);
  assert.ok(e0.backupId);
  assert.deepEqual(e0.diff.removed, ['status: draft']);
  assert.deepEqual(e0.diff.added, ['status: ready']);

  const diffRes = await engine.batch(chatKey, root, [{ op: 'diff', path: 'README.md' }]);
  assert.deepEqual(diffRes.results[0].added, ['status: ready']);

  // Restore edited file
  await engine.restore(chatKey, root, e0.backupId);
  const afterRestore = await engine.preview(root, 'README.md');
  assert.ok(afterRestore.text.includes('status: draft'));

  // 5. create with nested directories + restore (removes created file)
  const createRes = await engine.batch(chatKey, root, [
    { op: 'create', path: 'src/utils/helper.js', text: 'export const x = 1;\n' },
  ]);
  assert.equal(createRes.results[0].created, true);
  const helperContent = await engine.preview(root, 'src/utils/helper.js');
  assert.equal(helperContent.text, 'export const x = 1;\n');

  // 6. rename + restore
  const renameRes = await engine.batch(chatKey, root, [
    { op: 'rename', from: 'src/utils/helper.js', to: 'src/utils/math.js' },
  ]);
  assert.equal(renameRes.results[0].renamed, true);
  await assert.rejects(() => engine.preview(root, 'src/utils/helper.js'));
  const mathContent = await engine.preview(root, 'src/utils/math.js');
  assert.equal(mathContent.text, 'export const x = 1;\n');

  // 7. delete + restore
  const delRes = await engine.batch(chatKey, root, [{ op: 'delete', path: 'src/utils/math.js' }]);
  assert.equal(delRes.results[0].deleted, true);
  await assert.rejects(() => engine.preview(root, 'src/utils/math.js'));
  await engine.restore(chatKey, root, delRes.results[0].backupId);
  const restoredMath = await engine.preview(root, 'src/utils/math.js');
  assert.equal(restoredMath.text, 'export const x = 1;\n');

  // 8. mkdir + restore (removes empty folder)
  const mkdirRes = await engine.batch(chatKey, root, [{ op: 'mkdir', path: 'assets/icons' }]);
  assert.equal(mkdirRes.results[0].created, true);
  assert.ok(mkdirRes.results[0].backupId);
  const listAfterMkdir = await engine.batch(chatKey, root, [{ op: 'list' }]);
  assert.ok(listAfterMkdir.results[0].dirs.includes('assets/icons'));
  await engine.restore(chatKey, root, mkdirRes.results[0].backupId);
  const listAfterRestore = await engine.batch(chatKey, root, [{ op: 'list' }]);
  assert.ok(!listAfterRestore.results[0].dirs.includes('assets/icons'));
});

test('v1.1.0 tools: list(depth + binaryFiles), multi-edit atomicity, write, rmdir(recursive+restore), rename(dir+restore), validate', async () => {
  const store = makeMemoryStore();
  const engine = createWorkspaceFiles({ store, cryptoImpl: webcrypto });
  const root = new MockDirHandle('proj');
  const chatKey = 'c:v110';

  // Seed nested structure with binary asset
  const assets = new MockDirHandle('assets');
  assets._entries.set('logo.png', new MockFileHandle('logo.png', 'PNGDATA'));
  const deep = new MockDirHandle('deep');
  deep._entries.set('nested.js', new MockFileHandle('nested.js', 'const a = 1;\n'));
  assets._entries.set('deep', deep);
  root._entries.set('assets', assets);
  root._entries.set('app.js', new MockFileHandle('app.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n'));

  // 1. list with depth=1 and binaryFiles detection
  const l1 = await engine.batch(chatKey, root, [{ op: 'list', depth: 1 }]);
  assert.deepEqual(l1.results[0].files, ['app.js']);
  assert.deepEqual(l1.results[0].dirs, ['assets']);
  const lAll = await engine.batch(chatKey, root, [{ op: 'list' }]);
  assert.deepEqual(lAll.results[0].binaryFiles, ['assets/logo.png']);
  assert.ok(lAll.results[0].files.includes('assets/deep/nested.js'));

  // 2. atomic multi-edit: failure on 2nd edit must NOT touch disk
  const r0 = (await engine.batch(chatKey, root, [{ op: 'read', path: 'app.js' }])).results[0];
  const badMulti = await engine.batch(chatKey, root, [{
    op: 'edit',
    path: 'app.js',
    version: r0.version,
    edits: [
      { find: 'const a = 1;', replace: 'const a = 10;' },
      { find: 'DOES_NOT_EXIST', replace: 'x' },
    ],
  }]);
  assert.ok(badMulti.results[0].error.includes('Правка #2'));
  assert.equal((await engine.preview(root, 'app.js')).text, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

  // Successful multi-edit in one shot
  const okMulti = await engine.batch(chatKey, root, [{
    op: 'edit',
    path: 'app.js',
    version: r0.version,
    edits: [
      { find: 'const a = 1;', replace: 'const a = 10;' },
      { find: 'const c = 3;', replace: 'const c = 30;' },
    ],
  }]);
  assert.equal(okMulti.results[0].appliedEdits, 2);
  assert.equal((await engine.preview(root, 'app.js')).text, 'const a = 10;\nconst b = 2;\nconst c = 30;\n');

  // 3. write (full overwrite with version guard + restore)
  const badWrite = await engine.batch(chatKey, root, [{ op: 'write', path: 'app.js', version: 'wrong', text: 'x' }]);
  assert.ok(badWrite.results[0].error);
  const okWrite = await engine.batch(chatKey, root, [{
    op: 'write',
    path: 'app.js',
    version: okMulti.results[0].version,
    text: 'export const rewritten = true;\n',
  }]);
  assert.equal(okWrite.results[0].changed, true);
  assert.equal((await engine.preview(root, 'app.js')).text, 'export const rewritten = true;\n');
  await engine.restore(chatKey, root, okWrite.results[0].backupId);
  assert.equal((await engine.preview(root, 'app.js')).text, 'const a = 10;\nconst b = 2;\nconst c = 30;\n');

  // 4. rename directory + prevent moving into itself + restore
  const selfMove = await engine.batch(chatKey, root, [{ op: 'rename', from: 'assets', to: 'assets/sub' }]);
  assert.ok(selfMove.results[0].error);
  const renDir = await engine.batch(chatKey, root, [{ op: 'rename', from: 'assets', to: 'media' }]);
  assert.equal(renDir.results[0].renamed, true);
  assert.equal(renDir.results[0].kind, 'directory');
  assert.equal((await engine.preview(root, 'media/deep/nested.js')).text, 'const a = 1;\n');
  await engine.restore(chatKey, root, renDir.results[0].backupId);
  assert.equal((await engine.preview(root, 'assets/deep/nested.js')).text, 'const a = 1;\n');

  // 5. rmdir: non-empty blocked without recursive, recursive deletes & restores all text files
  const nonEmptyErr = await engine.batch(chatKey, root, [{ op: 'rmdir', path: 'assets' }]);
  assert.ok(nonEmptyErr.results[0].error.includes('не пуста'));
  const recDel = await engine.batch(chatKey, root, [{ op: 'rmdir', path: 'assets', recursive: true }]);
  assert.equal(recDel.results[0].deleted, true);
  assert.equal(recDel.results[0].backedUpFiles, 1);
  assert.equal(recDel.results[0].partialBackup, true); // because logo.png is binary
  await assert.rejects(() => engine.preview(root, 'assets/deep/nested.js'));
  await engine.restore(chatKey, root, recDel.results[0].backupId);
  assert.equal((await engine.preview(root, 'assets/deep/nested.js')).text, 'const a = 1;\n');

  // 6. validate: JSON, JS delimiters, Python mixed indentation
  await engine.batch(chatKey, root, [
    { op: 'create', path: 'good.json', text: '{"ok":true}' },
    { op: 'create', path: 'bad.json', text: '{"ok": true,}' },
    { op: 'create', path: 'bad.js', text: 'function f() {\n  const x = [1, 2};\n' },
    { op: 'create', path: 'bad.py', text: 'def f():\n\t x = 1\n' },
  ]);
  const valRes = await engine.batch(chatKey, root, [
    { op: 'validate', path: 'good.json' },
    { op: 'validate', path: 'bad.json' },
    { op: 'validate', path: 'bad.js' },
    { op: 'validate', path: 'bad.py' },
  ]);
  assert.equal(valRes.results[0].valid, true);
  assert.equal(valRes.results[1].valid, false);
  assert.equal(valRes.results[2].valid, false);
  assert.ok(valRes.results[2].errors.some(e => e.message.includes('Несоответствие скобок')));
  assert.equal(valRes.results[3].valid, false);
  assert.ok(valRes.results[3].errors.some(e => e.message.includes('табы и пробелы')));
});

test('security: blocks traversal, hidden files, private keys, and Windows reserved names', async () => {
  const store = makeMemoryStore();
  const engine = createWorkspaceFiles({ store, cryptoImpl: webcrypto });
  const root = new MockDirHandle('sec');

  for (const badPath of ['../outside.txt', '.env', '.git/config', 'keys/id_rsa', 'api_key.json', 'CON.txt', 'node_modules/a.js']) {
    const res = await engine.batch('c:sec1', root, [{ op: 'read', path: badPath }]);
    assert.ok(res.results[0].error, `Expected error for ${badPath}`);
  }
});

test('v1.1.1 audit regressions: JS regex validation on entire extension/, protected dirs in rmdir/rename, rename_dir restore collision', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const store = makeMemoryStore();
  const engine = createWorkspaceFiles({ store, cryptoImpl: webcrypto });

  // 1. Validate EVERY real .js and .json file of extension/ — zero false positives allowed!
  const extDir = path.join(__dirname, '..', 'extension');
  function collectFiles(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...collectFiles(full));
      else if (/\.(js|json)$/i.test(ent.name)) out.push(full);
    }
    return out;
  }
  const realFiles = collectFiles(extDir);
  assert.ok(realFiles.length >= 8);
  for (const file of realFiles) {
    const rel = path.relative(extDir, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const res = engine.validateTextByExtension(rel, text);
    assert.equal(res.valid, true, `False positive in ${rel}: ${JSON.stringify(res.errors)}`);
  }

  // 2. JS regex literals containing quotes/brackets and escaped newlines must validate cleanly
  const trickyJs = [
    "const r1 = /['\"`({\\[]/g;",
    "const r2 = a / b / c;",
    "const s = 'line1 \\",
    "line2';",
    "function ok(x) { return /^\\/api\\/v2\\//.test(x) ? [1, 2] : {}; }",
  ].join('\n');
  const trickyRes = engine.validateTextByExtension('tricky.js', trickyJs);
  assert.equal(trickyRes.valid, true, `Unexpected error: ${JSON.stringify(trickyRes.errors)}`);

  // 3. rmdir and folder rename must refuse directories containing hidden/protected entries (.env, .git, node_modules)
  const root = new MockDirHandle('guard');
  const subWithEnv = new MockDirHandle('app');
  subWithEnv._entries.set('index.js', new MockFileHandle('index.js', 'console.log(1);\n'));
  subWithEnv._entries.set('.env', new MockFileHandle('.env', 'TOKEN=secret'));
  root._entries.set('app', subWithEnv);

  const rmdirBlocked = await engine.batch('c:aud1', root, [{ op: 'rmdir', path: 'app', recursive: true }]);
  assert.ok(rmdirBlocked.results[0].error, 'rmdir must block folder containing .env');
  assert.ok(root._entries.has('app'), 'folder must remain intact when rmdir is blocked');

  const renBlocked = await engine.batch('c:aud1', root, [{ op: 'rename', from: 'app', to: 'app2' }]);
  assert.ok(renBlocked.results[0].error, 'folder rename must block folder containing .env');
  assert.ok(root._entries.has('app') && !root._entries.has('app2'));

  // 4. rename_dir restore must refuse if original path was recreated in the meantime
  const cleanDir = new MockDirHandle('pkg');
  cleanDir._entries.set('a.js', new MockFileHandle('a.js', 'export const a = 1;\n'));
  root._entries.set('pkg', cleanDir);
  const renOk = await engine.batch('c:aud1', root, [{ op: 'rename', from: 'pkg', to: 'pkg_moved' }]);
  assert.equal(renOk.results[0].renamed, true);
  // Recreate a new folder at 'pkg'
  await engine.batch('c:aud1', root, [{ op: 'mkdir', path: 'pkg' }]);
  await assert.rejects(() => engine.restore('c:aud1', root, renOk.results[0].backupId), /уже занят/);
  // And pkg_moved must still exist!
  assert.equal((await engine.preview(root, 'pkg_moved/a.js')).text, 'export const a = 1;\n');
});

test('v1.2.0 final audit regressions: double-restore block, case-insensitive dir rename, CRLF edit, read leading blanks, validator edge cases, shared budget', async () => {
  const store = makeMemoryStore();
  const engine = createWorkspaceFiles({ store, cryptoImpl: webcrypto });
  const root = new MockDirHandle('v120');
  const chatKey = 'c:v120';

  // 1. Windows case-insensitive self-nesting rename (src -> SRC/sub) MUST be blocked
  const srcDir = new MockDirHandle('src');
  srcDir._entries.set('a.js', new MockFileHandle('a.js', 'const x = 1;\n'));
  root._entries.set('src', srcDir);
  const badCaseRename = await engine.batch(chatKey, root, [{ op: 'rename', from: 'src', to: 'SRC/sub' }]);
  assert.ok(badCaseRename.results[0].error);

  // 2. opMkdir on existing dir must NOT record backup; nested mkdir restore removes all newly created levels
  const mkdirExisted = await engine.batch(chatKey, root, [{ op: 'mkdir', path: 'src' }]);
  assert.equal(mkdirExisted.results[0].created, false);
  assert.equal(mkdirExisted.results[0].backupId, undefined);
  const mkdirNested = await engine.batch(chatKey, root, [{ op: 'mkdir', path: 'newA/newB/newC' }]);
  assert.equal(mkdirNested.results[0].created, true);
  await engine.restore(chatKey, root, mkdirNested.results[0].backupId);
  assert.equal(root._entries.has('newA'), false);

  // 3. Double restore must be rejected (prevents silent overwrite)
  await assert.rejects(() => engine.restore(chatKey, root, mkdirNested.results[0].backupId), /уже была откачена/);

  // 4. opRead preserves leading blank lines and handles invalid/null endLine
  root._entries.set('blanks.txt', new MockFileHandle('blanks.txt', '\n\nhello\nworld'));
  const readBlanks = await engine.batch(chatKey, root, [{ op: 'read', path: 'blanks.txt', startLine: 1, endLine: 3 }]);
  assert.equal(readBlanks.results[0].text, '\n\nhello');
  const readNullEnd = await engine.batch(chatKey, root, [{ op: 'read', path: 'blanks.txt', startLine: 1, endLine: null }]);
  assert.equal(readNullEnd.results[0].endLine, 4);

  // 5. opEdit supports CRLF files when model passes LF find/replace, preserving CRLF
  root._entries.set('win.txt', new MockFileHandle('win.txt', 'line1\r\nline2\r\nline3\r\n'));
  const rWin = (await engine.batch(chatKey, root, [{ op: 'read', path: 'win.txt' }])).results[0];
  const eWin = await engine.batch(chatKey, root, [{
    op: 'edit',
    path: 'win.txt',
    version: rWin.version,
    find: 'line1\nline2',
    replace: 'line1\nLINE2_MOD',
  }]);
  assert.equal(eWin.results[0].changed, true);
  assert.equal((await engine.preview(root, 'win.txt')).text, 'line1\r\nLINE2_MOD\r\nline3\r\n');

  // 6. Validator fixes: JSON with UTF-8 BOM, CSS url(https://...), JS return (a/b) + c/2, JS regex / '/g, nested template literals, Python docstring tabs
  assert.equal(engine.validateTextByExtension('bom.json', '\uFEFF{"ok":true}').valid, true);
  assert.equal(engine.validateTextByExtension('style.css', '.bg { background: url(https://example.com/a.png); }').valid, true);
  assert.equal(engine.validateTextByExtension('math.js', 'function f(a, b, c) { return (a/b) + c/2; }').valid, true);
  assert.equal(engine.validateTextByExtension('space-re.js', "const r = / '/g;").valid, true);
  assert.equal(engine.validateTextByExtension('tpl.js', "const s = `hello ${ok ? `it's` : \"no\"}`;").valid, true);
  assert.equal(engine.validateTextByExtension('tpl-bad.js', 'const s = `${foo(1, 2}`;').valid, false);
  assert.equal(engine.validateTextByExtension('doc.py', 'def f():\n    """\n\tindented in docstring\n    """\n    return 1\n').valid, true);

  // 7. Shared batch budget enforces 32KB total limit across sequential single-op calls
  const budget = engine.createBatchBudget();
  root._entries.set('big.txt', new MockFileHandle('big.txt', 'x'.repeat(11_000)));
  const reads = [];
  for (let i = 0; i < 8; i++) {
    const res = await engine.batch(chatKey, root, [{ op: 'read', path: 'big.txt' }], budget);
    reads.push(res.results[0]);
  }
  const totalSerialized = reads.reduce((s, r) => s + JSON.stringify(r).length, 0);
  assert.ok(reads[2].text.length < 11_000, '3rd read must shrink to fit shared budget');
  assert.ok(reads.some(r => r.error && r.error.includes('лимит размера пакета')), 'later reads must hit shared budget cap');
  assert.ok(totalSerialized <= 33_000, `total serialized batch ${totalSerialized} exceeded 32KB cap`);
});
