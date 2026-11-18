(() => {
  if (globalThis.__ojQwenBootstrapped) return;
  globalThis.__ojQwenBootstrapped = true;

  // Clean up any leftover floating toggle from previous extension reloads
  document.querySelectorAll('[data-oj-qwen-launcher],[data-oj-qwen-overlay]').forEach(el => el.remove());

  const launcherHost = document.createElement('div');
  launcherHost.dataset.ojQwenLauncher = '1';
  launcherHost.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;';
  const launcherShadow = launcherHost.attachShadow({ mode: 'closed' });
  const launcherCss = document.createElement('link');
  launcherCss.rel = 'stylesheet';
  launcherCss.href = chrome.runtime.getURL('lib/launcher.css');
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.id = 'openBtn';
  openBtn.className = 'oj-launcher-btn';
  openBtn.title = 'Открыть OJ-QWEN (Alt + Q)';
  openBtn.textContent = 'OJ-QWEN';
  launcherShadow.append(launcherCss, openBtn);
  document.documentElement.appendChild(launcherHost);

  let engine = null;
  let ui = null;
  let initPromise = null;
  let initialized = false;

  async function persistOverlayState(open) {
    await chrome.runtime.sendMessage({ type: 'oj:overlay-state', open }).catch(() => {});
  }

  async function ensureMounted() {
    if (ui) return;
    if (!initPromise) {
      initPromise = (async () => {
        const createdEngine = OjAgentEngine.createEngine();
        await createdEngine.loadPersisted();
        const createdUi = OjOverlayUI.mountOverlay({
          engine: createdEngine,
          onHideOverlay: () => {
            createdUi.hide();
            launcherHost.hidden = false;
            void persistOverlayState(false);
          },
        });
        engine = createdEngine;
        ui = createdUi;
      })().catch(err => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
  }

  async function openOverlay() {
    await ensureMounted();
    launcherHost.hidden = true;
    ui.show();
    void persistOverlayState(true);
    if (!initialized || !engine.state.projectReady) {
      initialized = true;
      void engine.connect();
    } else {
      void engine.syncCatalog();
      void engine.refreshWorkspaceInfo();
    }
  }

  function toggleOverlay() {
    if (ui?.isVisible()) {
      ui.hide();
      launcherHost.hidden = false;
      void persistOverlayState(false);
    } else {
      void openOverlay();
    }
  }

  launcherShadow.getElementById('openBtn').addEventListener('click', () => void openOverlay());

  window.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyQ') {
      e.preventDefault();
      toggleOverlay();
    }
  });

  // Restore overlay automatically if it was open in this tab before reload
  chrome.runtime.sendMessage({ type: 'oj:overlay-state' })
    .then(reply => {
      if (reply?.data?.open) void openOverlay();
    })
    .catch(() => {});
})();
