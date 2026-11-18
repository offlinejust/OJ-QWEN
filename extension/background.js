const QWEN_ORIGIN = 'https://chat.qwen.ai';
const REPO_SLUG = 'offlinejust/OJ-QWEN';
const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases/latest`;
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const UPDATE_CACHE_KEY = 'ojQwenUpdateCache:v1';
const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const BUG_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScl6vuzKwRWSqxB7Rm7KO9PMl488NVMfR_HJ9sp9FaGFDnxeA/formResponse';
const BUG_FORM_FIELDS = {
  title: 'entry.372530561',
  description: 'entry.217317406',
  diagnostics: 'entry.981817312',
};
let lastBugSubmitAt = 0;

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, { ...opts, signal: controller ? controller.signal : undefined });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа сервера.');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fallback when api.github.com hits 403 rate limit (common on shared VPN IPs):
// Follow redirect from /releases/latest -> /releases/tag/vX.Y.Z
async function checkViaRedirect(currentVersion) {
  const res = await fetchWithTimeout(RELEASES_PAGE_URL, { method: 'GET', redirect: 'follow' });
  const finalUrl = String(res.url || '');
  const tagMatch = /\/releases\/tag\/v?([^/?#]+)/i.exec(finalUrl);
  if (!tagMatch) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      noReleases: true,
      releaseUrl: RELEASES_PAGE_URL,
    };
  }
  const latestVersion = tagMatch[1].trim();
  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    noReleases: false,
    releaseUrl: finalUrl,
  };
}

async function readUpdateCache() {
  try {
    const res = await chrome.storage.local?.get(UPDATE_CACHE_KEY);
    return res?.[UPDATE_CACHE_KEY] || null;
  } catch {
    return null;
  }
}

async function writeUpdateCache(result) {
  try {
    await chrome.storage.local?.set({
      [UPDATE_CACHE_KEY]: {
        checkedAt: Date.now(),
        latestVersion: result.latestVersion,
        noReleases: Boolean(result.noReleases),
        releaseUrl: result.releaseUrl || RELEASES_PAGE_URL,
      },
    });
  } catch {}
}

async function checkLatestRelease({ force = false } = {}) {
  const currentVersion = chrome.runtime.getManifest().version;

  if (!force) {
    const cached = await readUpdateCache();
    if (cached && typeof cached.checkedAt === 'number' && Date.now() - cached.checkedAt < UPDATE_CACHE_TTL_MS) {
      const latestVersion = cached.latestVersion || null;
      return {
        currentVersion,
        latestVersion,
        hasUpdate: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0,
        noReleases: Boolean(cached.noReleases),
        releaseUrl: cached.releaseUrl || RELEASES_PAGE_URL,
        cached: true,
      };
    }
  }

  let result;
  const res = await fetchWithTimeout(RELEASES_API_URL, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) {
    result = {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      noReleases: true,
      releaseUrl: RELEASES_PAGE_URL,
    };
  } else if (res.status === 403 || res.status === 429) {
    result = await checkViaRedirect(currentVersion);
  } else if (!res.ok) {
    throw new Error(`GitHub API ответил HTTP ${res.status}`);
  } else {
    const json = await res.json();
    const latestVersion = String(json?.tag_name || json?.name || '').replace(/^v/i, '').trim();
    const hasUpdate = Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0;
    result = {
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      hasUpdate,
      noReleases: false,
      releaseUrl: typeof json?.html_url === 'string' && json.html_url.startsWith('https://github.com/')
        ? json.html_url
        : RELEASES_PAGE_URL,
    };
  }

  await writeUpdateCache(result);
  return result;
}

async function submitBugReport({ title, description, diagnostics }) {
  const now = Date.now();
  if (now - lastBugSubmitAt < 15_000) {
    throw new Error('Подождите 15 секунд перед повторной отправкой отчёта.');
  }
  const cleanTitle = String(title || '').trim().slice(0, 160);
  const cleanDesc = String(description || '').trim().slice(0, 8000);
  const cleanDiag = String(diagnostics || '').trim().slice(0, 16000);
  if (!cleanTitle || !cleanDesc) {
    throw new Error('Заполните описание ошибки перед отправкой.');
  }

  const params = new URLSearchParams();
  params.append(BUG_FORM_FIELDS.title, cleanTitle);
  params.append(BUG_FORM_FIELDS.description, cleanDesc);
  params.append(BUG_FORM_FIELDS.diagnostics, cleanDiag);

  const res = await fetchWithTimeout(
    BUG_FORM_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: params.toString(),
      redirect: 'follow',
    },
    15_000
  );

  if (!res.ok) {
    throw new Error(`Сервер формы ответил HTTP ${res.status}.`);
  }
  // If Google redirected to accounts.google.com, the form requires sign-in
  if (typeof res.url === 'string' && res.url.includes('accounts.google.com')) {
    throw new Error('Форма требует авторизации Google. Попробуйте скопировать отчёт вручную.');
  }

  lastBugSubmitAt = Date.now();
  return { submitted: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || sender.id !== chrome.runtime.id) return false;
  if (sender.origin !== QWEN_ORIGIN || sender.frameId !== 0) return false;

  if (message.type === 'oj:overlay-state' && sender.tab?.id !== undefined) {
    const key = 'overlayOpen:' + sender.tab.id;
    (async () => {
      if (typeof message.open === 'boolean') {
        if (message.open) await chrome.storage.session.set({ [key]: true });
        else await chrome.storage.session.remove(key);
        return { open: message.open };
      }
      const data = await chrome.storage.session.get(key);
      return { open: Boolean(data[key]) };
    })().then(data => respond({ data }), error => respond({ error: error.message }));
    return true;
  }

  if (message.type === 'oj:check-update') {
    checkLatestRelease({ force: Boolean(message.force) }).then(
      data => respond({ data }),
      error => respond({ error: error.message })
    );
    return true;
  }

  if (message.type === 'oj:submit-bug-report') {
    submitBugReport(message.payload || {}).then(
      data => respond({ data }),
      error => respond({ error: error.message })
    );
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove('overlayOpen:' + tabId).catch(() => {});
});
