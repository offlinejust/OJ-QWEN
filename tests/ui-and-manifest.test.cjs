const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { createWorkspaceFiles } = require('../extension/lib/workspace-files.js');

const extDir = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));

test('manifest resources exist, launcher CSS is isolated from overlay :host fullscreen rules, and CSS validates cleanly', () => {
  const filesToCheck = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(cs => cs.js || []),
    ...manifest.web_accessible_resources.flatMap(w => w.resources || []),
  ];
  for (const rel of filesToCheck) {
    assert.ok(fs.existsSync(path.join(extDir, rel)), `Missing file declared in manifest: ${rel}`);
  }

  const bootstrapCode = fs.readFileSync(path.join(extDir, 'lib/bootstrap.js'), 'utf8');
  assert.ok(bootstrapCode.includes('lib/launcher.css'), 'bootstrap.js must load lib/launcher.css');
  assert.ok(!bootstrapCode.includes('lib/overlay.css'), 'bootstrap.js must NOT load fullscreen overlay.css into launcher ShadowRoot');

  const launcherCss = fs.readFileSync(path.join(extDir, 'lib/launcher.css'), 'utf8');
  assert.ok(!/width\s*:\s*100%/.test(launcherCss), 'launcher.css must never set width: 100% on launcher host');
  assert.ok(!/height\s*:\s*100%/.test(launcherCss), 'launcher.css must never set height: 100% on launcher host');
  assert.ok(/background\s*:\s*transparent/.test(launcherCss), 'launcher.css :host must have transparent background');

  const overlayCss = fs.readFileSync(path.join(extDir, 'lib/overlay.css'), 'utf8');
  assert.ok(/\.ctx-fill\s*\{[^}]*display\s*:\s*block/.test(overlayCss), '.ctx-fill must have display: block so progress bar is visible');

  const engine = createWorkspaceFiles({ cryptoImpl: webcrypto });
  assert.equal(engine.validateTextByExtension('lib/launcher.css', launcherCss).valid, true);
  assert.equal(engine.validateTextByExtension('lib/overlay.css', overlayCss).valid, true);
});

test('every $(\'id\') lookup in overlay-ui.js exists in app.innerHTML template', () => {
  const uiCode = fs.readFileSync(path.join(extDir, 'lib/overlay-ui.js'), 'utf8');
  const htmlMatch = /app\.innerHTML\s*=\s*`([\s\S]*?)`;/.exec(uiCode);
  assert.ok(htmlMatch, 'app.innerHTML template not found');
  const templateHtml = htmlMatch[1];

  const declaredIds = new Set();
  for (const m of templateHtml.matchAll(/\bid="([^"]+)"/g)) {
    declaredIds.add(m[1]);
  }
  const usedIds = new Set();
  for (const m of uiCode.matchAll(/\$\('([^']+)'\)/g)) {
    usedIds.add(m[1]);
  }
  assert.ok(usedIds.size >= 15);
  for (const id of usedIds) {
    assert.ok(declaredIds.has(id), `overlay-ui.js references $('${id}') which is missing in app.innerHTML`);
  }
});

test('all 8 content scripts bootstrap cleanly in exact manifest order and mount launcher without errors', () => {
  const noop = () => {};
  const appendedToDoc = [];
  const launcherLinks = [];

  function makeFakeEl(tag = 'div') {
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      classList: { add: noop, remove: noop, toggle: noop },
      setAttribute: noop,
      getAttribute: () => null,
      children: [],
      append(...nodes) { this.children.push(...nodes); },
      appendChild(n) { this.children.push(n); return n; },
      remove: noop,
      replaceChildren: noop,
      addEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      attachShadow() {
        const shadow = makeFakeEl('#shadow');
        shadow.getElementById = id => shadow.children.find(c => c.id === id) || makeFakeEl();
        shadow.append = (...nodes) => {
          shadow.children.push(...nodes);
          for (const n of nodes) {
            if (n.tagName === 'LINK') launcherLinks.push(n.href);
          }
        };
        return shadow;
      },
    };
    return el;
  }

  const docEl = makeFakeEl('html');
  docEl.appendChild = n => { appendedToDoc.push(n); return n; };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    crypto: webcrypto,
    fetch: async () => ({ ok: false, status: 500, text: async () => '' }),
    chrome: {
      runtime: {
        getURL: p => 'chrome-extension://testid/' + p,
        getManifest: () => manifest,
        sendMessage: async () => ({}),
      },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
      },
    },
    document: {
      documentElement: docEl,
      body: makeFakeEl('body'),
      createElement: tag => makeFakeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: { pathname: '/', href: 'https://chat.qwen.ai/', origin: 'https://chat.qwen.ai' },
    history: { state: null, pushState: noop, replaceState: noop },
    localStorage: { getItem: () => null, setItem: noop },
    performance: { getEntriesByType: () => [] },
    addEventListener: noop,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of manifest.content_scripts[0].js) {
    const code = fs.readFileSync(path.join(extDir, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }

  assert.equal(appendedToDoc.length, 1, 'launcherHost must be appended to documentElement');
  assert.equal(appendedToDoc[0].dataset.ojQwenLauncher, '1');
  assert.deepEqual(launcherLinks, ['chrome-extension://testid/lib/launcher.css']);

  const engine = vm.runInContext('OjAgentEngine.createEngine()', ctx);
  assert.equal(typeof engine.sendTask, 'function');
  assert.equal(typeof engine.restoreBackup, 'function');
  assert.equal(engine.getSettings().safetyMode, 'ask_all');
});

