var OjAgentEngine = (() => {
  const DEFAULT_PROJECT = 'OJ-QWEN';
  const DEFAULT_SETTINGS = {
    projectName: DEFAULT_PROJECT,
    sendOnEnter: true,
    safetyMode: 'ask_all', // 'ask_all' | 'ask_delete' | 'allow_all'
  };

  const STORAGE_SETTINGS_KEY = 'ojQwenSettings:v4';
  const STORAGE_HISTORY_KEY = 'ojQwenStepHistory:v1';
  const STORAGE_PLANS_KEY = 'ojQwenPlans:v2';
  const STORAGE_MEMORY_KEY = 'ojQwenMemory:v1';
  const STORAGE_BACKUPS_KEY = 'ojQwenBackups:v1';
  const STORAGE_META_KEY = 'ojQwenFsMeta:v1';
  const MAX_BACKUPS_PER_CHAT = 80;
  const MUTATING_OPS = new Set(['mkdir', 'create', 'edit', 'write', 'rename', 'delete', 'rmdir']);

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function makeContextWindow(usedTokens) {
    const limit = OjProtocol.CONTEXT_LIMIT_TOKENS;
    const used = Math.max(0, Math.round(Number(usedTokens) || 0));
    const remaining = Math.max(0, limit - used);
    const percent = Math.min(100, (used / limit) * 100);
    return { used, limit, remaining, percent };
  }

  function normalizePlansList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object' && raw.goal) return [raw];
    return [];
  }

  function createExtensionFsStore() {
    let metaCache = null;
    let backupsCache = null;
    let loadPromise = null;
    const MAX_META_CHATS = 15;
    const MAX_BACKUP_CHATS = 25;
    const MAX_STORE_JSON_BYTES = 7 * 1024 * 1024;

    async function ensureLoaded() {
      if (metaCache && backupsCache) return;
      if (!loadPromise) {
        loadPromise = chrome.storage.local
          .get([STORAGE_META_KEY, STORAGE_BACKUPS_KEY])
          .then(res => {
            metaCache = res?.[STORAGE_META_KEY] || {};
            backupsCache = res?.[STORAGE_BACKUPS_KEY] || {};
          })
          .catch(() => {
            metaCache = metaCache || {};
            backupsCache = backupsCache || {};
          })
          .finally(() => {
            loadPromise = null;
          });
      }
      await loadPromise;
    }

    function pruneMeta(activePrefix = '') {
      const chatOrder = new Map();
      for (const k of Object.keys(metaCache)) {
        const idx = k.indexOf(':');
        if (idx < 0) continue;
        const chatKey = k.slice(idx + 1);
        const val = metaCache[k];
        let ts = 0;
        if (k.startsWith('ver:') && val && typeof val === 'object') {
          const entries = Object.entries(val);
          if (entries.length > 20) {
            entries.sort((a, b) => (b[1]?.mtime || 0) - (a[1]?.mtime || 0));
            metaCache[k] = Object.fromEntries(entries.slice(0, 20));
          }
          ts = Math.max(0, ...Object.values(metaCache[k]).map(v => v?.mtime || 0));
        }
        chatOrder.set(chatKey, Math.max(chatOrder.get(chatKey) || 0, ts));
      }
      if (chatOrder.size > MAX_META_CHATS) {
        const drop = [...chatOrder.entries()]
          .filter(([ck]) => ck !== activePrefix)
          .sort((a, b) => a[1] - b[1])
          .slice(0, chatOrder.size - MAX_META_CHATS);
        for (const [ck] of drop) {
          delete metaCache['ver:' + ck];
          delete metaCache['snap:' + ck];
        }
      }
    }

    function pruneBackups(activeChatKey = '') {
      const chatKeys = Object.keys(backupsCache);
      if (chatKeys.length > MAX_BACKUP_CHATS) {
        const ordered = chatKeys
          .filter(k => k !== activeChatKey)
          .map(k => ({ k, ts: Math.max(0, ...(backupsCache[k] || []).map(b => b.createdAt || 0)) }))
          .sort((a, b) => a.ts - b.ts);
        for (const item of ordered.slice(0, chatKeys.length - MAX_BACKUP_CHATS)) {
          delete backupsCache[item.k];
        }
      }
      // Keep total serialized backup size bounded even without hitting browser quota
      let serializedLen = JSON.stringify(backupsCache).length;
      let guard = 0;
      while (serializedLen > MAX_STORE_JSON_BYTES && guard++ < 50) {
        const candidates = Object.entries(backupsCache)
          .filter(([, list]) => Array.isArray(list) && list.length > 0)
          .sort((a, b) => {
            if (a[0] === activeChatKey && b[0] !== activeChatKey) return 1;
            if (b[0] === activeChatKey && a[0] !== activeChatKey) return -1;
            return (a[1][0]?.createdAt || 0) - (b[1][0]?.createdAt || 0);
          });
        if (!candidates.length) break;
        const [victimKey, victimList] = candidates[0];
        victimList.shift();
        if (!victimList.length) delete backupsCache[victimKey];
        serializedLen = JSON.stringify(backupsCache).length;
      }
    }

    async function persistMeta(activeChatKey = '') {
      pruneMeta(activeChatKey);
      try {
        await chrome.storage.local.set({ [STORAGE_META_KEY]: metaCache });
      } catch {
        // Retry once after aggressive pruning
        const keepVer = activeChatKey ? metaCache['ver:' + activeChatKey] : null;
        const keepSnap = activeChatKey ? metaCache['snap:' + activeChatKey] : null;
        metaCache = {};
        if (keepVer) metaCache['ver:' + activeChatKey] = keepVer;
        if (keepSnap) metaCache['snap:' + activeChatKey] = keepSnap;
        await chrome.storage.local.set({ [STORAGE_META_KEY]: metaCache }).catch(() => {});
      }
    }

    async function persistBackups(activeChatKey = '') {
      pruneBackups(activeChatKey);
      try {
        await chrome.storage.local.set({ [STORAGE_BACKUPS_KEY]: backupsCache });
      } catch {
        // Retry once keeping only the most recent 20 backups of the active chat
        const keep = activeChatKey ? (backupsCache[activeChatKey] || []).slice(-20) : [];
        backupsCache = activeChatKey && keep.length ? { [activeChatKey]: keep } : {};
        await chrome.storage.local.set({ [STORAGE_BACKUPS_KEY]: backupsCache }).catch(() => {});
      }
    }

    return {
      async getMeta(key) {
        await ensureLoaded();
        return metaCache[key];
      },
      async setMeta(key, value) {
        await ensureLoaded();
        metaCache[key] = value;
        const idx = key.indexOf(':');
        await persistMeta(idx >= 0 ? key.slice(idx + 1) : '');
      },
      async removeMeta(key) {
        await ensureLoaded();
        delete metaCache[key];
        await persistMeta();
      },
      async addBackup(record) {
        await ensureLoaded();
        const list = backupsCache[record.chatKey] || [];
        list.push(record);
        if (list.length > MAX_BACKUPS_PER_CHAT) {
          list.splice(0, list.length - MAX_BACKUPS_PER_CHAT);
        }
        backupsCache[record.chatKey] = list;
        await persistBackups(record.chatKey);
        return record;
      },
      async getBackup(id) {
        await ensureLoaded();
        for (const list of Object.values(backupsCache)) {
          const found = list.find(b => b.id === id);
          if (found) return found;
        }
        return null;
      },
      async listBackups(chatKey) {
        await ensureLoaded();
        return [...(backupsCache[chatKey] || [])];
      },
      async markBackupRestored(id) {
        await ensureLoaded();
        for (const [chatKey, list] of Object.entries(backupsCache)) {
          const found = list.find(b => b.id === id);
          if (found) {
            found.restoredAt = Date.now();
            await persistBackups(chatKey);
            return found;
          }
        }
        return null;
      },
      async migrateChat(fromKey, toKey) {
        await ensureLoaded();
        if (metaCache['snap:' + fromKey]) {
          metaCache['snap:' + toKey] = metaCache['snap:' + fromKey];
          delete metaCache['snap:' + fromKey];
        }
        if (metaCache['ver:' + fromKey]) {
          metaCache['ver:' + toKey] = metaCache['ver:' + fromKey];
          delete metaCache['ver:' + fromKey];
        }
        if (backupsCache[fromKey]?.length) {
          const moved = backupsCache[fromKey].map(b => ({ ...b, chatKey: toKey }));
          backupsCache[toKey] = [...(backupsCache[toKey] || []), ...moved].slice(-MAX_BACKUPS_PER_CHAT);
          delete backupsCache[fromKey];
        }
        await Promise.all([persistMeta(toKey), persistBackups(toKey)]);
      },
    };
  }

  function createEngine() {
    const listeners = new Set();
    const fsStore = createExtensionFsStore();
    const filesEngine = createWorkspaceFiles({ store: fsStore });
    const workspaceHandles = new Map(); // chatKey -> { handle, revision, name }

    let settings = { ...DEFAULT_SETTINGS };
    let stepHistory = {};
    let plansByChat = {}; // chatKey -> Plan[]
    let memoryByChat = {};
    let liveTokenEstimate = 0;
    let chatOpSeq = 0;
    let projectOpSeq = 0;
    let wsRefreshSeq = 0;
    let catalogSyncedOk = false;

    const state = {
      projectName: DEFAULT_PROJECT,
      projectId: null,
      projects: [DEFAULT_PROJECT],
      projectMap: {},
      projectReady: false,
      connecting: false,
      syncingCatalog: false,
      loadingChat: false,
      connectionText: `Подключаюсь к проекту «${DEFAULT_PROJECT}»…`,
      connectionError: '',
      catalog: [],
      folderBadges: {},
      activeChatKey: null,
      activeChatTitle: '',
      isDraft: false,
      workspace: null,
      workspaceFilesList: [],
      backups: [],
      plans: [],
      activePlan: null,
      memory: {},
      contextWindow: makeContextWindow(0),
      protocolMsgCount: 0,
      transcript: [],
      running: false,
      stopped: false,
      liveStatus: '',
      liveTask: null,
      activeTaskTurn: null,
      liveSteps: [],
      pendingConfirmation: null, // { op, actionTitle, path, details, danger, resolve }
      pendingQuestion: null, // { question, options, resolve }
      updateInfo: null, // { currentVersion, latestVersion, hasUpdate, noReleases, releaseUrl }
      error: '',
    };

    let activeRun = null;

    function emit(event = 'state') {
      for (const fn of listeners) {
        try { fn(event, state); } catch {}
      }
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    async function loadPersisted() {
      try {
        const res = await chrome.storage.local.get([
          STORAGE_SETTINGS_KEY,
          STORAGE_HISTORY_KEY,
          STORAGE_PLANS_KEY,
          'ojQwenPlans:v1',
          STORAGE_MEMORY_KEY,
        ]);
        if (res[STORAGE_SETTINGS_KEY]) {
          settings = { ...DEFAULT_SETTINGS, ...res[STORAGE_SETTINGS_KEY] };
          state.projectName = settings.projectName || DEFAULT_PROJECT;
        }
        if (res[STORAGE_HISTORY_KEY]) stepHistory = res[STORAGE_HISTORY_KEY];
        const rawPlans = res[STORAGE_PLANS_KEY] || res['ojQwenPlans:v1'] || {};
        plansByChat = {};
        for (const [k, v] of Object.entries(rawPlans)) {
          plansByChat[k] = normalizePlansList(v);
        }
        if (res[STORAGE_MEMORY_KEY]) memoryByChat = res[STORAGE_MEMORY_KEY];
      } catch {}
    }

    async function saveSettings(patch) {
      settings = { ...settings, ...patch };
      state.projectName = settings.projectName || DEFAULT_PROJECT;
      await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: settings }).catch(() => {});
      emit('settings');
    }

    function persistPlans() {
      chrome.storage.local.set({ [STORAGE_PLANS_KEY]: plansByChat }).catch(() => {});
    }

    function persistMemory() {
      chrome.storage.local.set({ [STORAGE_MEMORY_KEY]: memoryByChat }).catch(() => {});
    }

    function saveStepHistory(taskTurn, chatKey, steps) {
      if (!taskTurn || !steps?.length) return;
      stepHistory[taskTurn] = { chatKey, steps, updatedAt: Date.now() };
      const keys = Object.keys(stepHistory);
      if (keys.length > 120) {
        keys
          .sort((a, b) => (stepHistory[a].updatedAt || 0) - (stepHistory[b].updatedAt || 0))
          .slice(0, keys.length - 120)
          .forEach(k => delete stepHistory[k]);
      }
      chrome.storage.local.set({ [STORAGE_HISTORY_KEY]: stepHistory }).catch(() => {});
    }

    function syncPlansState() {
      const list = (state.activeChatKey && normalizePlansList(plansByChat[state.activeChatKey])) || [];
      state.plans = list;
      state.activePlan = list.find(p => p.status === 'active') || null;
    }

    function syncChatMetadata() {
      const key = state.activeChatKey;
      syncPlansState();
      state.memory = (key && memoryByChat[key]) || {};
      // Never wipe live token count during an active draft chat!
      if (!state.running && !state.transcript.length && state.isDraft && liveTokenEstimate === 0) {
        state.contextWindow = makeContextWindow(0);
      }
    }

    function bumpLiveTokens(text) {
      if (!text) return;
      liveTokenEstimate += OjProtocol.estimateTokens(String(text));
      const domEst = OjQwenAdapter.estimateContextWindow().used;
      state.contextWindow = makeContextWindow(Math.max(state.contextWindow.used, liveTokenEstimate, domEst));
    }

    function refreshFolderBadges() {
      const badges = {};
      for (const [key, entry] of workspaceHandles.entries()) {
        badges[key] = { name: entry.name, revision: entry.revision };
      }
      state.folderBadges = badges;
    }

    async function fetchProjectsViaApiOrDom() {
      try {
        const list = await OjQwenApi.listProjects();
        if (list.length) {
          const map = {};
          const names = [];
          for (const p of list) {
            map[p.name] = p.id;
            names.push(p.name);
          }
          state.projectMap = map;
          const unique = new Set([DEFAULT_PROJECT, state.projectName, ...names].filter(Boolean));
          state.projects = [...unique];
          state.projectId = map[state.projectName] || null;
          return list;
        }
      } catch {}

      const detected = OjQwenAdapter.readProjectsList().map(p => p.name);
      const unique = new Set([DEFAULT_PROJECT, state.projectName, ...detected].filter(Boolean));
      state.projects = [...unique];
      const urlPid = OjQwenAdapter.extractProjectIdFromUrl();
      if (urlPid && !state.projectId && document.querySelector('.pcht__name')?.textContent?.trim() === state.projectName) {
        state.projectId = urlPid;
      }
      return [];
    }

    async function loadTranscriptFromApi(chatKey, { expectedSeq } = {}) {
      const chatId = OjQwenAdapter.extractChatIdFromKey(chatKey);
      if (!chatId) return false;
      try {
        const detail = await OjQwenApi.getChat(chatId);
        // Guard against stale async responses after user switched chats
        if (state.activeChatKey !== chatKey) return false;
        if (expectedSeq !== undefined && expectedSeq !== chatOpSeq) return false;
        if (detail && detail.rawMessages?.length) {
          const built = OjQwenApi.buildTranscriptFromDetail(detail, OjProtocol);
          if (built.transcript.length) state.transcript = built.transcript;
          liveTokenEstimate = Math.max(liveTokenEstimate, built.contextWindow.used);
          state.contextWindow = makeContextWindow(Math.max(built.contextWindow.used, liveTokenEstimate));
          state.protocolMsgCount = Math.max(state.protocolMsgCount, built.protocolMessages);
          if (detail.title && detail.title !== 'New chat') {
            state.activeChatTitle = detail.title;
          }
          return true;
        }
      } catch {}
      return false;
    }

    async function refreshWorkspaceInfo() {
      const seq = ++wsRefreshSeq;
      refreshFolderBadges();
      const key = state.activeChatKey;
      const entry = key ? workspaceHandles.get(key) : null;
      let nextWorkspace = null;
      let nextFiles = [];

      if (entry?.handle) {
        let granted = true;
        try {
          granted = (await entry.handle.queryPermission({ mode: 'readwrite' })) === 'granted';
        } catch {
          granted = false;
        }
        nextWorkspace = { name: entry.name, revision: entry.revision, granted };
        if (granted) {
          try {
            const tree = await filesEngine.listTree(entry.handle, '');
            nextFiles = tree.files || [];
          } catch {
            nextFiles = [];
          }
        }
      }

      const nextBackups = key ? await fsStore.listBackups(key) : [];
      // Abort if another refresh started or user switched to another chat while walking HDD
      if (seq !== wsRefreshSeq || state.activeChatKey !== key) return;

      state.workspace = nextWorkspace;
      state.workspaceFilesList = nextFiles;
      state.backups = nextBackups;
      syncChatMetadata();
      emit('workspace');
    }

    async function migrateChatKey(fromKey, toKey) {
      if (!fromKey || !toKey || fromKey === toKey) return;
      if (workspaceHandles.has(fromKey) && !workspaceHandles.has(toKey)) {
        workspaceHandles.set(toKey, workspaceHandles.get(fromKey));
      }
      workspaceHandles.delete(fromKey);

      const fromPlans = normalizePlansList(plansByChat[fromKey]);
      if (fromPlans.length) {
        const toPlans = normalizePlansList(plansByChat[toKey]);
        const seenIds = new Set(toPlans.map(p => p.id));
        plansByChat[toKey] = [...toPlans, ...fromPlans.filter(p => !seenIds.has(p.id))];
        delete plansByChat[fromKey];
        persistPlans();
      }

      if (memoryByChat[fromKey]) {
        memoryByChat[toKey] = { ...memoryByChat[fromKey], ...(memoryByChat[toKey] || {}) };
        delete memoryByChat[fromKey];
        persistMemory();
      }

      let historyTouched = false;
      for (const entry of Object.values(stepHistory)) {
        if (entry?.chatKey === fromKey) {
          entry.chatKey = toKey;
          historyTouched = true;
        }
      }
      if (historyTouched) {
        chrome.storage.local.set({ [STORAGE_HISTORY_KEY]: stepHistory }).catch(() => {});
      }

      await fsStore.migrateChat(fromKey, toKey);
    }

    // Reliably detect newly created chat's real UUID (via URL OR via Qwen project chats API!)
    async function detectAndBindNewChat(knownIds, sendStartedAt = 0) {
      if (!state.isDraft) return false;
      let realKey = OjQwenAdapter.extractChatKeyFromUrl();
      let discoveredChat = null;

      if (!realKey && state.projectId && catalogSyncedOk) {
        try {
          const recent = await OjQwenApi.listProjectChats(state.projectId, { maxPages: 1 });
          discoveredChat = recent.find(c => {
            if (knownIds.has(c.id)) return false;
            if (!sendStartedAt || !c.updatedAt) return true;
            const tsMs = c.updatedAt < 1e12 ? c.updatedAt * 1000 : c.updatedAt;
            return tsMs >= sendStartedAt - 120_000;
          }) || null;
          if (discoveredChat) realKey = discoveredChat.key;
        } catch {}
      }

      if (!realKey || realKey === state.activeChatKey) return false;

      const oldKey = state.activeChatKey;
      await migrateChatKey(oldKey, realKey);
      state.activeChatKey = realKey;
      state.isDraft = false;

      const realId = OjQwenAdapter.extractChatIdFromKey(realKey);
      const title = discoveredChat?.title || state.activeChatTitle || 'Новый чат';
      state.activeChatTitle = title;
      if (realId && !state.catalog.some(c => c.key === realKey)) {
        state.catalog = [
          { key: realKey, id: realId, title, url: `https://chat.qwen.ai/c/${realId}`, index: 0 },
          ...state.catalog,
        ];
        state.connectionText = `Проект «${state.projectName}» · чатов: ${state.catalog.length}`;
      }
      await refreshWorkspaceInfo();
      emit('catalog');
      return true;
    }

    async function pickWorkspaceFolder() {
      if (!state.activeChatKey) startNewChat();
      if (typeof window.showDirectoryPicker !== 'function') {
        state.error = 'Браузер не поддерживает File System Access API (showDirectoryPicker).';
        emit('error');
        return;
      }
      try {
        const currentEntry = workspaceHandles.get(state.activeChatKey);
        if (currentEntry?.handle) {
          const perm = await currentEntry.handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
          if (perm !== 'granted') {
            const req = await currentEntry.handle.requestPermission({ mode: 'readwrite' });
            if (req === 'granted') {
              state.error = '';
              await refreshWorkspaceInfo();
              return;
            }
          }
        }

        const handle = await window.showDirectoryPicker({
          id: 'ojqwen',
          mode: 'readwrite',
          startIn: 'documents',
        });
        workspaceHandles.set(state.activeChatKey, {
          handle,
          name: handle.name,
          revision: crypto.randomUUID(),
        });
        state.error = '';
        await refreshWorkspaceInfo();
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (err?.name === 'SecurityError' || /system/i.test(err?.message || '')) {
          state.error = 'Браузер Chromium запрещает выбирать корень диска (C:\\), сам Рабочий стол или сами Документы. Выберите конкретную подпапку проекта внутри них.';
        } else {
          state.error = err?.message || 'Не удалось выбрать папку.';
        }
        emit('error');
      }
    }

    async function disconnectWorkspaceFolder() {
      if (!state.activeChatKey) return;
      workspaceHandles.delete(state.activeChatKey);
      await refreshWorkspaceInfo();
    }

    async function connect() {
      if (state.connecting) return;
      state.connecting = true;
      state.connectionError = '';
      state.error = '';
      state.connectionText = 'Загружаю проекты Qwen…';
      emit('connect');
      // Quietly check GitHub releases in background (6h cache in background.js)
      void checkUpdates(false);

      try {
        if (OjQwenAdapter.isLoginVisible() && !OjQwenAdapter.getComposer()) {
          state.projectReady = false;
          state.connectionError = 'Войдите в аккаунт Qwen («Показать Qwen» → Войти).';
          state.connectionText = state.connectionError;
          return;
        }

        let projects = await fetchProjectsViaApiOrDom();

        const hasDefault = projects.some(p => p.name === DEFAULT_PROJECT) || Boolean(state.projectMap[DEFAULT_PROJECT]);
        if (!hasDefault) {
          state.connectionText = `Проект «${DEFAULT_PROJECT}» не найден — создаю…`;
          emit('status');
          await OjQwenAdapter.ensureProject(DEFAULT_PROJECT, {
            allowCreate: true,
            openIt: state.projectName === DEFAULT_PROJECT,
            onStatus: txt => {
              state.connectionText = txt;
              emit('status');
            },
          });
          projects = await fetchProjectsViaApiOrDom();
        }

        if (!state.projectMap[state.projectName]) {
          const res = await OjQwenAdapter.ensureProject(state.projectName, {
            allowCreate: state.projectName === DEFAULT_PROJECT,
            openIt: true,
            onStatus: txt => {
              state.connectionText = txt;
              emit('status');
            },
          });
          await fetchProjectsViaApiOrDom();
          if (!res.ready && !state.projectMap[state.projectName]) {
            state.projectReady = false;
            state.connectionError = res.error || `Проект «${state.projectName}» не найден.`;
            state.connectionText = state.connectionError;
            return;
          }
        }

        state.projectId = state.projectMap[state.projectName] || OjQwenAdapter.extractProjectIdFromUrl() || null;
        state.projectReady = true;
        state.connectionText = `Проект «${state.projectName}»`;

        await syncCatalog();

        const openKey = OjQwenAdapter.extractChatKeyFromUrl();
        const inCatalog = openKey && state.catalog.find(c => c.key === openKey);
        if (inCatalog) {
          state.activeChatKey = openKey;
          state.activeChatTitle = inCatalog.title;
          state.isDraft = false;
          liveTokenEstimate = 0;
          const loaded = await loadTranscriptFromApi(openKey);
          if (!loaded) {
            state.transcript = OjQwenAdapter.readTranscript();
            state.contextWindow = OjQwenAdapter.estimateContextWindow();
          }
        } else if (!state.activeChatKey || !state.catalog.some(c => c.key === state.activeChatKey)) {
          startNewChat();
        }
        await refreshWorkspaceInfo();
      } catch (err) {
        state.connectionError = err.message;
        state.connectionText = err.message;
      } finally {
        state.connecting = false;
        emit('connect');
      }
    }

    async function syncCatalog() {
      if (state.running) return;
      const myProjSeq = projectOpSeq;
      const targetProjectName = state.projectName;
      state.syncingCatalog = true;
      emit('status');
      try {
        await fetchProjectsViaApiOrDom();
        if (myProjSeq !== projectOpSeq || state.projectName !== targetProjectName) return;
        const pid = state.projectMap[state.projectName] || state.projectId;
        if (pid) {
          state.projectId = pid;
          state.liveStatus = 'Загружаю все чаты проекта…';
          emit('status');
          const apiChats = await OjQwenApi.listProjectChats(pid);
          if (myProjSeq !== projectOpSeq || state.projectName !== targetProjectName) return;
          state.catalog = apiChats.map((c, index) => ({
            key: c.key,
            id: c.id,
            title: c.title,
            url: c.url,
            index,
          }));
          catalogSyncedOk = true;
          state.connectionText = `Проект «${state.projectName}» · чатов: ${state.catalog.length}`;
        } else {
          if (!OjQwenAdapter.isProjectLanding(state.projectName)) {
            await OjQwenAdapter.navigateToProjectLanding(state.projectName);
          }
          if (myProjSeq !== projectOpSeq || state.projectName !== targetProjectName) return;
          const rows = await OjQwenAdapter.loadAllProjectChatRows(state.projectName);
          if (myProjSeq !== projectOpSeq || state.projectName !== targetProjectName) return;
          state.catalog = (rows || []).map(({ key, title, url, index }) => ({ key, title, url, index }));
          catalogSyncedOk = true;
          state.connectionText = `Проект «${state.projectName}» · чатов: ${state.catalog.length}`;
        }
        refreshFolderBadges();
      } catch (err) {
        if (myProjSeq === projectOpSeq) {
          catalogSyncedOk = false;
          state.error = 'Не удалось загрузить список чатов: ' + err.message;
        }
      } finally {
        if (myProjSeq === projectOpSeq) {
          state.syncingCatalog = false;
          state.liveStatus = '';
          emit('catalog');
        }
      }
    }

    async function selectProject(name) {
      const target = (name || '').trim();
      if (!target || state.running || state.connecting || target === state.projectName) return;
      const myProjSeq = ++projectOpSeq;
      chatOpSeq++;
      catalogSyncedOk = false;
      state.connecting = true;
      await saveSettings({ projectName: target });
      state.projectId = state.projectMap[target] || null;
      state.catalog = [];
      state.activeChatKey = null;
      state.transcript = [];
      state.protocolMsgCount = 0;
      liveTokenEstimate = 0;
      state.contextWindow = makeContextWindow(0);
      state.error = '';
      emit('connect');

      if (state.projectId) {
        try {
          state.projectReady = true;
          state.connectionText = `Проект «${target}»`;
          await syncCatalog();
          if (myProjSeq === projectOpSeq) {
            startNewChat();
          }
        } finally {
          if (myProjSeq === projectOpSeq) {
            state.connecting = false;
            emit('connect');
          }
        }
      } else {
        state.connecting = false;
        state.projectReady = false;
        await connect();
      }
    }

    function startNewChat() {
      if (state.running || state.loadingChat) return;
      chatOpSeq++;
      state.activeChatKey = 'draft:' + crypto.randomUUID();
      state.activeChatTitle = 'Новый чат';
      state.isDraft = true;
      state.transcript = [];
      state.protocolMsgCount = 0;
      liveTokenEstimate = 0;
      state.contextWindow = makeContextWindow(0);
      state.liveTask = null;
      state.liveSteps = [];
      state.error = '';
      void refreshWorkspaceInfo();
      emit('chat');
    }

    async function selectChat(chatKey) {
      if (state.running || state.connecting) return;
      const item = state.catalog.find(c => c.key === chatKey);
      if (!item) return;
      const mySeq = ++chatOpSeq;
      state.loadingChat = true;
      state.error = '';
      state.liveTask = null;
      state.liveSteps = [];
      state.transcript = [];
      state.protocolMsgCount = 0;
      liveTokenEstimate = 0;
      state.contextWindow = makeContextWindow(0);
      state.activeChatKey = item.key;
      state.activeChatTitle = item.title;
      state.isDraft = false;
      state.liveStatus = 'Загружаю переписку…';
      emit('chat');

      try {
        const loadedViaApi = await loadTranscriptFromApi(item.key, { expectedSeq: mySeq });
        if (mySeq !== chatOpSeq) return;
        if (!loadedViaApi) {
          const opened = await OjQwenAdapter.openChat(item, { projectName: state.projectName });
          if (mySeq !== chatOpSeq) return;
          if (opened.key !== item.key) {
            await migrateChatKey(item.key, opened.key);
            item.key = opened.key;
            item.url = opened.url;
            state.activeChatKey = opened.key;
          }
          state.transcript = OjQwenAdapter.readTranscript();
          state.contextWindow = OjQwenAdapter.estimateContextWindow();
          liveTokenEstimate = state.contextWindow.used;
          state.protocolMsgCount = OjQwenAdapter.countProtocolMessagesInChat();
        }
        await refreshWorkspaceInfo();
      } catch (err) {
        if (mySeq === chatOpSeq) state.error = err.message;
      } finally {
        if (mySeq === chatOpSeq) {
          state.loadingChat = false;
          state.liveStatus = '';
          emit('chat');
        }
      }
    }

    async function previewFile(filePath) {
      const entry = state.activeChatKey && workspaceHandles.get(state.activeChatKey);
      if (!entry?.handle) throw new Error('Рабочая папка не выбрана.');
      return filesEngine.preview(entry.handle, filePath);
    }

    async function restoreBackup(backupId) {
      if (state.running) throw new Error('Дождитесь завершения текущей задачи Qwen перед откатом.');
      const entry = state.activeChatKey && workspaceHandles.get(state.activeChatKey);
      if (!entry?.handle) throw new Error('Рабочая папка не выбрана.');
      const res = await filesEngine.restore(state.activeChatKey, entry.handle, backupId);
      await refreshWorkspaceInfo();
      return res;
    }

    function setError(message) {
      state.error = message || '';
      emit('error');
    }

    // ===== Cognitive tools: Planning (with history!) & Long-Term Memory =====
    function buildPlanDirective(plan) {
      if (!plan || plan.status !== 'active') return null;
      const step = plan.steps[plan.currentIndex];
      if (!step) return null;
      return {
        goal: plan.goal,
        progress: `Шаг ${plan.currentIndex + 1} из ${plan.steps.length}`,
        currentStep: {
          id: step.id,
          title: step.title,
          objective: step.objective,
          approach: step.approach,
          acceptance: step.acceptance,
        },
        roadmap: plan.steps.map((s, idx) => ({
          id: s.id,
          title: s.title,
          status: idx < plan.currentIndex ? 'done' : idx === plan.currentIndex ? 'active' : 'pending',
        })),
        instruction:
          'Выполни строго текущий шаг плана. Проверь ВСЕ условия приёмки (acceptance) по фактическому коду. ' +
          'Только когда каждый критерий подтверждён, вызови plan_accept с checks:[{criterion, passed:true, evidence}]. ' +
          'Если обнаружил ошибку в плане или блокер — вызови plan_abort.',
      };
    }

    function executeCognitiveOp(op) {
      const chatKey = state.activeChatKey;

      if (op.op === 'plan_create') {
        const goal = typeof op.goal === 'string' ? op.goal.trim() : '';
        if (!goal) return { result: { error: 'plan_create требует непустую строку goal.' } };
        if (!Array.isArray(op.steps) || op.steps.length < 1 || op.steps.length > 25) {
          return { result: { error: 'plan_create требует массив steps (от 1 до 25 шагов).' } };
        }
        const normalized = [];
        const seenStepIds = new Set();
        for (let i = 0; i < op.steps.length; i++) {
          const s = op.steps[i];
          if (!s || typeof s !== 'object') {
            return { result: { error: `Шаг #${i + 1} должен быть объектом.` } };
          }
          const rawId = s.id !== undefined && s.id !== null ? String(s.id).trim() : '';
          const id = rawId || String(i + 1);
          if (seenStepIds.has(id)) {
            return { result: { error: `Повторяющийся id шага "${id}" в plan_create.` } };
          }
          seenStepIds.add(id);
          const title = String(s.title || '').trim();
          const objective = String(s.objective || '').trim();
          const approach = String(s.approach || '').trim();
          const acceptance = Array.isArray(s.acceptance)
            ? s.acceptance.map(a => String(a || '').trim()).filter(Boolean)
            : [];
          if (!title || !objective || !acceptance.length) {
            return {
              result: {
                error: `Шаг "${title || id}" должен содержать title, objective и хотя бы одно условие приёмки в массиве acceptance.`,
              },
            };
          }
          normalized.push({ id, title, objective, approach, acceptance, status: 'pending', checks: null, notes: '' });
        }

        const list = normalizePlansList(plansByChat[chatKey]);
        // Mark any previous active plan as superseded/aborted so history stays clean
        for (const prev of list) {
          if (prev.status === 'active') {
            prev.status = 'aborted';
            prev.abortedAt = Date.now();
            prev.abortReason = 'Заменён новым планом';
          }
        }
        const plan = {
          id: crypto.randomUUID(),
          goal,
          status: 'active',
          currentIndex: 0,
          createdAt: Date.now(),
          steps: normalized,
        };
        list.push(plan);
        plansByChat[chatKey] = list.slice(-30);
        persistPlans();
        syncPlansState();
        emit('plan');
        return {
          result: { planCreated: true, totalSteps: normalized.length, activeStepId: normalized[0].id },
          planDirective: buildPlanDirective(plan),
        };
      }

      if (op.op === 'plan_update') {
        const list = normalizePlansList(plansByChat[chatKey]);
        const plan = list.find(p => p.status === 'active');
        if (!plan) {
          return { result: { error: 'Нет активного плана для обновления. Сначала создай план через plan_create.' } };
        }
        const reason = String(op.reason || '').trim();
        if (!reason) return { result: { error: 'plan_update требует непустую причину reason.' } };

        const normalizeStep = (s, fallbackId) => {
          if (!s || typeof s !== 'object') throw new Error('Шаг плана должен быть объектом.');
          const id = String(s.id ?? fallbackId).trim();
          const title = String(s.title || '').trim();
          const objective = String(s.objective || '').trim();
          const approach = String(s.approach || '').trim();
          const acceptance = Array.isArray(s.acceptance)
            ? s.acceptance.map(a => String(a || '').trim()).filter(Boolean)
            : [];
          if (!title || !objective || !acceptance.length) {
            throw new Error(`Шаг "${title || id}" должен содержать title, objective и непустой массив acceptance.`);
          }
          return { id, title, objective, approach, acceptance, status: 'pending', checks: null, notes: '' };
        };

        try {
          // Work on a deep clone so a validation error never leaves plan.steps partially mutated (atomic update)
          let nextSteps = plan.steps.map(s => ({
            ...s,
            acceptance: Array.isArray(s.acceptance) ? [...s.acceptance] : [],
          }));

          // 1. Remove future pending steps (never done or currently active step!)
          if (Array.isArray(op.removeStepIds) && op.removeStepIds.length) {
            const toRemove = new Set(op.removeStepIds.map(id => String(id).trim()));
            for (let idx = 0; idx <= plan.currentIndex && idx < nextSteps.length; idx++) {
              if (toRemove.has(nextSteps[idx].id)) {
                throw new Error(`Нельзя удалить уже выполненный или текущий активный шаг "${nextSteps[idx].id}".`);
              }
            }
            nextSteps = nextSteps.filter((s, idx) => idx <= plan.currentIndex || !toRemove.has(s.id));
          }

          // 2. Update current (not yet accepted) or future pending steps (never done steps!)
          if (Array.isArray(op.updateSteps) && op.updateSteps.length) {
            for (const patch of op.updateSteps) {
              const targetId = String(patch?.id || '').trim();
              const idx = nextSteps.findIndex(s => s.id === targetId);
              if (idx < 0) throw new Error(`Шаг "${targetId}" не найден в активном плане.`);
              if (idx < plan.currentIndex || nextSteps[idx].status === 'done') {
                throw new Error(`Нельзя изменять уже принятый шаг "${targetId}".`);
              }
              const cur = nextSteps[idx];
              const merged = normalizeStep({
                id: cur.id,
                title: patch.title ?? cur.title,
                objective: patch.objective ?? cur.objective,
                approach: patch.approach ?? cur.approach,
                acceptance: patch.acceptance ?? cur.acceptance,
              }, cur.id);
              nextSteps[idx] = merged;
            }
          }

          // 3. Append new steps
          if (Array.isArray(op.addSteps) && op.addSteps.length) {
            const existingIds = new Set(nextSteps.map(s => s.id));
            let nextNum = nextSteps.length + 1;
            for (const s of op.addSteps) {
              if (nextSteps.length >= 25) throw new Error('Максимум 25 шагов в одном плане.');
              while (existingIds.has(String(nextNum))) nextNum++;
              const rawId = s?.id !== undefined && s?.id !== null ? String(s.id).trim() : '';
              const ns = normalizeStep({ ...s, id: rawId || String(nextNum) }, String(nextNum));
              if (existingIds.has(ns.id)) throw new Error(`Шаг с id "${ns.id}" уже существует в плане.`);
              existingIds.add(ns.id);
              nextSteps.push(ns);
            }
          }

          plan.steps = nextSteps;
        } catch (err) {
          return { result: { error: err.message } };
        }

        plan.updatedAt = Date.now();
        persistPlans();
        syncPlansState();
        emit('plan');
        return {
          result: {
            updated: true,
            reason,
            totalSteps: plan.steps.length,
            activeStepId: plan.steps[plan.currentIndex]?.id || null,
          },
          planDirective: buildPlanDirective(plan),
        };
      }

      if (op.op === 'plan_accept') {
        const list = normalizePlansList(plansByChat[chatKey]);
        const plan = list.find(p => p.status === 'active');
        if (!plan) {
          return { result: { error: 'Нет активного плана. Сначала создай план через plan_create.' } };
        }
        const currentStep = plan.steps[plan.currentIndex];
        if (!currentStep) {
          return { result: { error: 'Все шаги плана уже завершены.' } };
        }
        if (op.stepId !== undefined && String(op.stepId).trim() !== currentStep.id) {
          return { result: { error: `Сейчас активен шаг "${currentStep.id}", а не "${op.stepId}".` } };
        }
        const checks = Array.isArray(op.checks) ? op.checks : [];
        if (checks.length < currentStep.acceptance.length) {
          return {
            result: {
              error: `Строгая приёмка отклонена: ожидалось минимум ${currentStep.acceptance.length} проверок (по числу критериев acceptance), получено ${checks.length}. Проверь каждый критерий и передай evidence.`,
            },
          };
        }
        const failed = checks.filter(c => !c || c.passed !== true || !String(c.evidence || '').trim());
        if (failed.length) {
          return {
            result: {
              error: 'Строгая приёмка отклонена: каждый пункт в checks должен иметь passed:true и непустое фактическое доказательство (evidence). Доработай шаг или вызови plan_abort.',
            },
          };
        }

        currentStep.status = 'done';
        currentStep.checks = checks.map(c => ({
          criterion: String(c.criterion || ''),
          passed: true,
          evidence: String(c.evidence || '').slice(0, 400),
        }));
        currentStep.notes = String(op.notes || '').slice(0, 600);
        plan.currentIndex += 1;

        if (plan.currentIndex >= plan.steps.length) {
          plan.status = 'completed';
          plan.completedAt = Date.now();
          persistPlans();
          syncPlansState();
          emit('plan');
          return {
            result: { accepted: true, stepId: currentStep.id, planCompleted: true },
            planDirective: {
              status: 'completed',
              instruction: 'Все шаги плана выполнены и прошли строгую приёмку! Теперь дай итоговый ответ пользователю через type="final".',
            },
          };
        }

        persistPlans();
        syncPlansState();
        emit('plan');
        return {
          result: { accepted: true, stepId: currentStep.id, nextStepId: plan.steps[plan.currentIndex].id },
          planDirective: buildPlanDirective(plan),
        };
      }

      if (op.op === 'plan_abort') {
        const list = normalizePlansList(plansByChat[chatKey]);
        const plan = list.find(p => p.status === 'active');
        if (!plan) {
          return { result: { error: 'Нет активного плана для прерывания.' } };
        }
        const reason = String(op.reason || '').trim();
        if (!reason) return { result: { error: 'Укажи причину прерывания плана в поле reason.' } };
        plan.status = 'aborted';
        plan.abortedAt = Date.now();
        plan.abortReason = reason;
        plan.abortCompletedWork = String(op.completedWork || '').slice(0, 1000);
        plan.abortSuggestion = String(op.suggestion || '').slice(0, 600);
        persistPlans();
        syncPlansState();
        emit('plan');
        return {
          result: { aborted: true, reason, completedWork: plan.abortCompletedWork || undefined },
          planDirective: {
            status: 'aborted',
            instruction: 'План досрочно остановлен. Ты можешь создать исправленный план через plan_create или объяснить ситуацию пользователю в type="final".',
          },
        };
      }

      const FORBIDDEN_MEM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

      if (op.op === 'memory_save') {
        const k = String(op.key || '').trim().slice(0, 80);
        const content = String(op.content ?? '').slice(0, 6000);
        if (!k || FORBIDDEN_MEM_KEYS.has(k)) {
          return { result: { error: 'memory_save требует корректный непустой key.' } };
        }
        const mem = memoryByChat[chatKey] || {};
        mem[k] = { content, updatedAt: Date.now() };
        const keys = Object.keys(mem);
        if (keys.length > 30) {
          keys.sort((a, b) => mem[a].updatedAt - mem[b].updatedAt).slice(0, keys.length - 30).forEach(old => delete mem[old]);
        }
        memoryByChat[chatKey] = mem;
        persistMemory();
        state.memory = mem;
        emit('plan');
        return { result: { saved: true, key: k, totalNotes: Object.keys(mem).length } };
      }

      if (op.op === 'memory_read') {
        const mem = memoryByChat[chatKey] || {};
        if (op.key !== undefined && op.key !== null && String(op.key).trim()) {
          const k = String(op.key).trim();
          if (!Object.prototype.hasOwnProperty.call(mem, k)) {
            return { result: { error: `Заметка "${k}" не найдена.`, availableKeys: Object.keys(mem) } };
          }
          return { result: { key: k, content: mem[k].content } };
        }
        const summary = {};
        for (const [k, v] of Object.entries(mem)) summary[k] = v.content;
        return { result: { notes: summary } };
      }

      if (op.op === 'memory_delete') {
        const k = String(op.key || '').trim();
        if (!k || FORBIDDEN_MEM_KEYS.has(k)) return { result: { error: 'memory_delete требует корректный непустой key.' } };
        const mem = memoryByChat[chatKey] || {};
        if (!Object.prototype.hasOwnProperty.call(mem, k)) {
          return { result: { error: `Заметка "${k}" не найдена.`, availableKeys: Object.keys(mem) } };
        }
        delete mem[k];
        memoryByChat[chatKey] = mem;
        persistMemory();
        state.memory = mem;
        emit('plan');
        return { result: { deleted: true, key: k, remainingNotes: Object.keys(mem).length } };
      }

      return null;
    }

    function describeOp(op) {
      switch (op?.op) {
        case 'list': return op.dir ? `Список файлов: ${op.dir}` : 'Список файлов проекта';
        case 'search': return `Поиск «${String(op.query || '').slice(0, 60)}»`;
        case 'read': return op.startLine ? `Читаю ${op.path} (${op.startLine}–${op.endLine || '…'})` : `Читаю ${op.path}`;
        case 'validate': return `Проверяю синтаксис ${op.path}`;
        case 'mkdir': return `Создаю папку ${op.path}`;
        case 'create': return `Создаю ${op.path}`;
        case 'edit': return Array.isArray(op.edits) ? `Мульти-правка ${op.path} (${op.edits.length})` : `Правка ${op.path}`;
        case 'write': return `Перезаписываю ${op.path}`;
        case 'diff': return `Сравнение ${op.path}`;
        case 'rename': return `Переименование ${op.from} → ${op.to}`;
        case 'delete': return `Удаление файла ${op.path}`;
        case 'rmdir': return op.recursive ? `Удаление папки (рекурсивно) ${op.path}` : `Удаление папки ${op.path}`;
        case 'plan_create': return `Создаю план: ${String(op.goal || '').slice(0, 60)}`;
        case 'plan_update': return `Обновляю план: ${String(op.reason || '').slice(0, 60)}`;
        case 'plan_accept': return `Приёмка шага плана #${op.stepId ?? '?'}`;
        case 'plan_abort': return 'Досрочный выход из плана';
        case 'memory_save': return `Запоминаю: ${op.key || ''}`;
        case 'memory_read': return op.key ? `Читаю память: ${op.key}` : 'Читаю все заметки памяти';
        case 'memory_delete': return `Удаляю заметку: ${op.key || ''}`;
        case 'ask_user': return `Вопрос пользователю: ${String(op.question || '').slice(0, 60)}`;
        default: return 'Операция';
      }
    }

    function summarizeOpResult(op, res) {
      if (res?.error) return { ok: false, text: res.error };
      switch (op?.op) {
        case 'list': {
          const bin = res.binaryFiles?.length ? `, бинарных: ${res.binaryFiles.length}` : '';
          return { ok: true, text: `Файлов: ${res.files?.length || 0} из ${res.total ?? res.files?.length ?? 0}${bin}` };
        }
        case 'search': return { ok: true, text: `Совпадений: ${res.matches?.length || 0}${res.truncated ? '+' : ''}` };
        case 'read': return {
          ok: true,
          text: res.startLine
            ? `Строки ${res.startLine}–${res.endLine} из ${res.totalLines}`
            : `Прочитано (${res.totalLines || '?'} строк)`,
        };
        case 'validate': return res.valid
          ? { ok: true, text: `Синтаксис OK (${res.kind})` }
          : { ok: false, text: `Найдено ошибок: ${res.errors?.length || 1} (стр. ${res.errors?.[0]?.line || 1})` };
        case 'mkdir': return { ok: true, text: 'Папка создана', backupId: res.backupId };
        case 'create': return { ok: true, text: 'Файл создан', backupId: res.backupId };
        case 'edit':
        case 'write': return {
          ok: true,
          text: res.changed ? `+${res.addedLines || 0} / -${res.removedLines || 0}` : 'Без изменений',
          backupId: res.backupId,
          diff: res.diff,
        };
        case 'diff': return {
          ok: true,
          text: `+${res.added?.length || 0} / -${res.removed?.length || 0}`,
          diff: {
            startLine: res.startLine,
            removed: (res.removed || []).slice(0, 40),
            added: (res.added || []).slice(0, 40),
          },
        };
        case 'rename': return {
          ok: true,
          text: res.kind === 'directory' ? `Папка перенесена (${res.movedFiles} ф.) → ${res.to}` : `Переименовано → ${res.to}`,
          backupId: res.backupId,
        };
        case 'delete': return { ok: true, text: 'Файл удалён (бэкап сохранён)', backupId: res.backupId };
        case 'rmdir': return {
          ok: true,
          text: res.removedFiles ? `Папка удалена (файлов: ${res.removedFiles}, в бэкапе: ${res.backedUpFiles})` : 'Пустая папка удалена',
          backupId: res.backupId,
        };
        case 'plan_create': return { ok: true, text: `План из ${res.totalSteps} шагов` };
        case 'plan_update': return { ok: true, text: `План обновлён (шагов: ${res.totalSteps})` };
        case 'plan_accept': return { ok: true, text: res.planCompleted ? 'План завершён!' : `Принят → далее шаг #${res.nextStepId}` };
        case 'plan_abort': return { ok: true, text: 'План остановлен: ' + (res.reason || '').slice(0, 80) };
        case 'memory_save': return { ok: true, text: `Сохранено (всего: ${res.totalNotes})` };
        case 'memory_read': return { ok: true, text: res.key ? 'Прочитано' : `Заметок: ${Object.keys(res.notes || {}).length}` };
        case 'memory_delete': return { ok: true, text: `Удалено (осталось: ${res.remainingNotes})` };
        case 'ask_user': return { ok: true, text: 'Ответ получен: ' + String(res.answer || '').slice(0, 70) };
        default: return { ok: true, text: 'Готово' };
      }
    }

    function needsUserApproval(opName) {
      if (!MUTATING_OPS.has(opName)) return false;
      const mode = settings.safetyMode || 'ask_all';
      if (mode === 'allow_all') return false;
      if (mode === 'ask_delete') return opName === 'delete' || opName === 'rmdir';
      return true; // 'ask_all'
    }

    async function requestOpConfirmation(op, rootHandle, run) {
      const targetPath = op.op === 'rename' ? `${op.from} → ${op.to}` : String(op.path || '');
      const titles = {
        mkdir: 'Создать папку',
        create: 'Создать файл',
        edit: 'Изменить файл',
        write: 'Перезаписать файл',
        rename: 'Переименовать',
        delete: 'Удалить файл',
        rmdir: op.recursive ? 'Удалить папку со всем содержимым' : 'Удалить папку',
      };
      let details = '';
      if (op.op === 'rmdir' && rootHandle) {
        try {
          const info = await filesEngine.inspectDir(rootHandle, op.path);
          if (info.hasProtected) details = 'содержит защищённые/скрытые файлы (удаление будет заблокировано)';
          else if (info.empty) details = 'папка пуста';
          else {
            details = `файлов: ${info.fileCount}, подпапок: ${info.dirCount}` +
              (info.binaryCount ? `, бинарных (без бэкапа): ${info.binaryCount}` : ', текстовые файлы сохранятся в бэкап');
          }
        } catch {}
      }
      if (run?.stopped) return false;
      return new Promise(resolve => {
        state.pendingConfirmation = {
          op: op.op,
          actionTitle: titles[op.op] || 'Выполнить операцию',
          path: targetPath,
          details,
          danger: op.op === 'delete' || op.op === 'rmdir',
          resolve,
        };
        state.liveStatus = `Ожидаю подтверждение: ${titles[op.op] || op.op} ${targetPath}`;
        emit('confirmation');
      });
    }

    function resolveConfirmation(approved) {
      const pending = state.pendingConfirmation;
      if (!pending) return;
      state.pendingConfirmation = null;
      emit('confirmation');
      pending.resolve(Boolean(approved));
    }

    function requestUserQuestion(question, options) {
      return new Promise(resolve => {
        state.pendingQuestion = {
          question: String(question || '').trim(),
          options: Array.isArray(options) ? options.map(o => String(o || '').trim()).filter(Boolean).slice(0, 8) : [],
          resolve,
        };
        state.liveStatus = 'Qwen задал вопрос и ждёт вашего ответа…';
        emit('question');
      });
    }

    function resolveQuestion(answerText) {
      const pending = state.pendingQuestion;
      if (!pending) return;
      state.pendingQuestion = null;
      emit('question');
      pending.resolve(String(answerText ?? '').trim());
    }

    async function waitForReply({ turn, expectProtocol, previousAnswers, beforeLastMsgId = '', knownIds, sendStartedAt = 0, run }) {
      let deadline = Date.now() + 240_000;
      let sawComparison = false;
      let comparisonReadySince = 0;
      let selected = false;
      let selectedKey = '';
      let sawGeneration = false;
      let stillSince = 0;
      let lastKey = '';
      let lastKeySince = 0;
      let lastPlain = '';
      let plainSince = 0;
      let lastBindCheck = 0;
      let lastApiCheck = 0;

      while (Date.now() < deadline) {
        if (run.stopped) throw new Error('Остановлено пользователем.');

        // Bind newly created draft chat to its real Qwen UUID as soon as it appears!
        if (state.isDraft && Date.now() - lastBindCheck >= 1800) {
          lastBindCheck = Date.now();
          await detectAndBindNewChat(knownIds, sendStartedAt);
        }

        const { generating, thinking, preferButtons, readyPreferButtons = [] } = OjQwenAdapter.getGenerationStatus();
        if (generating) {
          sawGeneration = true;
          stillSince = 0;
        } else if (!stillSince) {
          stillSince = Date.now();
        }

        const scan = expectProtocol
          ? OjQwenAdapter.scanProtocolReplies(turn)
          : { matches: [], foundEnvelope: false, otherTurn: false, lastParseError: '' };

        if (preferButtons.length) {
          if (!sawComparison) {
            sawComparison = true;
            deadline = Math.max(deadline, Date.now() + 180_000);
          }
          if (!selected && !generating && readyPreferButtons.length > 0) {
            if (!comparisonReadySince) comparisonReadySince = Date.now();
            if (expectProtocol) {
              const choice = OjQwenAdapter.selectPreferredCard(readyPreferButtons, scan.matches);
              if (choice) {
                selected = true;
                selectedKey = choice.key;
                choice.button.click();
              } else if (Date.now() - comparisonReadySince >= 2500) {
                // Neither card contained a valid protocol reply yet — pick first ready card to unblock Qwen
                selected = true;
                readyPreferButtons[0].click();
              }
            } else if (Date.now() - comparisonReadySince >= 800) {
              // Plain chat A/B comparison — auto-select first ready answer so overlay never deadlocks
              selected = true;
              readyPreferButtons[0].click();
            }
          }
          state.liveStatus = selected
            ? 'Выбрал ответ из A/B-сравнения…'
            : 'Qwen предлагает 2 варианта. Жду готовности…';
          emit('status');
          await wait(450);
          continue;
        }

        if (generating) {
          lastKey = '';
          lastPlain = '';
          state.liveStatus = thinking ? 'Qwen размышляет…' : 'Qwen пишет ответ…';
          emit('status');
          await wait(450);
          continue;
        }

        if (expectProtocol) {
          const candidates = OjQwenAdapter.uniqueCandidates(scan.matches);
          if (selectedKey && candidates.has(selectedKey)) {
            for (const k of [...candidates.keys()]) {
              if (k !== selectedKey) candidates.delete(k);
            }
          }
          const singleKey = candidates.size === 1 ? candidates.keys().next().value : '';
          if (singleKey) {
            if (singleKey !== lastKey) {
              lastKey = singleKey;
              lastKeySince = Date.now();
            }
            if (Date.now() - lastKeySince >= 900) {
              const reply = candidates.get(singleKey);
              bumpLiveTokens(JSON.stringify(reply));
              return { kind: 'protocol', reply };
            }
            state.liveStatus = 'Пакет получен, проверяю завершение…';
            emit('status');
            await wait(350);
            continue;
          }

          if (scan.foundEnvelope && !scan.otherTurn && scan.lastParseError && Date.now() - stillSince >= 2500) {
            return { kind: 'parse-error', reason: scan.lastParseError };
          }
        }

        const answers = OjQwenAdapter.readAssistantAnswers();
        const latestPlain = answers.filter(t => !previousAnswers.has(t)).at(-1) || '';
        if (latestPlain !== lastPlain) {
          lastPlain = latestPlain;
          plainSince = Date.now();
        }

        const settleDelay = expectProtocol ? (sawGeneration ? 2500 : 6000) : (sawGeneration ? 1200 : 3000);
        // Throttled API fallback check (at most once every 2.5s)
        if (
          Date.now() - stillSince >= (expectProtocol ? 2200 : 1200) &&
          Date.now() - lastApiCheck >= 2500
        ) {
          const activeId = OjQwenAdapter.extractChatIdFromKey(state.activeChatKey || OjQwenAdapter.extractChatKeyFromUrl());
          if (activeId && (sawGeneration || Date.now() - stillSince >= 3500)) {
            lastApiCheck = Date.now();
            try {
              const detail = await OjQwenApi.getChat(activeId);
              if (run.stopped) throw new Error('Остановлено пользователем.');
              const lastMsg = detail?.rawMessages?.at(-1);
              const isNewMsg = !beforeLastMsgId || !lastMsg?.id || lastMsg.id !== beforeLastMsgId;
              if (lastMsg?.role === 'qwen' && lastMsg.done && lastMsg.answer && isNewMsg) {
                if (expectProtocol) {
                  const res = OjProtocol.parseDetailed(lastMsg.answer, turn);
                  if (res.ok) {
                    bumpLiveTokens(lastMsg.raw || lastMsg.answer);
                    return { kind: 'protocol', reply: res.reply };
                  }
                  if (res.foundEnvelope) {
                    // NEVER fall through and return a protocol envelope as plain text!
                    if (res.reason === 'other-turn') {
                      if (beforeLastMsgId && lastMsg.id && lastMsg.id !== beforeLastMsgId && Date.now() - stillSince >= 3500) {
                        return { kind: 'parse-error', reason: 'В пакете указан неверный turn. Используй точный turn из последнего пакета.' };
                      }
                    } else if (res.reason) {
                      return { kind: 'parse-error', reason: res.reason };
                    }
                    // Keep waiting if it's still an older turn's envelope
                    await wait(450);
                    continue;
                  }
                }
                if (!previousAnswers.has(lastMsg.answer)) {
                  bumpLiveTokens(lastMsg.raw || lastMsg.answer);
                  return { kind: 'plain', summary: lastMsg.answer.slice(0, 32_000) };
                }
              }
            } catch (err) {
              if (run.stopped) throw err;
            }
          }
        }

        const plainLooksLikeProtocol = expectProtocol && latestPlain.includes('OJ_FILES_REPLY') && latestPlain.includes('OJ_FILES_END');
        if (latestPlain && !plainLooksLikeProtocol && Date.now() - stillSince >= (expectProtocol ? 3000 : 1200) && Date.now() - plainSince >= settleDelay) {
          bumpLiveTokens(latestPlain);
          return { kind: 'plain', summary: latestPlain.slice(0, 32_000) };
        }

        state.liveStatus = latestPlain ? 'Проверяю завершение ответа…' : 'Ожидаю ответ Qwen…';
        emit('status');
        await wait(450);
      }

      throw new Error('Истекло время ожидания ответа Qwen (4 мин). Проверьте вкладку через «Показать Qwen».');
    }

    async function executeBatch(ops, run, expectedRevision) {
      const stepRecords = ops.map(op => ({
        op: op.op,
        path: op.path || op.to || op.from || op.dir || '',
        label: describeOp(op),
        status: 'running',
        resultText: 'Выполняется…',
        diff: null,
        backupId: null,
      }));
      state.liveSteps.push(...stepRecords);
      emit('steps');

      const results = [];
      let latestPlanDirective = null;
      const batchBudget = filesEngine.createBatchBudget();

      for (let i = 0; i < ops.length; i++) {
        if (run.stopped) throw new Error('Остановлено пользователем.');
        const op = ops[i];

        if (op.op === 'ask_user') {
          const q = String(op.question || '').trim();
          if (!q) {
            const errRes = { error: 'ask_user требует непустой текст вопроса question.' };
            stepRecords[i].status = 'error';
            stepRecords[i].resultText = errRes.error;
            results.push(errRes);
            emit('steps');
            continue;
          }
          stepRecords[i].status = 'pending';
          stepRecords[i].resultText = 'Ожидает ответа пользователя…';
          emit('steps');
          const answer = await requestUserQuestion(q, op.options);
          if (run.stopped) throw new Error('Остановлено пользователем.');
          const resObj = answer ? { answer } : { answer: '(Пользователь пропустил вопрос без ответа)' };
          const sum = summarizeOpResult(op, resObj);
          stepRecords[i].status = 'done';
          stepRecords[i].resultText = sum.text;
          results.push(resObj);
          emit('steps');
          continue;
        }

        const cog = executeCognitiveOp(op);
        if (cog) {
          const sum = summarizeOpResult(op, cog.result);
          stepRecords[i].status = sum.ok ? 'done' : 'error';
          stepRecords[i].resultText = sum.text;
          results.push(cog.result);
          if (cog.planDirective) latestPlanDirective = cog.planDirective;
          emit('steps');
          continue;
        }

        const entry = workspaceHandles.get(state.activeChatKey);
        if (!entry?.handle) {
          const errRes = { error: 'Рабочая папка не выбрана для этого чата.' };
          stepRecords[i].status = 'error';
          stepRecords[i].resultText = errRes.error;
          results.push(errRes);
          emit('steps');
          continue;
        }
        if (expectedRevision && entry.revision !== expectedRevision) {
          throw new Error('Рабочая папка была изменена во время выполнения. Отправьте поручение заново.');
        }

        if (needsUserApproval(op.op)) {
          stepRecords[i].status = 'pending';
          stepRecords[i].resultText = 'Ожидает подтверждения…';
          emit('steps');
          const approved = await requestOpConfirmation(op, entry.handle, run);
          if (run.stopped) throw new Error('Остановлено пользователем.');
          if (!approved) {
            const declined = { error: `Пользователь отклонил операцию ${op.op}.` };
            stepRecords[i].status = 'error';
            stepRecords[i].resultText = 'Отклонено пользователем';
            results.push(declined);
            emit('steps');
            continue;
          }
          stepRecords[i].status = 'running';
          stepRecords[i].resultText = 'Выполняется…';
          emit('steps');
        }

        const singleRes = await filesEngine.batch(state.activeChatKey, entry.handle, [op], batchBudget);
        const r = singleRes.results[0];
        const sum = summarizeOpResult(op, r);
        stepRecords[i].status = sum.ok ? 'done' : 'error';
        stepRecords[i].resultText = sum.text;
        stepRecords[i].diff = sum.diff || null;
        stepRecords[i].backupId = sum.backupId || null;
        results.push(r);
        if (sum.backupId) {
          state.backups = await fsStore.listBackups(state.activeChatKey);
        }
        emit('steps');
      }

      return { results, planDirective: latestPlanDirective };
    }

    async function fetchLastApiMessageId(chatKey) {
      const chatId = OjQwenAdapter.extractChatIdFromKey(chatKey);
      if (!chatId) return '';
      try {
        const detail = await OjQwenApi.getChat(chatId);
        return detail?.rawMessages?.at(-1)?.id || '';
      } catch {
        return '';
      }
    }

    async function sendTask(taskText) {
      const cleanTask = String(taskText || '').trim();
      if (!cleanTask || state.running || state.loadingChat || state.connecting) return;
      if (!state.activeChatKey) startNewChat();

      const knownIds = new Set(state.catalog.map(c => c.id).filter(Boolean));
      const sendStartedAt = Date.now();
      let finalAssistantText = '';
      let taskTurn = null;

      state.running = true;
      state.stopped = false;
      state.error = '';
      state.liveTask = cleanTask;
      state.activeTaskTurn = null;
      state.liveSteps = [];
      const run = { stopped: false };
      activeRun = run;
      emit('run');

      try {
        if (state.isDraft) {
          state.liveStatus = 'Открываю экран проекта для нового чата…';
          emit('status');
          const targetPath = state.projectId ? `/p/${state.projectId}` : null;
          let ok = targetPath
            ? await OjQwenAdapter.spaNavigate(targetPath, { projectName: state.projectName })
            : await OjQwenAdapter.navigateToProjectLanding(state.projectName);
          if (!ok) ok = await OjQwenAdapter.navigateToProjectLanding(state.projectName);
          // Never send a new draft task while Qwen is still sitting on an existing /c/... chat!
          if ((!ok && !OjQwenAdapter.getComposer()) || location.pathname.startsWith('/c/')) {
            throw new Error(`Не удалось открыть стартовую страницу проекта «${state.projectName}» для нового чата (чтобы не писать в чужой диалог). Откройте проект через «Показать Qwen ↗» и повторите.`);
          }
        } else {
          const targetChatId = OjQwenAdapter.extractChatIdFromKey(state.activeChatKey);
          if (targetChatId && location.pathname !== `/c/${targetChatId}`) {
            state.liveStatus = 'Открываю диалог в Qwen…';
            emit('status');
            const navOk = await OjQwenAdapter.spaNavigate(`/c/${targetChatId}`, { chatTitle: state.activeChatTitle });
            if (!navOk && location.pathname !== `/c/${targetChatId}`) {
              throw new Error('Не удалось переключить Qwen на выбранный чат. Откройте нужный чат через «Показать Qwen ↗» и повторите.');
            }
          }
        }

        await refreshWorkspaceInfo();
        const entry = workspaceHandles.get(state.activeChatKey);
        const hasActiveWorkspace = Boolean(entry?.handle && state.workspace?.granted);
        const expectedRevision = entry?.revision || null;

        if (!hasActiveWorkspace) {
          state.liveStatus = 'Отправляю сообщение в Qwen…';
          emit('status');
          const prevAnswers = new Set(OjQwenAdapter.readAssistantAnswers());
          for (const m of state.transcript) {
            if (m.role === 'qwen' && m.text) prevAnswers.add(m.text);
          }
          const beforeLastMsgId = state.isDraft ? '' : await fetchLastApiMessageId(state.activeChatKey);
          await OjQwenAdapter.sendMessage(cleanTask, { isCancelled: () => run.stopped });
          bumpLiveTokens(cleanTask);
          emit('status');
          const res = await waitForReply({
            turn: null,
            expectProtocol: false,
            previousAnswers: prevAnswers,
            beforeLastMsgId,
            knownIds,
            sendStartedAt,
            run,
          });
          finalAssistantText = res.summary || '';
          return;
        }

        const snapshot = await filesEngine.snapshot(state.activeChatKey, entry.handle);
        let protocolMsgCount = state.protocolMsgCount || OjQwenAdapter.countProtocolMessagesInChat();
        taskTurn = crypto.randomUUID();
        state.activeTaskTurn = taskTurn;
        let stepNum = 0;
        let nextKind = 'TASK';
        let nextResults = null;
        let nextPlanDirective = null;
        let retriedBrokenJson = false;

        while (!run.stopped) {
          stepNum++;
          const turn = stepNum === 1 ? taskTurn : crypto.randomUUID();
          const includeFull = OjProtocol.shouldIncludeFullProtocol(protocolMsgCount);
          const memKeys = Object.keys(memoryByChat[state.activeChatKey] || {});
          const currentPlan = state.activePlan;

          let packetText;
          if (nextKind === 'TASK') {
            packetText = OjProtocol.buildTaskPacket({
              turn,
              task: cleanTask,
              workspace: snapshot,
              includeFullProtocol: includeFull,
              activePlan: currentPlan?.status === 'active' ? buildPlanDirective(currentPlan) : null,
              memoryKeys: memKeys,
            });
          } else {
            packetText = OjProtocol.buildResultsPacket({
              turn,
              results: nextKind === 'RETRY' ? null : nextResults,
              includeFullProtocol: includeFull,
              retryReason: nextKind === 'RETRY' ? nextResults : null,
              nextPlanPrompt: nextPlanDirective,
              memoryKeys: memKeys,
            });
          }

          state.liveStatus = stepNum === 1 ? 'Отправляю задачу в Qwen…' : `Отправляю результаты (шаг ${stepNum})…`;
          emit('status');

          const prevAnswers = new Set(OjQwenAdapter.readAssistantAnswers());
          for (const m of state.transcript) {
            if (m.role === 'qwen' && m.text) prevAnswers.add(m.text);
          }
          const beforeLastMsgId = state.isDraft ? '' : await fetchLastApiMessageId(state.activeChatKey);
          await OjQwenAdapter.sendMessage(packetText, { isCancelled: () => run.stopped });
          protocolMsgCount++;
          state.protocolMsgCount = protocolMsgCount;
          bumpLiveTokens(packetText);
          emit('status');

          const received = await waitForReply({
            turn,
            expectProtocol: true,
            previousAnswers: prevAnswers,
            beforeLastMsgId,
            knownIds,
            sendStartedAt,
            run,
          });

          if (state.isDraft) await detectAndBindNewChat(knownIds, sendStartedAt);
          await loadTranscriptFromApi(state.activeChatKey);

          if (received.kind === 'parse-error') {
            if (!retriedBrokenJson) {
              retriedBrokenJson = true;
              state.liveSteps.push({
                op: 'retry',
                path: '',
                label: 'Повторный запрос (некорректный JSON)',
                status: 'error',
                resultText: received.reason,
              });
              emit('steps');
              nextKind = 'RETRY';
              nextResults = received.reason;
              nextPlanDirective = null;
              continue;
            }
            throw new Error('Qwen дважды вернул повреждённый пакет протокола: ' + received.reason);
          }

          retriedBrokenJson = false;

          if (received.kind === 'plain') {
            finalAssistantText = received.summary || '';
            saveStepHistory(taskTurn, state.activeChatKey, state.liveSteps);
            return;
          }

          const reply = received.reply;
          if (reply.type === 'final') {
            finalAssistantText = reply.summary || '';
            saveStepHistory(taskTurn, state.activeChatKey, state.liveSteps);
            return;
          }

          state.liveStatus = `Выполняю операции (${reply.operations.length})…`;
          emit('status');
          const exec = await executeBatch(reply.operations, run, expectedRevision);
          saveStepHistory(taskTurn, state.activeChatKey, state.liveSteps);
          await refreshWorkspaceInfo();

          nextKind = 'RESULTS';
          nextResults = exec.results;
          nextPlanDirective = exec.planDirective;
        }
      } catch (err) {
        if (!run.stopped) {
          state.error = err.message;
        }
      } finally {
        // Keep state.running = true while finalizing chat binding & transcript sync so user clicks can't race!
        state.liveStatus = '';
        if (state.pendingConfirmation) {
          state.pendingConfirmation.resolve(false);
          state.pendingConfirmation = null;
        }
        if (state.pendingQuestion) {
          state.pendingQuestion.resolve('');
          state.pendingQuestion = null;
        }

        // Bind newly created chat via URL or API so nothing is lost on completion!
        if (state.isDraft) {
          await detectAndBindNewChat(knownIds, sendStartedAt);
        }

        const loadedViaApi = await loadTranscriptFromApi(state.activeChatKey);
        if (!loadedViaApi) {
          const domMsgs = OjQwenAdapter.readTranscript();
          if (domMsgs.length) {
            state.transcript = domMsgs;
          }
          const domCtx = OjQwenAdapter.estimateContextWindow().used;
          state.contextWindow = makeContextWindow(Math.max(state.contextWindow.used, liveTokenEstimate, domCtx));
        }

        // Guarantee the just-completed user prompt & assistant reply are present even if Qwen API lagged behind DOM
        if (cleanTask) {
          const appended = [...state.transcript];
          const hasUserMsg = appended.some(m => m.role === 'user' && ((taskTurn && m.turn === taskTurn) || m.text === cleanTask));
          if (!hasUserMsg) {
            appended.push({ role: 'user', text: cleanTask, unformatted: false, turn: taskTurn });
          }
          if (finalAssistantText) {
            const last = appended.at(-1);
            if (!(last?.role === 'qwen' && last.text === finalAssistantText)) {
              appended.push({ role: 'qwen', text: finalAssistantText, unformatted: false, turn: taskTurn });
            }
          }
          state.transcript = appended;
        }

        if (taskTurn && state.liveSteps.length) {
          saveStepHistory(taskTurn, state.activeChatKey, state.liveSteps);
        }
        state.liveTask = null;
        state.activeTaskTurn = null;
        await refreshWorkspaceInfo();
        state.running = false;
        activeRun = null;
        emit('run');
      }
    }

    function stop() {
      if (activeRun) activeRun.stopped = true;
      state.stopped = true;
      if (state.pendingConfirmation) {
        state.pendingConfirmation.resolve(false);
        state.pendingConfirmation = null;
      }
      if (state.pendingQuestion) {
        state.pendingQuestion.resolve('');
        state.pendingQuestion = null;
      }
      OjQwenAdapter.stopGeneration();
      state.liveStatus = 'Останавливаю…';
      emit('status');
    }

    async function checkUpdates(force = false) {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'oj:check-update', force: Boolean(force) });
        if (reply?.error) {
          if (force) throw new Error(reply.error);
          return null;
        }
        if (reply?.data) {
          state.updateInfo = reply.data;
          emit('update');
          return reply.data;
        }
        return null;
      } catch (err) {
        if (force) throw err;
        return null;
      }
    }

    function getStepsForTurn(turn) {
      return (turn && stepHistory[turn]?.steps) || null;
    }

    function getSettings() {
      return { ...settings };
    }

    return {
      state,
      subscribe,
      loadPersisted,
      getSettings,
      saveSettings,
      connect,
      syncCatalog,
      selectProject,
      startNewChat,
      selectChat,
      pickWorkspaceFolder,
      disconnectWorkspaceFolder,
      previewFile,
      restoreBackup,
      setError,
      sendTask,
      resolveConfirmation,
      resolveQuestion,
      stop,
      checkUpdates,
      getStepsForTurn,
      refreshWorkspaceInfo,
      collectDomDiagnostics: () => OjQwenAdapter.collectDomDiagnostics(),
    };
  }

  return { createEngine };
})();
