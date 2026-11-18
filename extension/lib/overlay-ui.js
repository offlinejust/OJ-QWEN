var OjOverlayUI = (() => {
  function formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function mountOverlay({ engine, onHideOverlay }) {
    const host = document.createElement('div');
    host.dataset.ojQwenOverlay = '1';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = chrome.runtime.getURL('lib/overlay.css');
    shadow.appendChild(cssLink);

    const appVersion = chrome.runtime.getManifest().version;
    const app = document.createElement('div');
    app.className = 'app';
    app.innerHTML = `
      <aside id="sidebar" class="sidebar" aria-label="Диалоги">
        <div class="brand-row">
          <div class="brand"><h1>OJ-QWEN</h1><span class="ver">${appVersion}</span></div>
          <div id="updateWrap" class="update-wrap" hidden>
            <a id="updateIndicator" class="update-indicator" href="https://github.com/offlinejust/OJ-QWEN/releases/latest" target="_blank" rel="noopener noreferrer">Доступно обновление</a>
            <div id="updateTooltip" class="update-tooltip" role="tooltip"></div>
          </div>
        </div>
        <div class="project-box">
          <label class="project-label" for="projectSelect">Проект</label>
          <select id="projectSelect" class="project-select" aria-label="Выбор проекта Qwen"></select>
        </div>
        <input type="search" id="chatSearch" class="search-input" placeholder="Поиск чатов…">
        <div id="chatList" class="chat-list"></div>
        <div class="sidebar-foot">
          <button type="button" id="syncBtn">Обновить</button>
          <button type="button" id="settingsBtn">Настройки</button>
        </div>
      </aside>

      <section class="main">
        <header class="topbar">
          <div class="topbar-left">
            <button type="button" id="sidebarToggle" class="sidebar-toggle" title="Показать/скрыть список чатов" aria-label="Список чатов">☰</button>
            <div class="topbar-title-wrap">
              <div id="chatTitle" class="chat-title">Новый чат</div>
              <div id="connStatus" class="conn-status">Подключаюсь к Qwen…</div>
            </div>
          </div>
          <div class="topbar-actions">
            <div id="ctxMeter" class="ctx-meter" title="Контекстное окно Qwen (1 000 000 токенов)">
              <span id="ctxText">0 / 1M · 0,0%</span>
              <span class="ctx-bar"><span id="ctxFill" class="ctx-fill" style="width:0%"></span></span>
            </div>
            <button type="button" id="retryConn" hidden>Повторить</button>
            <button type="button" id="wsBtn" class="ws-btn">📁 Выбрать папку</button>
            <button type="button" id="wsDisconnect" class="mini-btn" title="Отключить рабочую папку" hidden>✕</button>
            <button type="button" id="drawerToggle">Панель</button>
            <button type="button" id="showQwen">Показать Qwen ↗</button>
          </div>
        </header>

        <div id="feedWrap" class="feed-wrap">
          <div id="feed" class="feed"></div>
        </div>

        <div class="composer-area">
          <form id="composer" class="composer-inner">
            <div id="mentionMenu" class="mention-menu" hidden></div>
            <textarea id="taskInput" rows="2" placeholder="Напиши поручение Qwen… (введи @ для выбора файла из папки)"></textarea>
            <div class="composer-bar">
              <span id="shortcutHint" class="composer-hint">Enter — отправить · Shift + Enter — перенос · @ — файл · Alt + Q — Qwen</span>
              <div class="composer-btns">
                <button type="button" id="stopBtn" class="danger" hidden>Стоп</button>
                <button type="submit" id="sendBtn" class="primary">Отправить</button>
              </div>
            </div>
          </form>
          <button type="button" id="reportBugBtn" class="subtle-link bug-corner-btn">Сообщить об ошибке</button>
        </div>
      </section>

      <aside id="drawer" class="drawer" hidden aria-label="Файлы, планы и правки">
        <div class="drawer-tabs">
          <button type="button" id="tabFiles" aria-selected="true">Файлы</button>
          <button type="button" id="tabPlan" aria-selected="false">Планы</button>
          <button type="button" id="tabChanges" aria-selected="false">Правки (0)</button>
        </div>
        <div id="drawerBody" class="drawer-body"></div>
      </aside>

      <div id="modalBackdrop" class="modal-backdrop" hidden></div>
    `;
    shadow.appendChild(app);

    shadow.addEventListener('keydown', e => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyQ') {
        e.preventDefault();
        e.stopPropagation();
        onHideOverlay();
        return;
      }
      if (e.key === 'Escape' && !$('modalBackdrop').hidden) {
        e.preventDefault();
        e.stopPropagation();
        $('modalBackdrop').hidden = true;
        return;
      }
      e.stopPropagation();
    });
    for (const evt of ['keyup', 'keypress']) {
      shadow.addEventListener(evt, e => e.stopPropagation());
    }

    const $ = id => shadow.getElementById(id);
    const feedWrap = $('feedWrap');
    const feed = $('feed');
    const taskInput = $('taskInput');
    const mentionMenu = $('mentionMenu');

    let drawerOpen = false;
    let drawerTab = 'files'; // 'files' | 'plan' | 'changes'
    let fileFilter = '';
    let chatSearchQuery = '';
    let lastTranscriptKey = '';
    let lastLiveKey = '';
    let lastDrawerKey = '';
    let questionDraft = '';
    let lastQuestionText = '';
    let mentionItems = [];
    let mentionIdx = 0;
    let lastMentionQuery = null;

    function isNearBottom() {
      return feedWrap.scrollHeight - feedWrap.scrollTop - feedWrap.clientHeight < 120;
    }

    function scrollBottomIfFollowing(wasNear) {
      if (wasNear) feedWrap.scrollTop = feedWrap.scrollHeight;
    }

    function renderDiffElement(diff) {
      if (!diff || (!diff.added?.length && !diff.removed?.length)) return null;
      const box = document.createElement('div');
      box.className = 'diff-view';
      const meta = document.createElement('div');
      meta.className = 'diff-meta';
      meta.textContent = `Строка ${diff.startLine || 1}`;
      box.appendChild(meta);
      for (const line of (diff.removed || [])) {
        const div = document.createElement('div');
        div.className = 'diff-line diff-del';
        div.textContent = '- ' + line;
        box.appendChild(div);
      }
      for (const line of (diff.added || [])) {
        const div = document.createElement('div');
        div.className = 'diff-line diff-add';
        div.textContent = '+ ' + line;
        box.appendChild(div);
      }
      return box;
    }

    function renderStepsBlock(steps) {
      const box = document.createElement('div');
      box.className = 'steps-box';
      for (const step of steps) {
        const row = document.createElement('div');
        row.className = 'step-row';

        const head = document.createElement('div');
        head.className = 'step-head';

        const dot = document.createElement('span');
        dot.className = 'step-dot ' + (step.status || 'done');

        const label = document.createElement('span');
        label.className = 'step-label';
        label.textContent = step.label;

        const res = document.createElement('span');
        res.className = 'step-result';
        res.textContent = step.resultText || '';

        const actions = document.createElement('span');
        actions.className = 'step-actions';

        let diffEl = null;
        if (step.diff && (step.diff.added?.length || step.diff.removed?.length)) {
          diffEl = renderDiffElement(step.diff);
          diffEl.hidden = true;
          const toggleDiff = document.createElement('button');
          toggleDiff.type = 'button';
          toggleDiff.className = 'mini-btn';
          toggleDiff.textContent = 'Diff';
          toggleDiff.onclick = () => {
            diffEl.hidden = !diffEl.hidden;
            toggleDiff.textContent = diffEl.hidden ? 'Diff' : 'Скрыть';
          };
          actions.appendChild(toggleDiff);
        }

        if (step.backupId) {
          const st = engine.state;
          const backupRec = st.backups.find(b => b.id === step.backupId);
          const alreadyRestored = Boolean(backupRec?.restoredAt);
          const undoBtn = document.createElement('button');
          undoBtn.type = 'button';
          undoBtn.className = 'mini-btn undo';
          undoBtn.disabled = alreadyRestored || st.running;
          undoBtn.textContent = alreadyRestored ? 'Откачено' : 'Откатить';
          undoBtn.onclick = async () => {
            undoBtn.disabled = true;
            undoBtn.textContent = 'Откатываю…';
            try {
              await engine.restoreBackup(step.backupId);
              undoBtn.textContent = 'Откачено';
            } catch (err) {
              undoBtn.disabled = false;
              undoBtn.textContent = 'Откатить';
              engine.setError(err.message);
            }
          };
          actions.appendChild(undoBtn);
        }

        head.append(dot, label, res, actions);
        row.appendChild(head);
        if (diffEl) row.appendChild(diffEl);
        box.appendChild(row);
      }
      return box;
    }

    function createMessageEl(role, text, unformatted) {
      const article = document.createElement('article');
      article.className = 'msg';
      article.dataset.role = role;

      const label = document.createElement('span');
      label.className = 'msg-role';
      label.textContent = role === 'user' ? 'Вы' : unformatted ? 'Qwen (вне протокола)' : 'Qwen';
      article.appendChild(label);

      const body = document.createElement('div');
      if (role === 'user') body.textContent = text;
      else body.appendChild(OjMarkdown.render(text));
      article.appendChild(body);
      return article;
    }

    function renderUpdateIndicator() {
      const info = engine.state.updateInfo;
      const wrap = $('updateWrap');
      if (!info?.hasUpdate) {
        wrap.hidden = true;
        return;
      }
      const link = $('updateIndicator');
      const tip = $('updateTooltip');
      const latest = info.latestVersion || '';
      const tipText =
        `Вышла версия ${latest} (у вас ${info.currentVersion || appVersion}). ` +
        `Запустите «Обновить.cmd» в папке с распакованным расширением OJ-QWEN, ` +
        `затем нажмите ↻ на странице расширений (chrome://extensions или browser://extensions). ` +
        `Нажмите, чтобы открыть страницу релиза.`;
      link.href = info.releaseUrl || 'https://github.com/offlinejust/OJ-QWEN/releases/latest';
      link.title = tipText;
      tip.textContent = tipText;
      wrap.hidden = false;
    }

    function renderSidebar() {
      const st = engine.state;
      const selectEl = $('projectSelect');
      const currentOptions = [...selectEl.options].map(o => o.value);
      if (JSON.stringify(currentOptions) !== JSON.stringify(st.projects)) {
        selectEl.replaceChildren();
        for (const name of st.projects) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          selectEl.appendChild(opt);
        }
      }
      selectEl.value = st.projectName;
      selectEl.disabled = st.running || st.connecting;

      const q = chatSearchQuery.trim().toLowerCase();
      const items = st.catalog.filter(c => !q || c.title.toLowerCase().includes(q));
      const listEl = $('chatList');
      listEl.replaceChildren();

      const busySwitch = st.running || st.connecting || st.loadingChat;
      // Always one "+ Новый чат" item at the top of the list (no separate "+ Чат" button)
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'chat-item new-chat-row';
      newBtn.setAttribute('aria-current', String(st.isDraft));
      newBtn.disabled = busySwitch || !st.projectReady;
      const newTitle = document.createElement('span');
      newTitle.className = 'chat-item-title';
      newTitle.textContent = '+ Новый чат';
      newBtn.appendChild(newTitle);
      if (st.isDraft && st.workspace?.name) {
        const pill = document.createElement('span');
        pill.className = 'chat-folder-pill';
        pill.textContent = st.workspace.name;
        newBtn.appendChild(pill);
      }
      newBtn.onclick = () => {
        $('sidebar').classList.remove('open');
        engine.startNewChat();
        taskInput.focus();
      };
      listEl.appendChild(newBtn);

      if (!items.length && st.connecting) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = 'Загружаю чаты…';
        listEl.appendChild(empty);
        return;
      }

      for (const chat of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-item';
        btn.setAttribute('aria-current', String(!st.isDraft && chat.key === st.activeChatKey));
        btn.disabled = busySwitch;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'chat-item-title';
        titleSpan.textContent = chat.title;
        titleSpan.title = chat.title;
        btn.appendChild(titleSpan);

        const badge = st.folderBadges[chat.key];
        if (badge?.name) {
          const pill = document.createElement('span');
          pill.className = 'chat-folder-pill';
          pill.textContent = badge.name;
          pill.title = 'Рабочая папка: ' + badge.name;
          btn.appendChild(pill);
        }

        btn.onclick = () => {
          $('sidebar').classList.remove('open');
          void engine.selectChat(chat.key);
        };
        listEl.appendChild(btn);
      }
    }

    function renderTopbar() {
      const st = engine.state;
      $('chatTitle').textContent = st.activeChatTitle || 'Новый чат';
      const conn = $('connStatus');
      conn.textContent = st.connectionText;
      conn.className = st.connectionError ? 'conn-status error' : 'conn-status';
      $('retryConn').hidden = !st.connectionError;

      // Context window meter (1,000,000 tokens + percentage formatted as 0,0%)
      const ctx = st.contextWindow || { used: 0, limit: 1_000_000, remaining: 1_000_000, percent: 0 };
      const pctText = ctx.percent.toFixed(1).replace('.', ',') + '%';
      const meter = $('ctxMeter');
      $('ctxText').textContent = `${formatTokens(ctx.used)} / ${formatTokens(ctx.limit)} · ${pctText}`;
      $('ctxFill').style.width = Math.min(100, Math.max(0, ctx.percent)).toFixed(1) + '%';
      meter.className = ctx.percent >= 85 ? 'ctx-meter danger' : ctx.percent >= 60 ? 'ctx-meter warn' : 'ctx-meter';
      meter.title = `Контекст чата Qwen: ~${ctx.used.toLocaleString('ru-RU')} токенов (${pctText}). Осталось ~${ctx.remaining.toLocaleString('ru-RU')} до 1 000 000.`;

      const wsBtn = $('wsBtn');
      const wsDis = $('wsDisconnect');
      const wsLocked = st.running || st.connecting || st.loadingChat;
      wsBtn.disabled = wsLocked;
      wsDis.disabled = wsLocked;
      if (st.workspace) {
        wsBtn.textContent = st.workspace.granted
          ? `📁 ${st.workspace.name}`
          : `⚠ Подтвердить: ${st.workspace.name}`;
        wsBtn.className = st.workspace.granted ? 'ws-btn granted' : 'ws-btn warn';
        wsBtn.title = st.workspace.granted ? 'Нажмите, чтобы сменить рабочую папку' : 'Нажмите, чтобы подтвердить доступ к папке';
        wsDis.hidden = false;
      } else {
        wsBtn.textContent = '📁 Выбрать папку';
        wsBtn.className = 'ws-btn';
        wsBtn.title = 'Выбрать подпапку проекта для работы Qwen с файлами';
        wsDis.hidden = true;
      }

      const activeBackups = st.backups.filter(b => !b.restoredAt).length;
      const planBadge = st.activePlan?.status === 'active'
        ? ` · План ${st.activePlan.currentIndex + 1}/${st.activePlan.steps.length}`
        : '';
      $('drawerToggle').textContent = `Панель${planBadge}${activeBackups ? ` (${activeBackups})` : ''}`;
      $('tabPlan').textContent = st.plans?.length ? `Планы (${st.plans.length})` : 'Планы';
      $('tabChanges').textContent = `Правки (${st.backups.length})`;
    }

    function renderActivePlanBanner(plan) {
      if (!plan || plan.status !== 'active') return null;
      const step = plan.steps[plan.currentIndex];
      const box = document.createElement('div');
      box.className = 'plan-banner';

      const head = document.createElement('div');
      head.className = 'plan-banner-head';
      const title = document.createElement('span');
      title.textContent = `План (${plan.currentIndex + 1}/${plan.steps.length}): ${step?.title || plan.goal}`;
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'mini-btn';
      openBtn.textContent = 'Подробнее';
      openBtn.onclick = () => {
        drawerOpen = true;
        drawerTab = 'plan';
        renderDrawer();
      };
      head.append(title, openBtn);
      box.appendChild(head);

      if (step?.objective) {
        const obj = document.createElement('div');
        obj.style.color = '#b8c7b0';
        obj.textContent = step.objective;
        box.appendChild(obj);
      }
      return box;
    }

    function renderFeed(force = false) {
      const st = engine.state;
      const restoredBackupSig = st.backups.filter(b => b.restoredAt).map(b => b.id).join(',');
      const tKey = JSON.stringify([
        st.activeChatKey,
        st.transcript.length,
        st.transcript.at(-1)?.text?.slice(-40),
        st.running,
        st.running ? 0 : st.liveSteps.length,
        restoredBackupSig,
      ]);
      const lKey = JSON.stringify([
        st.running,
        st.liveTask,
        st.liveStatus,
        st.liveSteps,
        restoredBackupSig,
        st.pendingConfirmation ? `${st.pendingConfirmation.op}:${st.pendingConfirmation.path}` : '',
        st.pendingQuestion ? `${st.pendingQuestion.question}:${(st.pendingQuestion.options || []).join('|')}` : '',
        st.activePlan?.status,
        st.activePlan?.currentIndex,
        st.error,
      ]);

      if (!force && tKey === lastTranscriptKey && lKey === lastLiveKey) return;
      const wasNear = isNearBottom();

      if (force || tKey !== lastTranscriptKey) {
        lastTranscriptKey = tKey;
        feed.replaceChildren();

        if (!st.transcript.length && !st.liveTask) {
          const welcome = document.createElement('div');
          welcome.className = 'welcome';
          welcome.innerHTML = `
            <h2>OJ-QWEN ${appVersion}</h2>
            <p>Нажмите «📁 Выбрать папку» в шапке и укажите подпапку проекта — Qwen сможет исследовать код, составлять пошаговые планы с самоприёмкой, редактировать файлы с diff и откатом.</p>
            <p>Без выбранной папки чат работает как обычный клиент Qwen.</p>
          `;
          feed.appendChild(welcome);
        } else {
          for (const msg of st.transcript) {
            feed.appendChild(createMessageEl(msg.role, msg.text, msg.unformatted));
            if (msg.role === 'user' && msg.turn) {
              // Avoid duplicating liveSteps that are already rendered in liveZone for the active running turn
              if (st.running && st.activeTaskTurn && msg.turn === st.activeTaskTurn) continue;
              const savedSteps = engine.getStepsForTurn(msg.turn);
              if (savedSteps?.length) {
                feed.appendChild(renderStepsBlock(savedSteps));
              }
            }
          }
        }
      }

      let liveZone = feed.querySelector('[data-live-zone]');
      if (!liveZone) {
        liveZone = document.createElement('div');
        liveZone.dataset.liveZone = '1';
        liveZone.style.display = 'flex';
        liveZone.style.flexDirection = 'column';
        liveZone.style.gap = '12px';
        feed.appendChild(liveZone);
      }
      liveZone.replaceChildren();
      lastLiveKey = lKey;

      const planBanner = renderActivePlanBanner(st.activePlan);
      if (planBanner) liveZone.appendChild(planBanner);

      if (st.liveTask && st.running) {
        const lastMsg = st.transcript.at(-1);
        if (!(lastMsg?.role === 'user' && lastMsg.text === st.liveTask)) {
          liveZone.appendChild(createMessageEl('user', st.liveTask, false));
        }
      }

      if (st.liveSteps.length && st.running) {
        liveZone.appendChild(renderStepsBlock(st.liveSteps));
      }

      if (st.pendingConfirmation) {
        const conf = st.pendingConfirmation;
        const card = document.createElement('div');
        card.className = 'confirm-card';
        const txt = document.createElement('div');
        txt.append(
          document.createTextNode(`Qwen запрашивает: ${conf.actionTitle} `),
          Object.assign(document.createElement('code'), { textContent: conf.path }),
          document.createTextNode(
            conf.details
              ? ` (${conf.details})`
              : conf.danger
                ? ' (перед удалением сохранится бэкап)'
                : ' (с сохранением бэкапа)'
          )
        );
        const btns = document.createElement('div');
        btns.className = 'confirm-btns';
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = conf.danger ? 'danger' : 'primary';
        approve.textContent = conf.op === 'rmdir' ? 'Удалить папку' : conf.danger ? 'Удалить' : 'Разрешить';
        approve.onclick = () => engine.resolveConfirmation(true);
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.textContent = 'Отклонить';
        reject.onclick = () => engine.resolveConfirmation(false);
        btns.append(reject, approve);
        card.append(txt, btns);
        liveZone.appendChild(card);
      }

      if (st.pendingQuestion) {
        const q = st.pendingQuestion;
        if (q.question !== lastQuestionText) {
          lastQuestionText = q.question;
          questionDraft = '';
        }
        const card = document.createElement('div');
        card.className = 'question-card';

        const head = document.createElement('div');
        head.className = 'question-head';
        head.textContent = 'Вопрос от Qwen';

        const qText = document.createElement('div');
        qText.className = 'question-text';
        qText.textContent = q.question;
        card.append(head, qText);

        if (q.options?.length) {
          const optRow = document.createElement('div');
          optRow.className = 'question-options';
          for (const option of q.options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = option;
            btn.onclick = () => {
              questionDraft = '';
              lastQuestionText = '';
              engine.resolveQuestion(option);
            };
            optRow.appendChild(btn);
          }
          card.appendChild(optRow);
        }

        const inputRow = document.createElement('div');
        inputRow.className = 'question-input-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Введите свой ответ…';
        input.value = questionDraft;
        input.addEventListener('input', () => {
          questionDraft = input.value;
        });
        const sendAns = document.createElement('button');
        sendAns.type = 'button';
        sendAns.className = 'primary';
        sendAns.textContent = 'Ответить';
        const submitAnswer = () => {
          const val = input.value.trim();
          if (val) {
            questionDraft = '';
            lastQuestionText = '';
            engine.resolveQuestion(val);
          }
        };
        sendAns.onclick = submitAnswer;
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitAnswer();
          }
        });
        inputRow.append(input, sendAns);
        card.appendChild(inputRow);
        liveZone.appendChild(card);
      } else {
        questionDraft = '';
        lastQuestionText = '';
      }

      if (st.liveStatus) {
        const bar = document.createElement('div');
        bar.className = 'live-bar';
        const dot = document.createElement('span');
        dot.className = 'step-dot running';
        const span = document.createElement('span');
        span.textContent = st.liveStatus;
        bar.append(dot, span);
        liveZone.appendChild(bar);
      }

      if (st.error) {
        const errBox = document.createElement('div');
        errBox.className = 'error-banner';
        errBox.textContent = st.error;
        liveZone.appendChild(errBox);
      }

      scrollBottomIfFollowing(wasNear);
    }

    function renderComposer() {
      const st = engine.state;
      const cfg = engine.getSettings();
      $('shortcutHint').textContent = cfg.sendOnEnter
        ? 'Enter — отправить · Shift + Enter — перенос · @ — файл · Alt + Q — Qwen'
        : 'Ctrl + Enter — отправить · @ — файл · Alt + Q — Qwen';
      $('sendBtn').disabled = !st.projectReady || st.running || st.connecting || st.loadingChat;
      $('stopBtn').hidden = !st.running;
      $('stopBtn').disabled = st.stopped;
      $('syncBtn').disabled = st.running || st.connecting || st.syncingCatalog || !st.projectReady;
    }

    function computeDrawerKey() {
      const st = engine.state;
      if (drawerTab === 'files') {
        return JSON.stringify(['files', st.activeChatKey, Boolean(st.workspace?.granted), st.workspaceFilesList]);
      }
      if (drawerTab === 'plan') {
        return JSON.stringify(['plan', st.activeChatKey, st.plans, st.memory]);
      }
      return JSON.stringify([
        'changes',
        st.activeChatKey,
        st.running,
        st.backups.map(b => [b.id, b.restoredAt || 0]),
      ]);
    }

    function renderDrawer(force = false) {
      const drawer = $('drawer');
      drawer.hidden = !drawerOpen;
      if (!drawerOpen) return;

      $('tabFiles').setAttribute('aria-selected', String(drawerTab === 'files'));
      $('tabPlan').setAttribute('aria-selected', String(drawerTab === 'plan'));
      $('tabChanges').setAttribute('aria-selected', String(drawerTab === 'changes'));

      const dKey = computeDrawerKey();
      if (!force && dKey === lastDrawerKey) return;

      const body = $('drawerBody');
      const st = engine.state;

      // On the Files tab, preserve filterInput & focus when only the file list updates
      if (drawerTab === 'files' && st.workspace?.granted) {
        const existingInput = body.querySelector('[data-file-filter]');
        const existingList = body.querySelector('[data-files-list]');
        if (existingInput && existingList) {
          lastDrawerKey = dKey;
          renderFilesList(existingList);
          return;
        }
      }

      lastDrawerKey = dKey;
      body.replaceChildren();

      if (drawerTab === 'files') {
        if (!st.workspace?.granted) {
          const msg = document.createElement('div');
          msg.className = 'chat-empty';
          msg.textContent = 'Нажмите «📁 Выбрать папку» в шапке и выберите подпапку проекта.';
          body.appendChild(msg);
          return;
        }
        const filterInput = document.createElement('input');
        filterInput.type = 'search';
        filterInput.className = 'search-input';
        filterInput.dataset.fileFilter = '1';
        filterInput.placeholder = 'Фильтр файлов…';
        filterInput.value = fileFilter;
        const listWrap = document.createElement('div');
        listWrap.dataset.filesList = '1';
        listWrap.style.display = 'flex';
        listWrap.style.flexDirection = 'column';
        listWrap.style.gap = '2px';
        filterInput.oninput = () => {
          fileFilter = filterInput.value;
          renderFilesList(listWrap);
        };
        body.append(filterInput, listWrap);
        renderFilesList(listWrap);
        return;
      }

      if (drawerTab === 'plan') {
        const allPlans = st.plans || [];
        const activePlan = allPlans.find(p => p.status === 'active') || null;
        const pastPlans = allPlans.filter(p => p.status !== 'active').reverse();
        const statusLabels = { active: 'Активный', completed: 'Завершён', aborted: 'Прерван' };

        function buildPlanStepsList(plan) {
          const list = document.createElement('div');
          list.className = 'plan-step-list';
          plan.steps.forEach((step, idx) => {
            const card = document.createElement('div');
            const isCurrent = plan.status === 'active' && idx === plan.currentIndex;
            card.className = 'plan-step-card' + (isCurrent ? ' active' : step.status === 'done' ? ' done' : '');
            const mark = step.status === 'done' ? '✓' : isCurrent ? '▶' : '○';
            const title = document.createElement('strong');
            title.textContent = `${mark} ${step.id}. ${step.title}`;
            const obj = document.createElement('div');
            obj.textContent = step.objective;
            card.append(title, obj);
            if (step.approach) {
              const appDiv = document.createElement('div');
              appDiv.style.color = '#98a395';
              appDiv.textContent = 'Реализация: ' + step.approach;
              card.appendChild(appDiv);
            }
            if (step.acceptance?.length) {
              const ul = document.createElement('ul');
              ul.className = 'plan-acc';
              for (const acc of step.acceptance) {
                const li = document.createElement('li');
                li.textContent = acc;
                ul.appendChild(li);
              }
              card.appendChild(ul);
            }
            list.appendChild(card);
          });
          return list;
        }

        if (!activePlan && !pastPlans.length) {
          const empty = document.createElement('div');
          empty.className = 'chat-empty';
          empty.textContent = 'Планов в этом чате пока нет. Для сложных задач Qwen создаёт план через plan_create.';
          body.appendChild(empty);
        }

        if (activePlan) {
          const head = document.createElement('div');
          head.className = 'change-card';
          head.innerHTML = `<div class="change-head"><strong>Активный план</strong><span class="change-tag">Выполнено ${activePlan.currentIndex}/${activePlan.steps.length}</span></div>`;
          const goalP = document.createElement('div');
          goalP.style.fontSize = '12.5px';
          goalP.textContent = activePlan.goal;
          head.appendChild(goalP);
          body.appendChild(head);
          body.appendChild(buildPlanStepsList(activePlan));
        }

        if (pastPlans.length) {
          const histTitle = document.createElement('div');
          histTitle.className = 'project-label';
          histTitle.style.marginTop = activePlan ? '10px' : '0';
          histTitle.textContent = `Предыдущие планы (${pastPlans.length})`;
          body.appendChild(histTitle);

          for (const past of pastPlans) {
            const details = document.createElement('details');
            details.className = 'plan-history-item';
            const summary = document.createElement('summary');
            const label = document.createElement('span');
            label.className = 'file-path';
            const icon = past.status === 'completed' ? '✓' : '✕';
            label.textContent = `${icon} ${past.goal}`;
            label.title = past.goal;
            const tag = document.createElement('span');
            tag.className = 'change-tag' + (past.status === 'aborted' ? ' delete' : '');
            tag.textContent = `${statusLabels[past.status] || past.status} ${past.currentIndex}/${past.steps.length}`;
            summary.append(label, tag);
            details.appendChild(summary);

            if (past.abortReason) {
              const abortDiv = document.createElement('div');
              abortDiv.className = 'error-banner';
              abortDiv.style.marginBottom = '6px';
              abortDiv.textContent = 'Причина выхода: ' + past.abortReason;
              details.appendChild(abortDiv);
            }
            if (past.abortCompletedWork) {
              const cwDiv = document.createElement('div');
              cwDiv.style.fontSize = '12px';
              cwDiv.style.color = '#b8c3b4';
              cwDiv.style.marginBottom = '6px';
              cwDiv.textContent = 'Сделано: ' + past.abortCompletedWork;
              details.appendChild(cwDiv);
            }
            details.appendChild(buildPlanStepsList(past));
            body.appendChild(details);
          }
        }

        const memEntries = Object.entries(st.memory || {});
        if (memEntries.length) {
          const title = document.createElement('div');
          title.className = 'project-label';
          title.style.marginTop = '10px';
          title.textContent = `Память агента (${memEntries.length})`;
          body.appendChild(title);
          for (const [k, v] of memEntries) {
            const card = document.createElement('div');
            card.className = 'change-card';
            const strong = document.createElement('strong');
            strong.style.fontSize = '12px';
            strong.textContent = k;
            const txt = document.createElement('div');
            txt.style.fontSize = '12px';
            txt.style.color = '#b8c3b4';
            txt.style.whiteSpace = 'pre-wrap';
            txt.textContent = v.content;
            card.append(strong, txt);
            body.appendChild(card);
          }
        }
        return;
      }

      // Changes / Backups tab
      if (!st.backups.length) {
        const msg = document.createElement('div');
        msg.className = 'chat-empty';
        msg.textContent = 'В этом чате пока нет изменений файлов.';
        body.appendChild(msg);
        return;
      }

      for (const b of [...st.backups].reverse()) {
        const card = document.createElement('div');
        card.className = 'change-card';

        const head = document.createElement('div');
        head.className = 'change-head';
        const tag = document.createElement('span');
        tag.className = 'change-tag ' + (b.op === 'delete' || b.op === 'rmdir' ? 'delete' : b.op);
        tag.textContent = b.op === 'rename_dir' ? 'rename' : b.op;
        const p = document.createElement('span');
        p.className = 'file-path';
        p.textContent = (b.op === 'rename' || b.op === 'rename_dir') ? `${b.from} → ${b.to}` : b.path;
        p.title = p.textContent;

        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'mini-btn undo';
        undo.disabled = Boolean(b.restoredAt) || st.running;
        undo.textContent = b.restoredAt ? 'Откачено' : 'Откатить';
        undo.onclick = async () => {
          undo.disabled = true;
          try {
            await engine.restoreBackup(b.id);
          } catch (err) {
            undo.disabled = false;
            engine.setError(err.message);
          }
        };
        head.append(tag, p, undo);
        card.appendChild(head);

        if (b.diff) {
          const diffEl = renderDiffElement(b.diff);
          if (diffEl) card.appendChild(diffEl);
        }
        body.appendChild(card);
      }
    }

    function renderFilesList(container) {
      container.replaceChildren();
      const q = fileFilter.trim().toLowerCase();
      const files = engine.state.workspaceFilesList.filter(f => !q || f.toLowerCase().includes(q)).slice(0, 200);
      if (!files.length) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = 'Файлы не найдены';
        container.appendChild(empty);
        return;
      }
      for (const filePath of files) {
        const row = document.createElement('div');
        row.className = 'file-row';
        const span = document.createElement('span');
        span.className = 'file-path';
        span.textContent = filePath;
        span.title = filePath;
        span.onclick = () => void openFilePreview(filePath);

        const mentionBtn = document.createElement('button');
        mentionBtn.type = 'button';
        mentionBtn.className = 'mini-btn';
        mentionBtn.textContent = '@';
        mentionBtn.title = 'Упомянуть файл в сообщении';
        mentionBtn.onclick = e => {
          e.stopPropagation();
          insertTextAtCursor('@' + filePath + ' ');
        };
        row.append(span, mentionBtn);
        container.appendChild(row);
      }
    }

    function openModal(title, buildBody) {
      const backdrop = $('modalBackdrop');
      backdrop.replaceChildren();
      const modal = document.createElement('div');
      modal.className = 'modal';

      const head = document.createElement('div');
      head.className = 'modal-head';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mini-btn';
      closeBtn.textContent = 'Закрыть';
      closeBtn.onclick = () => { backdrop.hidden = true; };
      head.append(h3, closeBtn);

      const body = document.createElement('div');
      body.className = 'modal-body';
      buildBody(body, () => { backdrop.hidden = true; });

      modal.append(head, body);
      backdrop.appendChild(modal);
      backdrop.hidden = false;
      backdrop.onclick = e => { if (e.target === backdrop) backdrop.hidden = true; };
      closeBtn.focus();
    }

    async function openFilePreview(filePath) {
      openModal(filePath, (body) => {
        const loading = document.createElement('div');
        loading.textContent = 'Загружаю файл…';
        body.appendChild(loading);
        engine.previewFile(filePath).then(data => {
          body.replaceChildren();
          const pre = document.createElement('pre');
          pre.textContent = data.text;
          body.appendChild(pre);
        }).catch(err => {
          body.replaceChildren();
          const errDiv = document.createElement('div');
          errDiv.className = 'error-banner';
          errDiv.textContent = err.message;
          body.appendChild(errDiv);
        });
      });
    }

    function openSettingsModal() {
      const cfg = engine.getSettings();
      openModal('Настройки OJ-QWEN', (body, close) => {
        const fSafety = document.createElement('div');
        fSafety.className = 'field';
        fSafety.innerHTML = `
          <label for="setSafety">Режим безопасности (подтверждение изменений файлов)</label>
          <select id="setSafety">
            <option value="ask_all">Всё спрашивать (по умолчанию)</option>
            <option value="ask_delete">Разрешать всё, кроме удаления</option>
            <option value="allow_all">Всё разрешать (без подтверждений)</option>
          </select>
        `;
        fSafety.querySelector('#setSafety').value = cfg.safetyMode || 'ask_all';

        const fEnter = document.createElement('label');
        fEnter.className = 'checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = cfg.sendOnEnter;
        fEnter.append(cb, document.createTextNode('Отправлять по Enter (Shift+Enter — перенос строки)'));

        const note = document.createElement('div');
        note.style.fontSize = '12.5px';
        note.style.color = '#98a395';
        note.textContent = 'Чтение, поиск и планирование выполняются без вопросов. Все изменения файлов и папок сохраняют резервную копию с откатом во вкладке «Правки». Полные правила отправляются в 1-м сообщении и далее каждые 10 сообщений.';

        const updateBox = document.createElement('div');
        updateBox.className = 'change-card';
        const updHead = document.createElement('div');
        updHead.className = 'change-head';
        const updVer = document.createElement('strong');
        updVer.textContent = `Версия OJ-QWEN ${appVersion}`;
        const relLink = document.createElement('a');
        relLink.href = 'https://github.com/offlinejust/OJ-QWEN/releases/latest';
        relLink.target = '_blank';
        relLink.rel = 'noopener noreferrer';
        relLink.textContent = 'Релизы на GitHub ↗';
        updHead.append(updVer, relLink);

        const updStatus = document.createElement('div');
        updStatus.style.fontSize = '12px';
        updStatus.style.color = '#98a395';
        updStatus.textContent = 'Для обновления достаточно запустить «Обновить.cmd» в папке расширения и нажать ↻ в браузере.';

        const checkUpdBtn = document.createElement('button');
        checkUpdBtn.type = 'button';
        checkUpdBtn.textContent = 'Проверить обновления';
        checkUpdBtn.onclick = async () => {
          checkUpdBtn.disabled = true;
          checkUpdBtn.textContent = 'Проверяю GitHub…';
          try {
            const d = await engine.checkUpdates(true);
            if (d?.noReleases) {
              updStatus.style.color = '#98a395';
              updStatus.textContent = 'Релизы на GitHub пока не опубликованы.';
            } else if (d?.hasUpdate) {
              updStatus.style.color = '#c8eb7e';
              updStatus.textContent = `Доступна новая версия ${d.latestVersion} (у вас ${d.currentVersion})! Запустите «Обновить.cmd» или скачайте архив по ссылке выше.`;
              if (d.releaseUrl) relLink.href = d.releaseUrl;
            } else {
              updStatus.style.color = '#8de09b';
              updStatus.textContent = `У вас актуальная версия (${d?.currentVersion || appVersion}).`;
            }
          } catch (err) {
            updStatus.style.color = '#f58b80';
            updStatus.textContent = 'Не удалось проверить обновления: ' + err.message;
          } finally {
            checkUpdBtn.disabled = false;
            checkUpdBtn.textContent = 'Проверить обновления';
          }
        };
        updateBox.append(updHead, updStatus, checkUpdBtn);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'primary';
        saveBtn.textContent = 'Сохранить';
        saveBtn.onclick = async () => {
          await engine.saveSettings({
            sendOnEnter: cb.checked,
            safetyMode: fSafety.querySelector('#setSafety').value,
          });
          close();
        };

        body.append(fSafety, fEnter, note, updateBox, saveBtn);
      });
    }

    function openBugReportModal() {
      const st = engine.state;
      openModal('Сообщить об ошибке', (body) => {
        const hint = document.createElement('div');
        hint.style.fontSize = '12.5px';
        hint.style.color = '#98a395';
        hint.textContent = 'Опишите проблему — отчёт отправится разработчику напрямую без регистрации (переписка и файлы не прикладываются).';

        const fDesc = document.createElement('div');
        fDesc.className = 'field';
        const descLabel = document.createElement('label');
        descLabel.textContent = 'Что произошло?';
        const descInput = document.createElement('textarea');
        descInput.className = 'bug-textarea';
        descInput.placeholder = 'Например: при открытии проекта список чатов не загрузился, или кнопка не сработала…';
        fDesc.append(descLabel, descInput);

        const fDiag = document.createElement('label');
        fDiag.className = 'checkbox-row';
        const diagCb = document.createElement('input');
        diagCb.type = 'checkbox';
        diagCb.checked = true;
        fDiag.append(diagCb, document.createTextNode('Приложить техданные (версия, браузер, состояние движка и лог последних ошибок — без переписки и файлов)'));

        const statusDiv = document.createElement('div');
        statusDiv.style.fontSize = '12px';
        statusDiv.style.color = '#8de09b';
        statusDiv.hidden = true;

        function detectBrowserShort(ua) {
          const s = String(ua || '');
          const ya = /YaBrowser\/([\d.]+)/.exec(s);
          if (ya) return `Яндекс Браузер ${ya[1]}`;
          const edg = /Edg\/([\d.]+)/.exec(s);
          if (edg) return `Edge ${edg[1]}`;
          const opr = /OPR\/([\d.]+)/.exec(s);
          if (opr) return `Opera ${opr[1]}`;
          const chr = /Chrome\/([\d.]+)/.exec(s);
          if (chr) return `Chrome ${chr[1]}`;
          return s.slice(0, 80);
        }

        async function buildReportParts() {
          const userDesc = descInput.value.trim();
          const titleLine = userDesc.split('\n')[0].trim().slice(0, 90) || `Ошибка в OJ-QWEN ${appVersion}`;
          const envLines = [
            '### Описание проблемы',
            userDesc || '(без описания)',
            '',
            '### Среда',
            `- **Версия OJ-QWEN:** ${appVersion}`,
            `- **Браузер:** ${detectBrowserShort(navigator.userAgent)}`,
            `- **Окно:** ${window.innerWidth}×${window.innerHeight}`,
            `- **Режим безопасности:** ${engine.getSettings().safetyMode || 'ask_all'}`,
            `- **Рабочая папка:** ${st.workspace?.granted ? 'подключена' : st.workspace ? 'ждёт подтверждения' : 'не выбрана'}`,
          ];
          const lastErr = st.error || st.connectionError;
          if (lastErr) envLines.push(`- **Последняя ошибка:** ${lastErr}`);

          let diagJson = '';
          if (diagCb.checked) {
            try {
              const diag = await engine.collectBugDiagnostics();
              diagJson = JSON.stringify(diag, null, 2);
            } catch {}
          }
          const description = envLines.join('\n');
          const fullMarkdown = diagJson
            ? `${description}\n\n### Техническая диагностика (без переписки)\n\`\`\`json\n${diagJson}\n\`\`\``
            : description;
          return { title: titleLine, description, diagnostics: diagJson, fullMarkdown };
        }

        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'primary';
        sendBtn.textContent = 'Отправить отчёт';
        sendBtn.onclick = async () => {
          if (!descInput.value.trim()) {
            statusDiv.hidden = false;
            statusDiv.style.color = '#f0c975';
            statusDiv.textContent = 'Напишите хотя бы пару слов о том, что пошло не так.';
            descInput.focus();
            return;
          }
          sendBtn.disabled = true;
          sendBtn.textContent = 'Отправляю…';
          try {
            const parts = await buildReportParts();
            await engine.submitBugReport({
              title: parts.title,
              description: parts.description,
              diagnostics: parts.diagnostics,
            });
            statusDiv.hidden = false;
            statusDiv.style.color = '#8de09b';
            statusDiv.textContent = 'Спасибо! Отчёт успешно отправлен разработчику.';
            sendBtn.textContent = 'Отправлено ✓';
          } catch (err) {
            statusDiv.hidden = false;
            statusDiv.style.color = '#f58b80';
            statusDiv.textContent = 'Не удалось отправить напрямую: ' + err.message + ' Можно скопировать отчёт или открыть GitHub Issue ниже.';
            sendBtn.disabled = false;
            sendBtn.textContent = 'Отправить отчёт';
          }
        };

        const altRow = document.createElement('div');
        altRow.className = 'modal-actions';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = 'Скопировать отчёт';
        copyBtn.onclick = async () => {
          copyBtn.disabled = true;
          try {
            const parts = await buildReportParts();
            await navigator.clipboard.writeText(parts.fullMarkdown);
            statusDiv.hidden = false;
            statusDiv.style.color = '#8de09b';
            statusDiv.textContent = 'Отчёт скопирован в буфер обмена.';
          } catch {
            statusDiv.hidden = false;
            statusDiv.style.color = '#f58b80';
            statusDiv.textContent = 'Не удалось скопировать отчёт.';
          } finally {
            copyBtn.disabled = false;
          }
        };

        const ghBtn = document.createElement('button');
        ghBtn.type = 'button';
        ghBtn.textContent = 'Открыть GitHub Issue ↗';
        ghBtn.onclick = async () => {
          ghBtn.disabled = true;
          try {
            const parts = await buildReportParts();
            const trimmedBody = parts.fullMarkdown.length > 3500 ? parts.fullMarkdown.slice(0, 3480) + '\n…' : parts.fullMarkdown;
            const url = `https://github.com/offlinejust/OJ-QWEN/issues/new?labels=bug&title=${encodeURIComponent(parts.title)}&body=${encodeURIComponent(trimmedBody)}`;
            window.open(url, '_blank', 'noopener,noreferrer');
          } finally {
            ghBtn.disabled = false;
          }
        };

        altRow.append(copyBtn, ghBtn);
        body.append(hint, fDesc, fDiag, sendBtn, altRow, statusDiv);
        descInput.focus();
      });
    }

    function insertTextAtCursor(snippet) {
      const start = taskInput.selectionStart ?? taskInput.value.length;
      const end = taskInput.selectionEnd ?? taskInput.value.length;
      taskInput.value = taskInput.value.slice(0, start) + snippet + taskInput.value.slice(end);
      const pos = start + snippet.length;
      taskInput.setSelectionRange(pos, pos);
      taskInput.focus();
      autoResizeInput();
    }

    function hideMentions() {
      mentionMenu.hidden = true;
      mentionItems = [];
      lastMentionQuery = null;
    }

    function updateMentions() {
      const files = engine.state.workspaceFilesList;
      if (!files.length) {
        hideMentions();
        return;
      }
      const caret = taskInput.selectionStart ?? 0;
      const before = taskInput.value.slice(0, caret);
      const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
      if (!match) {
        hideMentions();
        return;
      }
      const query = match[1].toLowerCase();
      if (query !== lastMentionQuery) {
        lastMentionQuery = query;
        mentionIdx = 0;
      }
      mentionItems = files.filter(f => f.toLowerCase().includes(query)).slice(0, 10);
      if (!mentionItems.length) {
        hideMentions();
        return;
      }
      mentionIdx = Math.max(0, Math.min(mentionIdx, mentionItems.length - 1));
      mentionMenu.replaceChildren();
      let activeBtn = null;
      mentionItems.forEach((filePath, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = idx === mentionIdx ? 'mention-item active' : 'mention-item';
        btn.textContent = filePath;
        btn.onmousedown = e => {
          e.preventDefault();
          applyMention(filePath);
        };
        if (idx === mentionIdx) activeBtn = btn;
        mentionMenu.appendChild(btn);
      });
      mentionMenu.hidden = false;
      if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
        activeBtn.scrollIntoView({ block: 'nearest' });
      }
    }

    function applyMention(filePath) {
      const caret = taskInput.selectionStart ?? 0;
      const before = taskInput.value.slice(0, caret);
      const after = taskInput.value.slice(caret);
      if (!/@[^\s@]*$/.test(before)) {
        hideMentions();
        return;
      }
      const replaced = before.replace(/@[^\s@]*$/, '@' + filePath + ' ');
      taskInput.value = replaced + after;
      taskInput.setSelectionRange(replaced.length, replaced.length);
      hideMentions();
      taskInput.focus();
      autoResizeInput();
    }

    function autoResizeInput() {
      taskInput.style.height = 'auto';
      taskInput.style.height = Math.min(240, Math.max(44, taskInput.scrollHeight)) + 'px';
    }

    // ===== Event wiring =====
    $('sidebarToggle').onclick = () => $('sidebar').classList.toggle('open');
    $('projectSelect').onchange = e => void engine.selectProject(e.target.value);
    $('syncBtn').onclick = () => void engine.syncCatalog();
    $('settingsBtn').onclick = openSettingsModal;
    $('reportBugBtn').onclick = openBugReportModal;
    $('retryConn').onclick = () => void engine.connect();
    $('wsBtn').onclick = () => void engine.pickWorkspaceFolder();
    $('wsDisconnect').onclick = () => void engine.disconnectWorkspaceFolder();
    $('showQwen').onclick = () => onHideOverlay();
    $('stopBtn').onclick = () => engine.stop();

    $('drawerToggle').onclick = () => {
      drawerOpen = !drawerOpen;
      renderDrawer(true);
    };
    $('tabFiles').onclick = () => { drawerTab = 'files'; renderDrawer(true); };
    $('tabPlan').onclick = () => { drawerTab = 'plan'; renderDrawer(true); };
    $('tabChanges').onclick = () => { drawerTab = 'changes'; renderDrawer(true); };

    $('chatSearch').oninput = e => {
      chatSearchQuery = e.target.value;
      renderSidebar();
    };

    taskInput.addEventListener('input', () => {
      autoResizeInput();
      updateMentions();
    });
    taskInput.addEventListener('click', updateMentions);
    taskInput.addEventListener('blur', hideMentions);
    taskInput.addEventListener('keyup', e => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        updateMentions();
      }
    });

    taskInput.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (!mentionMenu.hidden && mentionItems.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mentionIdx = (mentionIdx + 1) % mentionItems.length;
          updateMentions();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          mentionIdx = (mentionIdx - 1 + mentionItems.length) % mentionItems.length;
          updateMentions();
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          applyMention(mentionItems[mentionIdx]);
          return;
        }
        if (e.key === 'Escape') {
          hideMentions();
          return;
        }
      }

      const sendOnEnter = engine.getSettings().sendOnEnter;
      if (e.key === 'Enter' && ((sendOnEnter && !e.shiftKey) || (!sendOnEnter && e.ctrlKey))) {
        e.preventDefault();
        $('composer').requestSubmit();
      }
    });

    $('composer').addEventListener('submit', e => {
      e.preventDefault();
      const val = taskInput.value.trim();
      if (!val || $('sendBtn').disabled) return;
      hideMentions();
      taskInput.value = '';
      autoResizeInput();
      void engine.sendTask(val);
    });

    engine.subscribe(event => {
      if (event === 'update') {
        renderUpdateIndicator();
        return;
      }
      renderTopbar();
      renderComposer();
      if (event === 'chat' || event === 'workspace') hideMentions();
      if (['connect', 'catalog', 'chat', 'workspace', 'run', 'settings'].includes(event)) renderSidebar();
      if (['connect', 'chat', 'workspace', 'run', 'steps', 'plan'].includes(event)) renderDrawer();
      renderFeed(event === 'chat' || event === 'connect');
    });

    document.documentElement.appendChild(host);

    return {
      host,
      show() {
        host.hidden = false;
        renderUpdateIndicator();
        renderSidebar();
        renderTopbar();
        renderComposer();
        renderDrawer();
        renderFeed(true);
        taskInput.focus();
      },
      hide() {
        host.hidden = true;
      },
      isVisible() {
        return !host.hidden;
      },
    };
  }

  return { mountOverlay };
})();