test('background.js handles oj:check-update (newer, same, 404) and cleans session key on tab close', async () => {
  const bgCode = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  let msgHandler = null;
  let tabRemovedHandler = null;
  const sessionStore = new Map();
  let mockFetchResponse = { ok: true, status: 200, async json() { return { tag_name: 'v9.9.9', html_url: 'https://github.com/offlinejust/OJ-QWEN/releases/tag/v9.9.9' }; } };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => mockFetchResponse,
    chrome: {
      runtime: {
        id: 'ext-1',
        getManifest: () => ({ version: '1.2.2' }),
        onMessage: { addListener: fn => { msgHandler = fn; } },
      },
      storage: {
        session: {
          async get(k) { return { [k]: sessionStore.get(k) }; },
          async set(obj) { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
          async remove(k) { sessionStore.delete(k); },
        },
      },
      tabs: {
        onRemoved: { addListener: fn => { tabRemovedHandler = fn; } },
      },
    },
  };
  vm.runInNewContext(bgCode, sandbox, { filename: 'background.js' });
  assert.ok(msgHandler && tabRemovedHandler);

  const sender = { id: 'ext-1', origin: 'https://chat.qwen.ai', frameId: 0, tab: { id: 42 } };
  const callMsg = msg => new Promise(resolve => {
    const asyncReply = msgHandler(msg, sender, resolve);
    assert.equal(asyncReply, true);
  });

  // 1. Update available
  const rNew = await callMsg({ type: 'oj:check-update' });
  assert.equal(rNew.data.hasUpdate, true);
  assert.equal(rNew.data.latestVersion, '9.9.9');

  // 2. Same version
  mockFetchResponse = { ok: true, status: 200, async json() { return { tag_name: 'v1.2.2' }; } };
  const rSame = await callMsg({ type: 'oj:check-update' });
  assert.equal(rSame.data.hasUpdate, false);

  // 3. No releases yet (404)
  mockFetchResponse = { ok: false, status: 404, async json() { return {}; } };
  const r404 = await callMsg({ type: 'oj:check-update' });
  assert.equal(r404.data.noReleases, true);
  assert.equal(r404.data.hasUpdate, false);

  // 4. Rate limit (403) falls back to /releases/latest redirect URL
  let callNum = 0;
  sandbox.fetch = async url => {
    callNum++;
    if (callNum === 1) return { ok: false, status: 403, async json() { return {}; } };
    assert.ok(url.includes('/releases/latest'));
    return { ok: true, status: 200, url: 'https://github.com/offlinejust/OJ-QWEN/releases/tag/v1.3.0' };
  };
  const rFallback = await callMsg({ type: 'oj:check-update' });
  assert.equal(rFallback.data.hasUpdate, true);
  assert.equal(rFallback.data.latestVersion, '1.3.0');

  // 5. Overlay state saved and cleaned up on tab close
  await callMsg({ type: 'oj:overlay-state', open: true });
  assert.equal(sessionStore.get('overlayOpen:42'), true);
  tabRemovedHandler(42);
  assert.equal(sessionStore.has('overlayOpen:42'), false);
});
