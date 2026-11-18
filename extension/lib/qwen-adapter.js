var OjQwenAdapter = (() => {
  const SEND_RE = /^(?:send(?:\s+message)?|отправить(?:\s+сообщение)?|发送(?:消息)?)$/i;
  const STOP_RE = /^(?:stop(?:\s+generating|\s+generation|\s+response)?|остановить(?:\s+генерацию|\s+ответ)?|停止(?:生成)?)$/i;
  const SKIP_THINKING_RE = /^(?:пропустить(?:\s+размышление)?|skip(?:\s+thinking)?|跳过)$/i;
  const PREFER_RE = /^(?:предпочитаю этот ответ|(?:i\s+)?prefer this (?:response|answer)|(?:我)?更喜欢这[个条](?:回答|回复))[.!。]?$/i;
  const LOGIN_RE = /^(?:войти|log\s*in|sign\s*in|登录)$/i;
  const PROJECTS_HEADER_RE = /^(?:мои\s+)?(?:проекты|projects|项目)(?:\s*\(\d+\))?$/i;
  const NEW_PROJECT_RE = /^(?:новый проект|создать проект|new project|create project|新建项目)$/i;
  const CREATE_BTN_RE = /^(?:создать(?:\s+проект)?|create(?:\s+project)?|подтвердить|confirm|сохранить|save|ok|创建|确定)$/i;
  const CHATS_SECTION_RE = /^(?:чаты|chats|conversations|对话|聊天)$/i;
  const EMPTY_PROJECT_RE = /^(?:нет чатов|пока нет чатов|здесь пока нет чатов|в этом проекте ещё нет чатов|no chats(?:\s+yet)?|暂无对话)[.!]?$/i;
  const DATE_OR_SECTION_RE = /^(?:сегодня|вчера|недавно|ранее|прошл\S*|7\s*дн|30\s*дн|today|yesterday|previous|recent|chats|чаты|все чаты|all chats|новый чат|new chat|история|history|今天|昨天|最近)$/i;

  const SIDEBAR_SELECTOR = 'aside,nav,[role="navigation"],[class*="sidebar"],[class*="sider"],[class*="side-bar"],[class*="left-panel"],[class*="nav-bar"]';
  const USER_SELECTOR = '[data-message-author-role="user"],[data-role="user"],[class*="user-message"],[class*="chat-user"],[class*="message-user"]';
  const ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[class*="assistant-message"]',
    '[class*="response-message"]',
    '[class*="answer-content"]',
    '[class*="qwen-markdown"]',
    '[class*="markdown-content"]',
    '[class*="markdown-prose"]',
    '.markdown-body',
    '.message-content',
    '.prose',
  ].join(',');
  const THINKING_SELECTOR = '[class*="thinking"],[class*="reasoning"],[class*="thought"],details';
  const IGNORED_ANCESTORS = `${SIDEBAR_SELECTOR},[contenteditable],textarea,${THINKING_SELECTOR}`;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function buttonLabel(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('data-tooltip-content') ||
      el.textContent ||
      ''
    ).trim();
  }

  function isEnabledButton(el) {
    return !el.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
  }

  function findButtons(pattern, container = document) {
    return [...container.querySelectorAll('button,[role="button"]')].filter(el =>
      visible(el) && [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-tooltip-content'),
        el.textContent?.trim(),
      ].some(label => label && pattern.test(label))
    );
  }

  // Finds both <button>/[role="button"] and clickable <span>/<div> labels matching exact UI text
  function findControlsByText(pattern, container = document) {
    const found = new Set(findButtons(pattern, container));
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.data.trim();
      if (!text || text.length > 60 || !pattern.test(text)) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || !visible(parent) || parent.closest('textarea,[contenteditable],pre,code')) continue;
      const ctrl = parent.closest('button,[role="button"],a') || parent;
      if (visible(ctrl)) found.add(ctrl);
    }
    const list = [...found];
    return list.filter(el => !list.some(other => other !== el && other.contains(el)));
  }

  function extractChatKeyFromUrl(urlStr = location.href) {
    let url;
    try {
      url = new URL(urlStr, location.origin);
    } catch {
      return null;
    }
    if (url.origin !== 'https://chat.qwen.ai') return null;
    // Match both /c/<id>, /chat/<id>, and /p/<projectId>/c/<id>
    const pathMatch = /(?:^|\/)(?:c|chat)\/([a-zA-Z0-9_-]{4,128})(?:\/|$)/.exec(url.pathname);
    if (pathMatch) return 'c:' + pathMatch[1];
    const qId = url.searchParams.get('chat_id') || url.searchParams.get('chatId');
    if (qId && /^[a-zA-Z0-9_-]{4,128}$/.test(qId)) return 'c:' + qId;
    return null;
  }

  function extractProjectIdFromUrl(urlStr = location.href) {
    let url;
    try {
      url = new URL(urlStr, location.origin);
    } catch {
      return null;
    }
    if (url.origin !== 'https://chat.qwen.ai') return null;
    const m = /^\/p\/([a-zA-Z0-9_-]{8,128})/.exec(url.pathname);
    return m ? m[1] : null;
  }

  function extractChatIdFromKey(chatKey) {
    if (typeof chatKey !== 'string') return null;
    const m = /^c:([a-zA-Z0-9_-]{4,128})$/.exec(chatKey);
    return m ? m[1] : null;
  }

  async function spaNavigate(targetPath, { projectName = null, chatTitle = null } = {}) {
    if (location.pathname === targetPath) return true;

    // 1. Direct matching <a href="..."> anywhere in DOM
    const directLink = [...document.querySelectorAll('a[href]')].find(a => {
      try {
        return new URL(a.href, location.origin).pathname === targetPath && visible(a);
      } catch {
        return false;
      }
    });
    if (directLink) {
      fireClick(directLink);
      for (let i = 0; i < 16; i++) {
        await wait(200);
        if (location.pathname === targetPath && getComposer()) return true;
      }
    }

    // 2. Click project row inside .project-list-wrapper
    if (projectName && targetPath.startsWith('/p/')) {
      const container = document.querySelector('.project-list-wrapper, .project-container') || getSidebarRoot();
      if (container) {
        expandProjectsSectionIfNeeded();
        await wait(200);
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.data.trim() === projectName) {
            const target = resolveClickableTarget(walker.currentNode.parentElement, container);
            if (target) {
              fireClick(target);
              for (let i = 0; i < 16; i++) {
                await wait(200);
                if (location.pathname === targetPath || document.querySelector('.pcht__name')?.textContent?.trim() === projectName) {
                  return true;
                }
              }
              break;
            }
          }
        }
      }
    }

    // 3. Click chat row inside .pct__chats or .session-list
    if (chatTitle && targetPath.startsWith('/c/')) {
      const scope = document.querySelector('.pct__chats, .session-list');
      if (scope) {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.data.trim() === chatTitle) {
            const target = resolveClickableTarget(walker.currentNode.parentElement, scope);
            if (target) {
              fireClick(target);
              for (let i = 0; i < 16; i++) {
                await wait(200);
                if (location.pathname === targetPath && getComposer()) return true;
              }
              break;
            }
          }
        }
      }
    }

    // 4. SPA History API navigation (no full page reload -> preserves FileSystemDirectoryHandle in RAM!)
    if (location.pathname !== targetPath) {
      const prevPath = location.pathname;
      const prevComposer = getComposer();
      const prevHead = (getMainScope().innerText || '').slice(0, 160);
      try {
        window.history.pushState(window.history.state, '', targetPath);
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
        for (let i = 0; i < 16; i++) {
          await wait(200);
          const nowComposer = getComposer();
          const nowHead = (getMainScope().innerText || '').slice(0, 160);
          const projectOk = targetPath.startsWith('/p/')
            && Boolean(document.querySelector('.project-layout'))
            && (!projectName || document.querySelector('.pcht__name')?.textContent?.trim() === projectName);
          const viewChanged = (nowComposer && nowComposer !== prevComposer) || (nowHead !== prevHead);
          if (location.pathname === targetPath && (projectOk || (targetPath.startsWith('/c/') && viewChanged))) {
            return true;
          }
        }
        // Router ignored popstate — restore previous pathname so we never lie about current route
        window.history.replaceState(window.history.state, '', prevPath);
      } catch {}
    }

    return false;
  }

  function getSidebarRoot() {
    const candidates = [...document.querySelectorAll(SIDEBAR_SELECTOR)].filter(el => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      // Sidebar sits near the left edge and has noticeable height
      return rect.left < 160 && rect.width >= 120 && rect.width <= 460 && rect.height >= 200;
    });
    // Prefer widest top-level sidebar container
    candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
    return candidates[0] || null;
  }

  // Try clicking sidebar toggle button if sidebar is currently collapsed
  function openSidebarIfCollapsed() {
    if (getSidebarRoot()) return false;
    const toggleBtn = [...document.querySelectorAll('button,[role="button"]')].find(el => {
      if (!visible(el) || !isEnabledButton(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.left > 120 || rect.top > 120) return false;
      const lbl = buttonLabel(el);
      return /sidebar|menu|панел|меню|боков|open|expand|侧边栏/i.test(lbl) || (rect.width <= 44 && rect.height <= 44 && el.querySelector('svg'));
    });
    if (toggleBtn) {
      toggleBtn.click();
      return true;
    }
    return false;
  }

  function getMainScope() {
    return document.querySelector('main, .project-layout, [class*="chat-layout"], [class*="chat-container"]') || document.body;
  }

  function getComposer() {
    const editors = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(el =>
      visible(el) &&
      !el.disabled &&
      !el.readOnly &&
      !el.closest('pre,code,[role="dialog"],[aria-hidden="true"]')
    );
    const known = editors.filter(el =>
      ['placeholder', 'data-placeholder', 'aria-label'].some(attr =>
        /(?:спросить|ask)\s+qwen|问问?千问|message|сообщени|чем я могу|how can i help/i.test(el.getAttribute(attr) || '')
      )
    );
    return known.length === 1 ? known[0] : editors.length === 1 ? editors[0] : editors[0] || null;
  }

  function getDraftText(editor) {
    if (!editor) return '';
    return (editor.value ?? editor.innerText ?? '').replace(/\r\n/g, '\n').trim();
  }

  function writeDraft(editor, text) {
    editor.focus();
    if (editor.matches('textarea')) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);
  }

  function getSendButton(editor) {
    if (!editor) return null;
    for (let box = editor.parentElement; box && box !== document.body; box = box.parentElement) {
      const btns = findButtons(SEND_RE, box);
      if (btns.length) return btns.length === 1 ? btns[0] : null;
      // Fallback: submit button inside composer form
      const submitBtn = [...box.querySelectorAll('button[type="submit"]')].find(el => visible(el) && isEnabledButton(el));
      if (submitBtn) return submitBtn;
    }
    return null;
  }

  function isLoginVisible() {
    return [...document.querySelectorAll('button,a,[role="button"]')].some(el =>
      visible(el) && LOGIN_RE.test(buttonLabel(el))
    );
  }

  function getGenerationStatus() {
    const main = getMainScope();
    const stopSet = new Set(findButtons(STOP_RE));
    // Qwen's stop button in .message-input-wrapper is often an icon button with class containing "stop"
    const inputBox = document.querySelector('.message-input-wrapper') || document;
    for (const el of inputBox.querySelectorAll('button[class*="stop"],[role="button"][class*="stop"],[class*="stop-button"],[class*="stop-btn"]')) {
      if (visible(el)) stopSet.add(el);
    }
    // Deduplicate nested stop elements so stopGeneration never double-clicks a parent + child
    const stopRaw = [...stopSet];
    const stopButtons = stopRaw.filter(el => !stopRaw.some(other => other !== el && other.contains(el)));
    const skipControls = findControlsByText(SKIP_THINKING_RE, main).filter(isEnabledButton);
    const preferButtons = findControlsByText(PREFER_RE, main);
    const readyPreferButtons = preferButtons.filter(isEnabledButton);
    // When A/B preference buttons are already enabled and no stop button is active, thinking is done
    const thinking = skipControls.length > 0 && !(readyPreferButtons.length > 0 && stopButtons.length === 0);
    const generating = stopButtons.length > 0 || thinking;
    return { generating, thinking, preferButtons, readyPreferButtons, stopButtons };
  }

  function stopGeneration() {
    const { stopButtons } = getGenerationStatus();
    for (const btn of stopButtons) {
      if (isEnabledButton(btn)) btn.click();
    }
  }

  function findProjectsHeader(scope) {
    if (!scope) return null;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const { data, parentElement } = walker.currentNode;
      if (PROJECTS_HEADER_RE.test(data.trim()) && parentElement && visible(parentElement)) {
        return parentElement;
      }
    }
    return null;
  }

  const SHOW_MORE_PROJECTS_RE = /^(?:показать (?:все|больше)|ещё|загрузить ещё|see all|show more|load more|more|查看更多|展开)$/i;
  const IGNORE_PROJECT_LABEL_RE = /^(?:ещё|показать (?:все|больше|меньше)|загрузить ещё|скрыть|свернуть|more|see all|show (?:more|less)|load more|collapse|展开|收起|查看更多|\d+)$/i;

  function fireClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
    el.click();
  }

  function resolveClickableTarget(el, boundary) {
    if (!el) return null;
    const direct = el.closest('a[href],button,[role="button"],[role="treeitem"],[role="listitem"],li');
    if (direct && (!boundary || boundary.contains(direct)) && visible(direct) && isEnabledButton(direct)) {
      return direct;
    }
    let best = el;
    for (let cur = el.parentElement; cur && cur !== boundary && cur !== document.body; cur = cur.parentElement) {
      if (getComputedStyle(cur).cursor === 'pointer' && cur.getBoundingClientRect().height <= 72) {
        best = cur;
      } else {
        break;
      }
    }
    return best;
  }

  function expandProjectsSectionIfNeeded() {
    const scope = getSidebarRoot() || document.body;
    const header = findProjectsHeader(scope);
    if (!header) return false;
    let clicked = false;
    const toggle = header.closest('button,[role="button"],[aria-expanded]');
    if (toggle && toggle.getAttribute('aria-expanded') === 'false' && isEnabledButton(toggle)) {
      toggle.click();
      clicked = true;
    }
    // Also click "Показать больше" / "Show more" inside projects section so all projects are visible
    let section = header.parentElement;
    for (let d = 0; section && section !== document.body && d < 5; d++) {
      const moreBtn = [...section.querySelectorAll('button,[role="button"],a,div,span')].find(el =>
        visible(el) &&
        el !== header &&
        Boolean(header.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        SHOW_MORE_PROJECTS_RE.test((el.textContent || '').trim())
      );
      if (moreBtn) {
        const clickable = moreBtn.closest('button,[role="button"],a') || moreBtn;
        if (isEnabledButton(clickable)) {
          clickable.click();
          clicked = true;
        }
        break;
      }
      section = section.parentElement;
    }
    return clicked;
  }

  // Scan ALL existing projects in Qwen UI (works even if sidebar isn't <aside>/<nav>)
  function readProjectsList() {
    const sidebar = getSidebarRoot();
    const searchScope = sidebar || document.body;
    const projects = [];
    const seenNames = new Set();

    function addProject(name, element) {
      const clean = (name || '').split('\n')[0].trim();
      if (!clean || clean.length > 80) return;
      if (PROJECTS_HEADER_RE.test(clean) || NEW_PROJECT_RE.test(clean) || DATE_OR_SECTION_RE.test(clean)) return;
      if (IGNORE_PROJECT_LABEL_RE.test(clean)) return;
      if (seenNames.has(clean)) return;
      seenNames.add(clean);
      const clickable = resolveClickableTarget(element, searchScope);
      const link = clickable?.matches('a[href]') ? clickable : clickable?.querySelector?.('a[href]');
      const href = link ? new URL(link.href, location.origin).href : null;
      projects.push({ name: clean, element: clickable || element, href });
    }

    // Strategy 1: Direct links to /project(s)/ or /folder/ or /p/
    for (const a of searchScope.querySelectorAll('a[href]')) {
      if (!visible(a)) continue;
      if (!sidebar && a.closest('.project-layout, main')) continue;
      let u;
      try { u = new URL(a.href, location.origin); } catch { continue; }
      if (u.origin === location.origin && /^\/(?:project|projects|folder|folders|p)\//i.test(u.pathname)) {
        addProject(a.innerText || a.getAttribute('title') || a.textContent, a);
      }
    }

    // Strategy 2: Elements with project/folder class names in left rail
    for (const el of searchScope.querySelectorAll('[class*="project-item"],[class*="folder-item"],[class*="project_item"],[class*="sidebar-project"]')) {
      if (!visible(el)) continue;
      if (!sidebar && el.closest('.project-layout, main')) continue;
      addProject(el.innerText || el.textContent, el);
    }

    // Strategy 3: Clickable items following "Проекты / Projects" header
    const header = findProjectsHeader(searchScope);
    if (header) {
      let section = header.parentElement;
      for (let d = 0; section && section !== document.body && d < 5; d++) {
        const items = [...section.querySelectorAll('a[href],button,[role="button"],[role="treeitem"],li,div')]
          .filter(el => {
            if (!visible(el) || el === header || el.contains(header) || header.contains(el)) return false;
            if (!(header.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
            if (el.matches('a[href*="/c/"],a[href*="/chat/"]')) return false;
            if (el.localName === 'div' && getComputedStyle(el).cursor !== 'pointer') return false;
            return true;
          });

        const leaves = items.filter(el => !items.some(other => other !== el && el.contains(other)));
        const found = [];
        for (const el of leaves) {
          const text = (el.innerText || el.textContent || '').split('\n')[0].trim();
          if (!text) continue;
          if (DATE_OR_SECTION_RE.test(text)) break;
          if (NEW_PROJECT_RE.test(text)) continue;
          if (text.length <= 1 && /^[\d+…]$/.test(text)) continue;
          found.push({ name: text, element: el });
        }
        if (found.length) {
          for (const item of found) addProject(item.name, item.element);
          break;
        }
        section = section.parentElement;
      }
    }

    // Strategy 4: Currently opened project header (.pcht__name) so active project is always visible in dropdown
    const activeHeader = document.querySelector('.pcht__name, [class*="project-title"], [class*="project-header"] h1, [class*="project-header"] h2');
    if (activeHeader && visible(activeHeader)) {
      addProject(activeHeader.textContent, activeHeader);
    }

    return projects;
  }

  function findProjectControls(projectName) {
    const target = projectName.trim();
    if (!target) return [];
    const listed = readProjectsList()
      .filter(p => p.name === target && !p.element.matches('.pcht__name'))
      .map(p => p.element);
    if (listed.length) return listed;

    const scope = getSidebarRoot() || document.body;
    const matches = new Set();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.data.trim() !== target) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('.project-layout, .pct__header')) continue;
      let ctrl = parent.closest('a[href],button,[role="button"],[role="treeitem"]');
      if (!ctrl || !buttonLabel(ctrl).startsWith(target)) {
        ctrl = null;
        for (let el = parent; el && el !== document.body; el = el.parentElement) {
          if (el.textContent.trim() !== target) break;
          if (getComputedStyle(el).cursor === 'pointer') {
            ctrl = el;
            break;
          }
        }
      }
      if (ctrl && visible(ctrl) && isEnabledButton(ctrl) && (ctrl.matches('a[href]') || buttonLabel(ctrl) === target)) {
        matches.add(ctrl);
      }
    }
    const list = [...matches];
    return list.filter(ctrl => !list.some(other => other !== ctrl && other.contains(ctrl)));
  }

  function findNewProjectButton() {
    const named = findButtons(NEW_PROJECT_RE);
    if (named.length) return named[0];

    const scope = getSidebarRoot() || document.body;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const { data, parentElement } = walker.currentNode;
      if (NEW_PROJECT_RE.test(data.trim()) && parentElement && visible(parentElement)) {
        const action = parentElement.closest('a,button,[role="button"],[class*="cursor-pointer"]') || parentElement;
        if (visible(action)) return action;
      }
    }

    const header = findProjectsHeader(scope);
    if (header) {
      const row = header.parentElement;
      if (row) {
        const iconBtns = [...row.querySelectorAll('button,[role="button"]')].filter(el =>
          visible(el) && isEnabledButton(el) && !el.contains(header) && !header.contains(el)
        );
        if (iconBtns.length === 1) return iconBtns[0];
        const addBtn = iconBtns.find(el => /add|new|create|плюс|добав|созд|нов/i.test(buttonLabel(el)));
        if (addBtn) return addBtn;
      }
    }
    return null;
  }

  function getProjectLayout(projectName) {
    const target = projectName.trim();

    // Direct match for Qwen's .project-layout / .pcht__name DOM (even if composer is scrolled/loading)
    const pchtName = document.querySelector('.pcht__name');
    if (pchtName && visible(pchtName) && pchtName.textContent.trim() === target) {
      const empty = Boolean(document.querySelector('.pct--empty'));
      const chatsLabel = findChatsSectionLabel(document.querySelector('.project-layout') || document.body);
      return { chatsLabel, emptyFound: empty };
    }

    const editor = getComposer();
    if (!editor) return null;

    let titleFound = false;
    let chatsLabel = null;
    let emptyFound = false;
    const mainScope = getMainScope();
    const walker = document.createTreeWalker(mainScope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const { data, parentElement } = walker.currentNode;
      const label = data.trim();
      if (!label || !parentElement || parentElement.closest(SIDEBAR_SELECTOR + ',[role="menu"]')) continue;
      const isEmpty = EMPTY_PROJECT_RE.test(label);
      const isChats = CHATS_SECTION_RE.test(label);
      const isTitle = label === target;
      if (!isEmpty && !isChats && !isTitle) continue;
      if (!visible(parentElement)) continue;

      if (isEmpty) emptyFound = true;
      else if (isChats) chatsLabel = parentElement;
      else if (
        !parentElement.closest('header,[class*="chat-header"]') &&
        (parentElement.closest('h1,h2,[role="heading"],.pcht__name') || parseFloat(getComputedStyle(parentElement).fontSize) >= 18)
      ) {
        titleFound = true;
      }
    }
    return titleFound ? { chatsLabel, emptyFound } : null;
  }

  function findChatsSectionLabel(scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const { data, parentElement } = walker.currentNode;
      if (CHATS_SECTION_RE.test(data.trim()) && parentElement && visible(parentElement) && !parentElement.closest(SIDEBAR_SELECTOR)) {
        return parentElement;
      }
    }
    return null;
  }

  function isInProject(projectName) {
    if (getProjectLayout(projectName)) return true;
    const target = projectName.trim();
    const headings = document.querySelectorAll('.pcht__name, main h1, main h2, header, [class*="chat-header"], [class*="project-header"]');
    for (const h of headings) {
      if (!visible(h) || h.closest(SIDEBAR_SELECTOR)) continue;
      if (h.textContent.includes(target)) return true;
    }
    return [...document.querySelectorAll('a[href]')].some(a =>
      a.href === location.href && visible(a) && a.textContent.trim() === target
    );
  }

  function isProjectLanding(projectName) {
    const layout = getProjectLayout(projectName);
    return Boolean(layout && (layout.chatsLabel || layout.emptyFound || !hasVisibleMessages()));
  }

  function hasVisibleMessages() {
    if (document.querySelector('.pct--empty')) return false;
    const nodes = document.querySelectorAll(USER_SELECTOR + ',' + ASSISTANT_SELECTOR);
    for (const n of nodes) {
      if (visible(n) && !n.closest(IGNORED_ANCESTORS) && (n.textContent || '').trim()) return true;
    }
    return false;
  }

  async function waitForPageReady(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getComposer() || getSidebarRoot()) return true;
      if (isLoginVisible()) return false;
      await wait(300);
    }
    return Boolean(getComposer() || getSidebarRoot());
  }

  async function ensureProject(projectName, { allowCreate = true, openIt = true, onStatus = () => {} } = {}) {
    await waitForPageReady(12_000);
    if (!getSidebarRoot()) {
      if (openSidebarIfCollapsed()) await wait(450);
    }
    if (expandProjectsSectionIfNeeded()) await wait(400);

    if (openIt && (isProjectLanding(projectName) || isInProject(projectName))) {
      return { ready: true, landing: isProjectLanding(projectName), created: false };
    }

    const startTime = Date.now();
    const deadline = startTime + 25_000;
    let clickCount = 0;
    let lastClickAt = 0;
    let targetHref = null;
    let createOpened = false;
    let createSubmitted = false;
    let created = false;

    while (Date.now() < deadline) {
      if (openIt && (isProjectLanding(projectName) || isInProject(projectName) || (targetHref && location.href === targetHref))) {
        return { ready: true, landing: isProjectLanding(projectName) || Boolean(document.querySelector('.project-layout')), created };
      }

      if (isLoginVisible() && !getComposer() && Date.now() - startTime > 4000) {
        return { ready: false, needsLogin: true, error: 'Войдите в аккаунт Qwen («Показать Qwen» → Войти).' };
      }

      const listedMatch = readProjectsList().find(p => p.name === projectName && !p.element.matches('.pcht__name'));
      const controls = listedMatch ? [listedMatch.element] : findProjectControls(projectName);
      if (controls.length >= 1) {
        if (!openIt) return { ready: true, landing: false, created };
        if (listedMatch?.href) targetHref = listedMatch.href;
        if (clickCount === 0 || (clickCount < 3 && Date.now() - lastClickAt >= 2500)) {
          onStatus(`Открываю проект «${projectName}»…`);
          const el = clickCount === 0 ? controls[0] : (controls[0].parentElement || controls[0]);
          fireClick(el);
          clickCount++;
          lastClickAt = Date.now();
          await wait(650);
          continue;
        }
      }

      if (allowCreate && clickCount === 0 && controls.length === 0 && Date.now() - startTime >= 1500 && (getComposer() || getSidebarRoot())) {
        if (!createOpened) {
          expandProjectsSectionIfNeeded();
          const newBtn = findNewProjectButton();
          if (newBtn) {
            onStatus(`Проект «${projectName}» не найден — создаю автоматически…`);
            createOpened = true;
            newBtn.click();
            await wait(500);
            continue;
          }
        } else if (!createSubmitted) {
          const dialog = [...document.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"],[class*="modal"]')].find(el =>
            visible(el) && el.querySelector('input')
          );
          if (dialog) {
            const input = [...dialog.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')].find(visible);
            const createBtn = findButtons(CREATE_BTN_RE, dialog)[0]
              || [...dialog.querySelectorAll('button[type="submit"]')].find(visible);
            if (input && createBtn) {
              if (input.value !== projectName) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(input, projectName);
                else input.value = projectName;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(250);
                continue;
              }
              if (isEnabledButton(createBtn)) {
                createSubmitted = true;
                created = true;
                onStatus(`Сохраняю новый проект «${projectName}»…`);
                createBtn.click();
                await wait(900);
                continue;
              }
            }
          }
        }
      }

      await wait(400);
    }

    return {
      ready: false,
      error: `Не удалось автоматически открыть или создать проект «${projectName}». Нажмите «Показать Qwen», проверьте список проектов и повторите.`,
    };
  }

  async function navigateToProjectLanding(projectName) {
    if (isProjectLanding(projectName)) return true;
    if (!getSidebarRoot()) {
      if (openSidebarIfCollapsed()) await wait(350);
    }
    expandProjectsSectionIfNeeded();
    const controls = findProjectControls(projectName);
    if (controls.length >= 1) {
      fireClick(controls[0]);
      for (let i = 0; i < 20; i++) {
        await wait(250);
        if (isProjectLanding(projectName)) return true;
      }
    }
    return isProjectLanding(projectName);
  }

  function readProjectChatRows(projectName) {
    const layout = getProjectLayout(projectName);
    const projectRoot = document.querySelector('.project-layout, .pct');
    if (!layout && !projectRoot) return null;

    const rows = [];
    const seenEl = new Set();
    const composer = getComposer();

    function collectFromContainer(container, afterNode = null) {
      const candidates = [...container.querySelectorAll('a[href],[role="link"],[role="button"],button,[class*="cursor-pointer"],[class*="chat"],[class*="item"],li,div')]
        .filter(el =>
          visible(el) &&
          !el.closest(SIDEBAR_SELECTOR) &&
          !el.closest('.pct__header, .pcht, header') &&
          !(composer && (el.contains(composer) || composer.contains(el))) &&
          (!afterNode || (!el.contains(afterNode) && Boolean(afterNode.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) &&
          (el.localName !== 'div' || getComputedStyle(el).cursor === 'pointer')
        );

      for (const el of candidates) {
        if (rows.some(item => item.element.contains(el))) continue;
        const linkEl = el.matches('a[href]') ? el : el.querySelector('a[href]');
        const href = linkEl ? new URL(linkEl.href, location.origin).href : null;
        const chatKey = href ? extractChatKeyFromUrl(href) : null;
        const lines = (el.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
        const title = lines[0];
        const hasDate = lines.slice(1).some(l =>
          /^(?:сегодня|вчера|today|yesterday|今天|昨天|\d{1,2}[./-]\d{1,2}|\d+\s*(?:мин|ч|д|сек|min|hr|h|d|ago))/i.test(l)
        );
        if (!title || title.length > 160 || IGNORE_PROJECT_LABEL_RE.test(title) || CHATS_SECTION_RE.test(title)) continue;
        if (!chatKey && (!hasDate || lines.length > 4)) continue;
        if (seenEl.has(el)) continue;
        seenEl.add(el);
        rows.push({
          key: chatKey || makeRowFallbackKey(projectName, title),
          title,
          url: chatKey ? href : null,
          element: el,
          index: rows.length,
        });
      }
    }

    if (layout?.chatsLabel) {
      for (let section = layout.chatsLabel, depth = 0; section && section !== document.body && depth < 6; section = section.parentElement, depth++) {
        if (composer && section.contains(composer)) break;
        collectFromContainer(section, layout.chatsLabel);
        if (rows.length) break;
      }
    }

    if (!rows.length && projectRoot) {
      collectFromContainer(projectRoot, null);
    }

    if (!rows.length) {
      const main = getMainScope();
      for (const a of main.querySelectorAll('a[href*="/c/"],a[href*="/chat/"]')) {
        if (!visible(a) || a.closest(SIDEBAR_SELECTOR)) continue;
        const href = new URL(a.href, location.origin).href;
        const key = extractChatKeyFromUrl(href);
        const title = (a.innerText || '').split('\n')[0]?.trim();
        if (key && title) {
          rows.push({ key, title, url: href, element: a, index: rows.length });
        }
      }
    }

    return rows;
  }

  // Auto-load remaining chats in a large project (scrolls / clicks "Load more" up to a short cap)
  async function loadAllProjectChatRows(projectName) {
    const projectRoot = document.querySelector('.project-layout, .pct') || getMainScope();
    let prevCount = -1;
    for (let pass = 0; pass < 8; pass++) {
      // Click any "Show more / Load more" button inside the project chat list
      const moreBtn = [...projectRoot.querySelectorAll('button,[role="button"],a,div')].find(el =>
        visible(el) &&
        !el.closest(SIDEBAR_SELECTOR) &&
        SHOW_MORE_PROJECTS_RE.test((el.textContent || '').trim())
      );
      if (moreBtn) {
        fireClick(moreBtn);
        await wait(450);
      }

      // Scroll the project chat list container to trigger lazy loading
      const scrollable = [...projectRoot.querySelectorAll('*')].find(el =>
        visible(el) && el.scrollHeight > el.clientHeight + 40 && !el.closest('textarea,[contenteditable]')
      ) || projectRoot;
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight + 20) {
        scrollable.scrollTop = scrollable.scrollHeight;
        await wait(350);
      }

      const rows = readProjectChatRows(projectName) || [];
      if (rows.length === prevCount && !moreBtn) {
        if (scrollable) scrollable.scrollTop = 0;
        return rows;
      }
      prevCount = rows.length;
    }
    return readProjectChatRows(projectName) || [];
  }

  async function openChat(chatItem, { projectName }) {
    const currentKey = extractChatKeyFromUrl();
    if (chatItem.url && currentKey && chatItem.key === currentKey && hasVisibleMessages()) {
      return { key: currentKey, url: location.href };
    }

    if (!isProjectLanding(projectName)) {
      await navigateToProjectLanding(projectName);
    }
    const freshRows = readProjectChatRows(projectName) || [];
    const match = freshRows.find(r => (chatItem.url && r.url === chatItem.url) || r.key === chatItem.key || r.title === chatItem.title);
    if (match?.element) {
      const target = [...match.element.querySelectorAll('a[href],button,[role="link"],[role="button"],span')]
        .find(el => visible(el) && el.textContent.trim() === match.title) || match.element;
      target.click();
    } else if (chatItem.url) {
      const a = document.querySelector(`a[href="${new URL(chatItem.url).pathname}"]`);
      if (a) a.click();
      else throw new Error('Не удалось переключить чат без перезагрузки страницы. Откройте нужный чат через «Показать Qwen ↗».');
    } else {
      throw new Error('Диалог не найден в списке проекта. Нажмите «Обновить».');
    }

    for (let i = 0; i < 24; i++) {
      await wait(250);
      const urlKey = extractChatKeyFromUrl();
      if (urlKey && hasVisibleMessages()) {
        return { key: urlKey, url: location.href };
      }
      if (!isProjectLanding(projectName) && hasVisibleMessages()) {
        return { key: urlKey || chatItem.key, url: location.href };
      }
    }
    return { key: extractChatKeyFromUrl() || chatItem.key, url: location.href };
  }

  function scanProtocolReplies(expectedTurn) {
    const nodes = new Set(document.querySelectorAll('pre, code'));
    const mainScope = getMainScope();
    const walker = document.createTreeWalker(mainScope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const txt = walker.currentNode.data;
      if (!txt.includes('OJ_FILES_REPLY') || OjProtocol.isOutgoingBridgePacket(txt)) continue;
      let el = walker.currentNode.parentElement;
      if (!el || el.closest(USER_SELECTOR + ',textarea,[contenteditable],' + THINKING_SELECTOR)) continue;
      for (let d = 0; el && d < 8; d++, el = el.parentElement) {
        if (el.matches(USER_SELECTOR) || el.querySelector('textarea,[contenteditable]')) break;
        nodes.add(el);
      }
    }

    const matches = [];
    let foundEnvelope = false;
    let otherTurn = false;
    let lastParseError = '';

    for (const node of nodes) {
      if (!visible(node)) continue;
      if (node.closest(USER_SELECTOR + ',textarea,[contenteditable],' + THINKING_SELECTOR)) continue;
      const raw = node.textContent;
      if (!raw?.includes('OJ_FILES_END') || OjProtocol.isOutgoingBridgePacket(raw) || raw.length > 400_000) continue;
      const childRows = node.childElementCount >= 3
        ? [...node.children].map(c => c.textContent).join('\n')
        : '';
      for (const text of new Set([raw, node.innerText, childRows].filter(Boolean))) {
        if (!text.includes('OJ_FILES_REPLY') || !text.includes('OJ_FILES_END') || OjProtocol.isOutgoingBridgePacket(text)) continue;
        const res = OjProtocol.parseDetailed(text, expectedTurn);
        if (res.foundEnvelope) foundEnvelope = true;
        if (res.ok) {
          matches.push({ node, reply: res.reply });
        } else if (res.reason === 'other-turn') {
          otherTurn = true;
        } else if (res.reason) {
          lastParseError = res.reason;
        }
      }
    }

    return { matches, foundEnvelope, otherTurn, lastParseError };
  }

  function uniqueCandidates(matches) {
    return new Map(matches.map(({ reply }) => [JSON.stringify(reply), reply]));
  }

  function selectPreferredCard(preferButtons, matches) {
    if (preferButtons.length !== 2 || !preferButtons.every(isEnabledButton)) return null;
    for (const btn of preferButtons) {
      for (let card = btn.parentElement; card; card = card.parentElement) {
        if (preferButtons.some(other => other !== btn && card.contains(other))) break;
        const replies = uniqueCandidates(matches.filter(({ node }) => card.contains(node)));
        if (replies.size === 1) return { button: btn, key: replies.keys().next().value };
        if (replies.size > 1) break;
      }
    }
    return null;
  }

  // Extract visible assistant answers with both selector matching and structural fallback
  function readAssistantAnswers() {
    const scope = getMainScope();
    const matched = [...scope.querySelectorAll(ASSISTANT_SELECTOR)].filter(node =>
      visible(node) &&
      !node.closest(USER_SELECTOR + ',' + IGNORED_ANCESTORS) &&
      !node.querySelector('textarea,[contenteditable]')
    );
    const leaves = matched.filter(node => !matched.some(other => other !== node && node.contains(other)));
    const texts = leaves
      .map(node => (node.innerText || '').trim())
      .filter(text => text && !OjProtocol.isOutgoingBridgePacket(text));
    if (texts.length) return texts;

    // Structural fallback: find rendered paragraphs/code containers in main chat area (outside user bubbles, thinking, composer)
    const composer = getComposer();
    const blocks = [...scope.querySelectorAll('article, [class*="message"], [class*="chat-item"], [class*="response"], [class*="markdown"]')]
      .filter(node => {
        if (!visible(node)) return false;
        if (composer && (node.contains(composer) || composer.contains(node))) return false;
        if (node.closest(USER_SELECTOR + ',' + IGNORED_ANCESTORS)) return false;
        if (node.querySelector('textarea,[contenteditable]')) return false;
        return Boolean(node.querySelector('p, pre, ul, ol'));
      });
    const fallbackLeaves = blocks.filter(node => !blocks.some(other => other !== node && node.contains(other)));
    return fallbackLeaves
      .map(node => (node.innerText || '').trim())
      .filter(text => text && !OjProtocol.isOutgoingBridgePacket(text) && !/^(?:завершено размышление|thought for|thinking)/i.test(text));
  }

  function readTranscript() {
    const entries = [];
    const seenNodes = new Set();

    function push(node, role, text, { unformatted = false, turn = null } = {}) {
      if (!text || seenNodes.has(node)) return;
      seenNodes.add(node);
      entries.push({ node, role, text: text.slice(0, 32_000), unformatted, turn });
    }

    for (const { node, reply } of scanProtocolReplies(undefined).matches) {
      if (reply.type === 'final') {
        push(node, 'qwen', reply.summary, { unformatted: false, turn: reply.turn });
      }
    }

    const mainScope = getMainScope();
    const walker = document.createTreeWalker(mainScope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const { data, parentElement } = walker.currentNode;
      if (!data.includes('OJ_FILES_BRIDGE TASK') || !parentElement || parentElement.closest(IGNORED_ANCESTORS)) continue;
      for (let node = parentElement, d = 0; node && d < 6; node = node.parentElement, d++) {
        if (!visible(node) || node.querySelector('textarea,[contenteditable]')) break;
        const decoded = OjProtocol.decodeTaskPacket(node.textContent);
        if (decoded) {
          push(node, 'user', decoded.task, { turn: decoded.turn });
          break;
        }
      }
    }

    const msgNodes = mainScope.querySelectorAll(USER_SELECTOR + ',' + ASSISTANT_SELECTOR);
    for (const node of msgNodes) {
      if (!visible(node) || node.closest(IGNORED_ANCESTORS)) continue;
      if (node.querySelector(USER_SELECTOR + ',' + ASSISTANT_SELECTOR)) continue;
      if (entries.some(e => node.contains(e.node) || e.node.contains(node))) continue;
      const text = (node.innerText || '').trim();
      if (!text || /OJ_FILES_(?:BRIDGE|REPLY|END)/.test(text)) continue;
      const isUser = node.matches(USER_SELECTOR);
      push(node, isUser ? 'user' : 'qwen', text, { unformatted: false });
    }

    entries.sort((a, b) => {
      if (a.node === b.node) return 0;
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const deduped = entries.filter((entry, idx) =>
      !entries.slice(0, idx).some(prev =>
        prev.role === entry.role &&
        prev.text === entry.text &&
        (prev.node.contains(entry.node) || entry.node.contains(prev.node))
      )
    );

    return deduped.slice(-120).map(({ role, text, unformatted, turn }) => ({
      role,
      text,
      unformatted,
      turn: turn || null,
    }));
  }

  function countProtocolMessagesInChat() {
    const mainScope = getMainScope();
    const raw = mainScope.textContent || '';
    const matches = raw.match(/OJ_FILES_BRIDGE (?:TASK|RESULTS)/g);
    return matches ? matches.length : 0;
  }

  // Estimate context window usage (tokens) of the ENTIRE underlying Qwen chat (including all protocol payloads)
  function estimateContextWindow() {
    const limit = OjProtocol.CONTEXT_LIMIT_TOKENS;
    const scope = getMainScope();
    if (!scope || document.querySelector('.pct--empty')) {
      return { used: 0, limit, remaining: limit, percent: 0 };
    }
    const composer = getComposer();
    let totalCharsText = '';
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(SIDEBAR_SELECTOR + ',script,style,textarea,[contenteditable],header')) continue;
      if (composer && (parent.contains(composer) || composer.contains(parent))) continue;
      const t = node.data.trim();
      if (t) totalCharsText += t + ' ';
    }
    const used = OjProtocol.estimateTokens(totalCharsText);
    const remaining = Math.max(0, limit - used);
    const percent = Math.min(100, (used / limit) * 100);
    return { used, limit, remaining, percent };
  }

  function makeRowFallbackKey(projectName, title) {
    const raw = (projectName || 'OJ-QWEN') + '|' + (title || '').trim().toLowerCase();
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'row:' + (hash >>> 0).toString(36);
  }

  // Safe DOM + API route diagnostics (only tags/classes/URL paths and JSON key shapes, zero message text or tokens)
  async function collectDomDiagnostics() {
    const maskId = s => String(s || '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>').replace(/\/[0-9a-f]{16,}/gi, '/<id>');
    const apis = [...new Set(
      performance.getEntriesByType('resource')
        .filter(r => typeof r.name === 'string' && r.name.includes('/api/'))
        .map(r => {
          try {
            const u = new URL(r.name);
            return maskId(u.pathname) + (u.search ? '?' + [...u.searchParams.keys()].join('&') : '');
          } catch {
            return '';
          }
        })
        .filter(Boolean)
    )].slice(-40);

    const projectId = extractProjectIdFromUrl();
    const chatKey = extractChatKeyFromUrl();
    const chatId = extractChatIdFromKey(chatKey);
    const apiProbe = typeof OjQwenApi !== 'undefined'
      ? await OjQwenApi.probeSchema(projectId, chatId).catch(e => ({ error: e.message }))
      : null;

    const trail = el => {
      const out = [];
      for (let n = el, i = 0; n && i < 8; n = n.parentElement, i++) {
        const cls = [...n.classList].filter(c => /^[a-z0-9_-]{1,48}$/i.test(c)).slice(0, 4);
        const role = n.getAttribute('role');
        out.push(n.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '') + (role ? `[role=${role}]` : ''));
      }
      return out.join(' < ');
    };

    const code = document.querySelector('pre');
    return {
      url: maskId(location.pathname),
      apis,
      apiProbe,
      codeBlockTrail: code ? trail(code) : null,
      composerFound: Boolean(getComposer()),
      answerCount: readAssistantAnswers().length,
      contextTokens: estimateContextWindow(),
    };
  }

  function isOutgoingVisible(signature) {
    if (!signature) return false;
    const prefix = signature.slice(0, 16);
    const mainScope = getMainScope();
    const walker = document.createTreeWalker(mainScope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const { data, parentElement } = walker.currentNode;
      if (!parentElement || parentElement.closest('textarea,[contenteditable],script,style')) continue;
      if (!data.replace(/\s+/g, '').includes(prefix)) continue;
      if (!visible(parentElement)) continue;
      for (let node = parentElement, d = 0; node && d < 5; node = node.parentElement, d++) {
        if (node.querySelector('textarea,[contenteditable]')) break;
        if (node.textContent.replace(/\s+/g, '').includes(signature)) return true;
      }
    }
    return false;
  }

  async function sendMessage(text, { isCancelled = () => false } = {}) {
    const deadline = Date.now() + 6000;
    let sent = false;

    while (Date.now() < deadline) {
      if (isCancelled()) throw new Error('Остановлено пользователем.');
      const { generating, preferButtons } = getGenerationStatus();
      if (!generating && !preferButtons.length) {
        const editor = getComposer();
        if (editor) {
          const currentDraft = getDraftText(editor);
          if (currentDraft !== text.trim()) {
            writeDraft(editor, text);
          }
          await wait(80);
          const btn = getSendButton(editor);
          if (btn && isEnabledButton(btn)) {
            btn.click();
            sent = true;
            break;
          }
        }
      }
      await wait(180);
    }

    if (!sent) {
      throw new Error('Не удалось отправить сообщение в поле Qwen. Проверьте вкладку через «Показать Qwen».');
    }

    const sig = text.trim().slice(0, 80).replace(/\s+/g, '');
    for (let i = 0; i < 12; i++) {
      await wait(200);
      if (isCancelled()) throw new Error('Остановлено пользователем.');
      if (isOutgoingVisible(sig) || getGenerationStatus().generating) return true;
    }
    return true;
  }

  return {
    extractChatKeyFromUrl,
    extractProjectIdFromUrl,
    extractChatIdFromKey,
    spaNavigate,
    getComposer,
    isLoginVisible,
    getGenerationStatus,
    stopGeneration,
    readProjectsList,
    isInProject,
    isProjectLanding,
    ensureProject,
    navigateToProjectLanding,
    readProjectChatRows,
    loadAllProjectChatRows,
    openChat,
    scanProtocolReplies,
    uniqueCandidates,
    selectPreferredCard,
    readAssistantAnswers,
    readTranscript,
    countProtocolMessagesInChat,
    estimateContextWindow,
    collectDomDiagnostics,
    isOutgoingVisible,
    sendMessage,
    wait,
  };
})();
