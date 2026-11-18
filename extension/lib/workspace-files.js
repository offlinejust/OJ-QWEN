function createWorkspaceFiles({ store, cryptoImpl = globalThis.crypto } = {}) {
  const MAX_FILE_BYTES = 256 * 1024;
  const MAX_REPLY_CHARS = 32_000;
  const MAX_SCAN_ENTRIES = 6000;
  const MAX_VERSION_CACHE = 40;
  const MAX_BATCH_OPS = 8;
  const MAX_DIR_BACKUP_FILES = 50;
  const MAX_DIR_BACKUP_BYTES = 2 * 1024 * 1024;
  const encoder = new TextEncoder();

  const ALLOWED_EXTENSIONS = /\.(?:md|mdx|txt|json|jsonc|ya?ml|csv|tsv|ts|tsx|mts|cts|js|jsx|mjs|cjs|css|scss|sass|less|html?|htm|py|pyi|toml|xml|sql|ini|cfg|conf|svg|java|kt|kts|cs|go|rs|c|cc|cpp|cxx|h|hh|hpp|sh|bash|zsh|ps1|psm1|bat|cmd|vue|svelte|php|rb|swift|lua|r|zig|nim|glsl|wgsl|hlsl|gd|tscn|tres|graphql|gql|prisma|rst|tex|log|properties|gradle|cmake)$/i;
  const ALLOWED_BASENAMES = /^(?:Makefile|Dockerfile|Containerfile|Jenkinsfile|Vagrantfile|Procfile|LICENSE|README|CHANGELOG|CONTRIBUTING|AUTHORS|NOTICE|CMakeLists\.txt)$/i;

  const BLOCKED_DIRS = /^(?:node_modules|__pycache__|\.git|\.svn|\.hg|\.venv|venv|target|dist-cache|\.next|\.nuxt)$/i;
  const BLOCKED_FILES = /^(?:\.env(?:\..+)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|id_ecdsa(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|.*\.(?:pem|key|p12|pfx|jks|keystore)|.*(?:^|[._-])(?:password|passwd|secret|secrets|credential|credentials|private[_-]?key|api[_-]?key)(?:[._-]|$).*)$/i;
  const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

  let queue = Promise.resolve();

  function validSegment(part, isLast = false) {
    if (!part || part === '.' || part === '..') return false;
    if (part.startsWith('.')) return false;
    if (/[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)) return false;
    if (WINDOWS_RESERVED.test(part)) return false;
    if (!isLast && BLOCKED_DIRS.test(part)) return false;
    if (isLast && (BLOCKED_DIRS.test(part) || BLOCKED_FILES.test(part))) return false;
    return true;
  }

  function isAllowedTextFile(fileName) {
    return ALLOWED_EXTENSIONS.test(fileName) || ALLOWED_BASENAMES.test(fileName);
  }

  function normalizeRelative(relative) {
    if (typeof relative !== 'string') return '';
    return relative.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  }

  function validateFilePath(relative) {
    const clean = normalizeRelative(relative);
    if (!clean || clean.length > 400) {
      throw new Error('Укажите относительный путь к текстовому файлу.');
    }
    const parts = clean.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (!validSegment(parts[i], i === parts.length - 1)) {
        throw new Error('Путь выходит за пределы папки или содержит запрещённое имя: ' + clean);
      }
    }
    const fileName = parts[parts.length - 1];
    if (!isAllowedTextFile(fileName)) {
      throw new Error('Неподдерживаемый тип файла: ' + fileName);
    }
    return { clean, parts, name: fileName };
  }

  function validateDirPath(relative) {
    const clean = normalizeRelative(relative || '');
    if (!clean) return { clean: '', parts: [] };
    if (clean.length > 400) throw new Error('Слишком длинный путь к папке.');
    const parts = clean.split('/');
    for (const part of parts) {
      if (!validSegment(part, false)) {
        throw new Error('Недопустимое имя папки: ' + clean);
      }
    }
    return { clean, parts };
  }

  async function resolveDir(root, parts, create = false) {
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, create ? { create: true } : undefined);
    }
    return dir;
  }

  async function sha256Hex(bytes) {
    const hash = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
    return [...hash].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function readFileHandle(handle) {
    const file = await handle.getFile();
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`Файл больше ${Math.round(MAX_FILE_BYTES / 1024)} КБ (${file.size} Б).`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Файл содержит нулевые байты (бинарный файл).');
    return { text, version: await sha256Hex(bytes), size: file.size, lastModified: file.lastModified };
  }

  function encodeText(text) {
    if (typeof text !== 'string' || text.includes('\0')) {
      throw new Error('Ожидался текст UTF-8 без нулевых байт.');
    }
    const bytes = encoder.encode(text);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`Размер текста превышает ${Math.round(MAX_FILE_BYTES / 1024)} КБ.`);
    }
    return bytes;
  }

  async function writeBytes(handle, bytes) {
    const stream = await handle.createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }

  function lineDiff(before, after) {
    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    let start = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (start < minLen && oldLines[start] === newLines[start]) start++;
    let tail = 0;
    while (
      tail < minLen - start &&
      oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
    ) {
      tail++;
    }
    return {
      startLine: start + 1,
      removed: oldLines.slice(start, oldLines.length - tail),
      added: newLines.slice(start, newLines.length - tail),
    };
  }

  async function loadVersionsMap(chatKey) {
    if (!store) return {};
    return (await store.getMeta('ver:' + chatKey)) || {};
  }

  async function rememberVersion(chatKey, filePath, snapshot) {
    if (!store) return;
    const map = await loadVersionsMap(chatKey);
    delete map[filePath];
    map[filePath] = { version: snapshot.version, text: snapshot.text, savedAt: Date.now() };
    const keys = Object.keys(map);
    while (keys.length > MAX_VERSION_CACHE) {
      delete map[keys.shift()];
    }
    await store.setMeta('ver:' + chatKey, map);
  }

  async function recordBackup(chatKey, entry) {
    if (!store) return null;
    const id = cryptoImpl.randomUUID();
    const record = { id, chatKey, createdAt: Date.now(), ...entry };
    await store.addBackup(record);
    return id;
  }

  // Fast directory walk with optional maxDepth & binaryFiles reporting
  async function walkTree(root, startDir = '', { needMeta = false, maxEntries = MAX_SCAN_ENTRIES, maxDepth = Infinity } = {}) {
    const { clean, parts } = validateDirPath(startDir);
    const startHandle = await resolveDir(root, parts, false);
    const files = [];
    const binaryFiles = [];
    const dirs = [];
    const meta = needMeta ? new Map() : null;
    const stack = [[startHandle, clean ? clean + '/' : '', 1]];
    let visited = 0;
    let truncated = false;

    while (stack.length) {
      const [dirHandle, prefix, depth] = stack.pop();
      for await (const handle of dirHandle.values()) {
        if (++visited > maxEntries) {
          truncated = true;
          break;
        }
        const isDir = handle.kind === 'directory';
        if (!validSegment(handle.name, !isDir)) continue;
        const relPath = prefix + handle.name;
        if (isDir) {
          dirs.push(relPath);
          if (depth < maxDepth) {
            stack.push([handle, relPath + '/', depth + 1]);
          }
        } else if (isAllowedTextFile(handle.name)) {
          if (needMeta) {
            try {
              const f = await handle.getFile();
              if (f.size <= MAX_FILE_BYTES) {
                files.push(relPath);
                meta.set(relPath, f.lastModified + ':' + f.size);
              }
            } catch {}
          } else {
            files.push(relPath);
          }
        } else {
          binaryFiles.push(relPath);
        }
      }
      if (truncated) break;
    }
    files.sort();
    binaryFiles.sort();
    dirs.sort();
    return { files, binaryFiles, dirs, meta, truncated };
  }

  async function opList(root, operation) {
    const offset = operation.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Неверный offset.');
    let maxDepth = Infinity;
    if (operation.depth !== undefined && operation.depth !== null) {
      const d = Number(operation.depth);
      if (!Number.isInteger(d) || d < 1 || d > 20) throw new Error('depth должен быть целым числом от 1 до 20.');
      maxDepth = d;
    }
    const pattern = typeof operation.pattern === 'string' && operation.pattern.trim()
      ? operation.pattern.trim().toLowerCase()
      : '';
    const { files, binaryFiles, dirs, truncated } = await walkTree(root, operation.dir || '', {
      needMeta: false,
      maxDepth,
    });
    const filteredFiles = pattern ? files.filter(p => p.toLowerCase().includes(pattern)) : files;
    const filteredBinary = pattern ? binaryFiles.filter(p => p.toLowerCase().includes(pattern)) : binaryFiles;
    const pageSize = 80;
    const page = filteredFiles.slice(offset, offset + pageSize);
    const out = {
      files: page,
      dirs: offset === 0 ? dirs.slice(0, 80) : [],
      total: filteredFiles.length,
      truncated,
      nextOffset: offset + pageSize < filteredFiles.length ? offset + pageSize : null,
    };
    if (offset === 0 && filteredBinary.length) {
      out.binaryFiles = filteredBinary.slice(0, 40);
      if (filteredBinary.length > 40) out.binaryFilesMore = filteredBinary.length - 40;
    }
    return out;
  }

  async function opSearch(root, operation) {
    const query = operation.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 300) {
      throw new Error('Укажите непустую строку поиска query (до 300 символов).');
    }
    const maxResults = Math.min(50, Math.max(1, Number(operation.maxResults) || 30));
    const caseSensitive = Boolean(operation.caseSensitive);
    let matcher;
    if (operation.regex) {
      try {
        matcher = new RegExp(query, caseSensitive ? '' : 'i');
      } catch (err) {
        throw new Error('Некорректное регулярное выражение: ' + err.message);
      }
    }
    const needle = caseSensitive ? query : query.toLowerCase();
    const { clean, parts } = validateDirPath(operation.dir || '');
    const startHandle = await resolveDir(root, parts, false);

    const matches = [];
    const stack = [[startHandle, clean ? clean + '/' : '']];
    let scannedFiles = 0;
    let truncated = false;

    while (stack.length && matches.length < maxResults) {
      const [dirHandle, prefix] = stack.pop();
      for await (const handle of dirHandle.values()) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        const isDir = handle.kind === 'directory';
        if (!validSegment(handle.name, !isDir)) continue;
        const relPath = prefix + handle.name;
        if (isDir) {
          stack.push([handle, relPath + '/']);
          continue;
        }
        if (!isAllowedTextFile(handle.name)) continue;
        if (++scannedFiles > 1200) {
          truncated = true;
          break;
        }
        try {
          const f = await handle.getFile();
          if (f.size > MAX_FILE_BYTES) continue;
          const bytes = new Uint8Array(await f.arrayBuffer());
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const hit = matcher
              ? matcher.test(line)
              : (caseSensitive ? line : line.toLowerCase()).includes(needle);
            if (hit) {
              matches.push({
                path: relPath,
                line: i + 1,
                text: line.replace(/\r$/, '').slice(0, 220),
              });
              if (matches.length >= maxResults) {
                truncated = true;
                break;
              }
            }
          }
        } catch {}
      }
    }
    return { query, matches, scannedFiles, truncated };
  }

  async function opRead(chatKey, root, operation, budget) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    const handle = await dir.getFileHandle(name);
    const current = await readFileHandle(handle);
    await rememberVersion(chatKey, clean, current);

    const maxChars = Math.min(12_000, Math.max(800, Math.floor(budget * 0.7)));

    if (operation.startLine !== undefined || operation.endLine !== undefined) {
      const lines = current.text.split('\n');
      const totalLines = lines.length;
      const rawStart = Number(operation.startLine);
      const start = Number.isFinite(rawStart) && rawStart >= 1
        ? Math.min(totalLines, Math.floor(rawStart))
        : 1;
      const rawEnd = operation.endLine === null || operation.endLine === undefined
        ? totalLines
        : Number(operation.endLine);
      const requestedEnd = Number.isFinite(rawEnd) && rawEnd >= 1
        ? Math.min(totalLines, Math.max(start, Math.floor(rawEnd)))
        : totalLines;

      const outLines = [];
      let outLen = 0;
      let actualEnd = start - 1;
      let truncated = false;
      for (let ln = start; ln <= requestedEnd; ln++) {
        const lineText = lines[ln - 1];
        const sepLen = outLines.length > 0 ? 1 : 0;
        if (outLines.length > 0 && outLen + sepLen + lineText.length > maxChars) {
          truncated = true;
          break;
        }
        if (outLines.length === 0 && lineText.length > maxChars) {
          outLines.push(lineText.slice(0, maxChars));
          outLen = maxChars;
          actualEnd = ln;
          truncated = true;
          break;
        }
        outLines.push(lineText);
        outLen += sepLen + lineText.length;
        actualEnd = ln;
        if (outLen >= maxChars && ln < requestedEnd) {
          truncated = true;
          break;
        }
      }
      return {
        path: clean,
        version: current.version,
        startLine: start,
        endLine: Math.max(start, actualEnd),
        totalLines,
        text: outLines.join('\n'),
        hasMore: truncated || actualEnd < totalLines,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    const offset = operation.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Неверный offset.');
    const slice = current.text.slice(offset, offset + maxChars);
    const totalLines = current.text.split('\n').length;
    return {
      path: clean,
      version: current.version,
      totalLines,
      text: slice,
      nextOffset: offset + slice.length < current.text.length ? offset + slice.length : null,
    };
  }

  async function opMkdir(chatKey, root, operation) {
    const { clean, parts } = validateDirPath(operation.path);
    if (!clean || !parts.length) throw new Error('Укажите относительный путь создаваемой папки.');
    let cur = root;
    const createdDirs = [];
    const prefix = [];
    for (const part of parts) {
      prefix.push(part);
      try {
        cur = await cur.getDirectoryHandle(part, { create: false });
      } catch (err) {
        if (err.name !== 'NotFoundError') throw err;
        cur = await cur.getDirectoryHandle(part, { create: true });
        createdDirs.push(prefix.join('/'));
      }
    }
    if (!createdDirs.length) {
      return { path: clean, created: false, existed: true };
    }
    const backupId = await recordBackup(chatKey, {
      op: 'mkdir',
      path: clean,
      createdDirs,
    });
    return { path: clean, created: true, backupId };
  }

  async function opCreate(chatKey, root, operation) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const bytes = encodeText(operation.text ?? '');
    const dir = await resolveDir(root, parts.slice(0, -1), true);
    try {
      await dir.getFileHandle(name);
      throw new Error('Файл уже существует. Для изменения используйте read и edit/write.');
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    const handle = await dir.getFileHandle(name, { create: true });
    try {
      await writeBytes(handle, bytes);
    } catch (err) {
      try { await dir.removeEntry(name); } catch {}
      throw err;
    }
    const verified = await readFileHandle(handle);
    if (verified.version !== await sha256Hex(bytes)) {
      throw new Error('Содержимое файла изменилось во время записи.');
    }
    await rememberVersion(chatKey, clean, verified);
    const backupId = await recordBackup(chatKey, {
      op: 'create',
      path: clean,
      afterVersion: verified.version,
      diff: { startLine: 1, removed: [], added: verified.text.split('\n').slice(0, 40) },
    });
    return { path: clean, version: verified.version, created: true, backupId };
  }

  // Supports both single {find, replace} AND atomic multi-edit {edits: [{find, replace}, ...]}
  async function opEdit(chatKey, root, operation) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    const handle = await dir.getFileHandle(name);
    const current = await readFileHandle(handle);
    if (operation.version !== current.version) {
      throw new Error('Файл изменился с момента чтения. Прочитайте файл снова.');
    }

    let editsList;
    if (Array.isArray(operation.edits)) {
      if (operation.edits.length < 1 || operation.edits.length > 20) {
        throw new Error('Массив edits должен содержать от 1 до 20 правок.');
      }
      editsList = operation.edits;
    } else {
      editsList = [{ find: operation.find, replace: operation.replace }];
    }

    const fileHasCrLf = current.text.includes('\r\n');

    // Apply all edits atomically in memory first; abort without touching disk if any fails
    let next = current.text;
    for (let i = 0; i < editsList.length; i++) {
      const item = editsList[i];
      let find = item?.find;
      let replace = item?.replace;
      if (typeof find !== 'string' || !find || typeof replace !== 'string') {
        throw new Error(`Правка #${i + 1}: укажите непустой find и строку replace.`);
      }
      let idx = next.indexOf(find);
      // CRLF-friendly fallback for Windows files when model sends LF line endings
      if (idx < 0 && fileHasCrLf && find.includes('\n') && !find.includes('\r\n')) {
        const crlfFind = find.replace(/\n/g, '\r\n');
        const crlfIdx = next.indexOf(crlfFind);
        if (crlfIdx >= 0) {
          find = crlfFind;
          replace = replace.replace(/\r?\n/g, '\r\n');
          idx = crlfIdx;
        }
      }
      if (idx < 0) {
        throw new Error(`Правка #${i + 1}: фрагмент find не найден в файле (файл не изменён).`);
      }
      if (idx !== next.lastIndexOf(find)) {
        throw new Error(`Правка #${i + 1}: фрагмент find встречается больше одного раза. Уточните контекст (файл не изменён).`);
      }
      next = next.slice(0, idx) + replace + next.slice(idx + find.length);
    }

    if (next === current.text) {
      return { path: clean, version: current.version, changed: false, appliedEdits: 0 };
    }

    const bytes = encodeText(next);
    if ((await readFileHandle(handle)).version !== current.version) {
      throw new Error('Файл был изменён извне перед записью.');
    }
    const diff = lineDiff(current.text, next);
    const compactDiff = {
      startLine: diff.startLine,
      removed: diff.removed.slice(0, 40),
      added: diff.added.slice(0, 40),
    };
    await writeBytes(handle, bytes);
    const verified = await readFileHandle(handle);
    if (verified.version !== await sha256Hex(bytes)) {
      throw new Error('Содержимое изменилось после записи.');
    }
    const backupId = await recordBackup(chatKey, {
      op: 'edit',
      path: clean,
      beforeText: current.text,
      beforeVersion: current.version,
      diff: compactDiff,
    });
    await rememberVersion(chatKey, clean, current);
    return {
      path: clean,
      version: verified.version,
      changed: true,
      appliedEdits: editsList.length,
      backupId,
      addedLines: diff.added.length,
      removedLines: diff.removed.length,
      diff: compactDiff,
    };
  }

  // Full overwrite of an existing file with version guard + backup
  async function opWrite(chatKey, root, operation) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    let handle;
    try {
      handle = await dir.getFileHandle(name);
    } catch (error) {
      if (error.name === 'NotFoundError') {
        throw new Error('Файл не существует. Для создания нового файла используйте create.');
      }
      throw error;
    }
    const current = await readFileHandle(handle);
    if (operation.version !== current.version) {
      throw new Error('Файл изменился с момента чтения. Прочитайте файл снова перед write.');
    }
    const next = operation.text;
    const bytes = encodeText(next);
    if (next === current.text) {
      return { path: clean, version: current.version, changed: false };
    }
    if ((await readFileHandle(handle)).version !== current.version) {
      throw new Error('Файл был изменён извне перед записью.');
    }
    const diff = lineDiff(current.text, next);
    const compactDiff = {
      startLine: diff.startLine,
      removed: diff.removed.slice(0, 40),
      added: diff.added.slice(0, 40),
    };
    await writeBytes(handle, bytes);
    const verified = await readFileHandle(handle);
    if (verified.version !== await sha256Hex(bytes)) {
      throw new Error('Содержимое изменилось после записи.');
    }
    const backupId = await recordBackup(chatKey, {
      op: 'write',
      path: clean,
      beforeText: current.text,
      beforeVersion: current.version,
      diff: compactDiff,
    });
    await rememberVersion(chatKey, clean, current);
    return {
      path: clean,
      version: verified.version,
      changed: true,
      backupId,
      addedLines: diff.added.length,
      removedLines: diff.removed.length,
      diff: compactDiff,
    };
  }

  async function opDiff(chatKey, root, operation) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    const handle = await dir.getFileHandle(name);
    const current = await readFileHandle(handle);
    const map = await loadVersionsMap(chatKey);
    const before = map[clean];
    if (!before) throw new Error('Нет сохранённого снимка файла. Сначала прочитайте файл через read.');
    return {
      path: clean,
      from: before.version,
      to: current.version,
      ...lineDiff(before.text, current.text),
    };
  }

  async function opDelete(chatKey, root, operation) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    const handle = await dir.getFileHandle(name);
    const current = await readFileHandle(handle);
    await dir.removeEntry(name);
    const backupId = await recordBackup(chatKey, {
      op: 'delete',
      path: clean,
      beforeText: current.text,
      beforeVersion: current.version,
      diff: { startLine: 1, removed: current.text.split('\n').slice(0, 40), added: [] },
    });
    return { path: clean, deleted: true, backupId };
  }

  async function inspectDir(root, relativePath) {
    const { clean, parts } = validateDirPath(relativePath);
    if (!clean || !parts.length) throw new Error('Нельзя указывать корневую папку.');
    const target = await resolveDir(root, parts, false);
    let fileCount = 0;
    let dirCount = 0;
    let binaryCount = 0;
    let hasProtected = false;
    const stack = [target];
    outer: while (stack.length) {
      const cur = stack.pop();
      for await (const handle of cur.values()) {
        const isSubDir = handle.kind === 'directory';
        if (handle.name.startsWith('.') || (isSubDir && BLOCKED_DIRS.test(handle.name)) || (!isSubDir && BLOCKED_FILES.test(handle.name))) {
          hasProtected = true;
          continue;
        }
        if (isSubDir) {
          dirCount++;
          stack.push(handle);
        } else {
          fileCount++;
          if (!isAllowedTextFile(handle.name)) binaryCount++;
        }
        if (fileCount + dirCount > 2000) break outer;
      }
    }
    return { path: clean, fileCount, dirCount, binaryCount, hasProtected, empty: fileCount === 0 && dirCount === 0 && !hasProtected };
  }

  async function opRmdir(chatKey, root, operation) {
    const { clean, parts } = validateDirPath(operation.path);
    if (!clean || !parts.length) throw new Error('Нельзя удалить корневую рабочую папку.');
    const recursive = Boolean(operation.recursive);
    const parent = await resolveDir(root, parts.slice(0, -1), false);
    const name = parts[parts.length - 1];
    const targetDir = await parent.getDirectoryHandle(name);

    // Check contents and collect backups for text files if recursive
    const backedFiles = [];
    const backedDirs = [clean];
    let totalFiles = 0;
    let totalBytes = 0;
    let partialBackup = false;

    const stack = [[targetDir, clean]];
    let visitedEntries = 0;
    while (stack.length) {
      const [dirHandle, prefix] = stack.pop();
      for await (const handle of dirHandle.values()) {
        if (!recursive) {
          throw new Error(`Папка «${clean}» не пуста. Передайте recursive: true для удаления с содержимым.`);
        }
        if (++visitedEntries > 500) {
          throw new Error(`В папке «${clean}» слишком много объектов (>500). Удалите вложенные части отдельно или вручную.`);
        }
        const isSubDir = handle.kind === 'directory';
        if (handle.name.startsWith('.') || (isSubDir && BLOCKED_DIRS.test(handle.name)) || (!isSubDir && BLOCKED_FILES.test(handle.name))) {
          throw new Error(`В папке «${clean}» обнаружен защищённый или скрытый объект «${handle.name}» (.git / .env / node_modules). Рекурсивное удаление заблокировано.`);
        }
        const rel = prefix + '/' + handle.name;
        if (isSubDir) {
          if (validSegment(handle.name, false)) {
            backedDirs.push(rel);
          } else {
            partialBackup = true;
          }
          stack.push([handle, rel]);
        } else {
          totalFiles++;
          if (
            validSegment(handle.name, true) &&
            isAllowedTextFile(handle.name) &&
            backedFiles.length < MAX_DIR_BACKUP_FILES &&
            totalBytes < MAX_DIR_BACKUP_BYTES
          ) {
            try {
              const data = await readFileHandle(handle);
              if (totalBytes + data.size <= MAX_DIR_BACKUP_BYTES) {
                // Only back up if all parent segments are valid for restoreBackup
                if (rel.split('/').every((seg, idx, arr) => validSegment(seg, idx === arr.length - 1))) {
                  backedFiles.push({ path: rel, text: data.text });
                  totalBytes += data.size;
                } else {
                  partialBackup = true;
                }
              } else {
                partialBackup = true;
              }
            } catch {
              partialBackup = true;
            }
          } else {
            partialBackup = true;
          }
        }
      }
    }

    await parent.removeEntry(name, { recursive });
    const backupId = await recordBackup(chatKey, {
      op: 'rmdir',
      path: clean,
      dirs: backedDirs,
      files: backedFiles,
      partialBackup,
    });

    return {
      path: clean,
      deleted: true,
      recursive,
      removedFiles: totalFiles,
      backedUpFiles: backedFiles.length,
      partialBackup,
      backupId,
    };
  }

  async function preflightDirTransfer(srcDir, label) {
    let files = 0;
    let totalBytes = 0;
    const stack = [srcDir];
    while (stack.length) {
      const cur = stack.pop();
      for await (const handle of cur.values()) {
        const isDir = handle.kind === 'directory';
        if (handle.name.startsWith('.') || (isDir && BLOCKED_DIRS.test(handle.name)) || (!isDir && BLOCKED_FILES.test(handle.name))) {
          throw new Error(`В папке «${label}» есть скрытый или защищённый объект «${handle.name}». Перенос папки отменён.`);
        }
        if (isDir) {
          stack.push(handle);
        } else {
          files++;
          if (files > 500) throw new Error(`В папке «${label}» больше 500 файлов — перенос ограничен.`);
          const f = await handle.getFile();
          totalBytes += f.size;
          if (totalBytes > 32 * 1024 * 1024) throw new Error(`Размер папки «${label}» превышает 32 МБ — перенос ограничен.`);
        }
      }
    }
  }

  async function copyDirRecursive(srcDir, dstDir) {
    let copiedFiles = 0;
    for await (const handle of srcDir.values()) {
      if (handle.kind === 'directory') {
        const subDst = await dstDir.getDirectoryHandle(handle.name, { create: true });
        copiedFiles += await copyDirRecursive(handle, subDst);
      } else {
        const f = await handle.getFile();
        const bytes = new Uint8Array(await f.arrayBuffer());
        const dstFile = await dstDir.getFileHandle(handle.name, { create: true });
        await writeBytes(dstFile, bytes);
        copiedFiles++;
      }
    }
    return copiedFiles;
  }

  // Rename/move works for BOTH files and directories!
  async function opRename(chatKey, root, operation) {
    const rawFrom = normalizeRelative(operation.from);
    const rawTo = normalizeRelative(operation.to);
    if (!rawFrom || !rawTo) throw new Error('Укажите непустые пути from и to.');
    if (rawFrom === rawTo) return { from: rawFrom, to: rawTo, renamed: false };

    const fromParts = rawFrom.split('/');
    if (!fromParts.every((p, i) => validSegment(p, i === fromParts.length - 1))) {
      throw new Error('Недопустимый исходный путь: ' + rawFrom);
    }
    const srcParent = await resolveDir(root, fromParts.slice(0, -1), false);
    const srcName = fromParts[fromParts.length - 1];

    let isDirectory = false;
    try {
      await srcParent.getFileHandle(srcName);
    } catch (err) {
      if (err.name === 'TypeMismatchError') {
        isDirectory = true;
      } else if (err.name === 'NotFoundError') {
        // Might be a directory (some mocks/implementations throw NotFoundError on getFileHandle for dirs)
        await srcParent.getDirectoryHandle(srcName);
        isDirectory = true;
      } else {
        throw err;
      }
    }

    if (isDirectory) {
      const src = validateDirPath(rawFrom);
      const dst = validateDirPath(rawTo);
      const srcLower = src.clean.toLowerCase();
      const dstLower = dst.clean.toLowerCase();
      if (dstLower === srcLower || dstLower.startsWith(srcLower + '/')) {
        throw new Error('Нельзя переместить папку внутрь самой себя или переименовать только регистром.');
      }
      const dstParent = await resolveDir(root, dst.parts.slice(0, -1), true);
      const dstName = dst.parts[dst.parts.length - 1];
      let exists = false;
      try {
        await dstParent.getDirectoryHandle(dstName);
        exists = true;
      } catch (e) {
        if (e.name !== 'NotFoundError') exists = true;
      }
      if (!exists) {
        try {
          await dstParent.getFileHandle(dstName);
          exists = true;
        } catch (e) {
          if (e.name !== 'NotFoundError') exists = true;
        }
      }
      if (exists) throw new Error('Целевой путь уже существует: ' + dst.clean);

      const srcDir = await srcParent.getDirectoryHandle(srcName);
      await preflightDirTransfer(srcDir, src.clean);
      const dstDir = await dstParent.getDirectoryHandle(dstName, { create: true });
      let copiedFiles = 0;
      try {
        copiedFiles = await copyDirRecursive(srcDir, dstDir);
        await srcParent.removeEntry(srcName, { recursive: true });
      } catch (err) {
        try { await dstParent.removeEntry(dstName, { recursive: true }); } catch {}
        throw err;
      }
      const backupId = await recordBackup(chatKey, {
        op: 'rename_dir',
        from: src.clean,
        to: dst.clean,
        path: dst.clean,
      });
      return { from: src.clean, to: dst.clean, kind: 'directory', movedFiles: copiedFiles, renamed: true, backupId };
    }

    // File rename
    const src = validateFilePath(rawFrom);
    const dst = validateFilePath(rawTo);
    if (dst.clean.toLowerCase() === src.clean.toLowerCase()) {
      throw new Error('На Windows/macOS нельзя переименовывать файл только изменением регистра напрямую — переименуйте через промежуточное имя.');
    }
    const srcHandle = await srcParent.getFileHandle(src.name);
    const current = await readFileHandle(srcHandle);

    const dstDir = await resolveDir(root, dst.parts.slice(0, -1), true);
    try {
      await dstDir.getFileHandle(dst.name);
      throw new Error('Целевой файл уже существует: ' + dst.clean);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }

    const bytes = encodeText(current.text);
    const dstHandle = await dstDir.getFileHandle(dst.name, { create: true });
    let verified;
    try {
      await writeBytes(dstHandle, bytes);
      verified = await readFileHandle(dstHandle);
      if (verified.version !== current.version) {
        throw new Error('Проверка копии при переименовании не прошла.');
      }
      await srcParent.removeEntry(src.name);
    } catch (err) {
      try { await dstDir.removeEntry(dst.name); } catch {}
      throw err;
    }
    await rememberVersion(chatKey, dst.clean, verified);
    const backupId = await recordBackup(chatKey, {
      op: 'rename',
      from: src.clean,
      to: dst.clean,
      path: dst.clean,
      beforeText: current.text,
      beforeVersion: current.version,
    });
    return { from: src.clean, to: dst.clean, kind: 'file', version: verified.version, renamed: true, backupId };
  }

  // ===== Pure-JS CSP-safe syntax & structure validator =====
  function indexToLineCol(text, index) {
    const before = text.slice(0, Math.max(0, index));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  function validateCodeDelimiters(text, {
    allowHashComment = false,
    allowSlashComment = true,
    allowBacktick = true,
    allowJsRegex = false,
    allowTemplateInterp = false,
  } = {}) {
    const errors = [];
    const stack = [];
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const closing = new Set([')', ']', '}']);

    let line = 1;
    let col = 0;
    let inString = null; // "'", '"', '`', "'''", '"""'
    let stringStart = null;
    const templateResumeDepths = []; // stack depths where '}' resumes an enclosing JS template literal
    let inLineComment = false;
    let inBlockComment = false;
    let blockStart = null;
    let inRegex = false;
    let inRegexClass = false;
    let prevSig = ''; // last non-whitespace char outside comments/strings for regex detection
    let prevWord = '';
    let curWord = '';
    const regexKeywords = new Set(['return', 'case', 'throw', 'in', 'of', 'typeof', 'instanceof', 'void', 'delete', 'new', 'yield', 'await', 'else', 'do']);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1] || '';
      const next3 = text.slice(i, i + 3);

      if (ch === '\n') {
        if (inString && (inString === "'" || inString === '"')) {
          errors.push({ line: stringStart.line, column: stringStart.col, message: `Незакрытая строка ${inString}` });
          inString = null;
        }
        inRegex = false;
        inRegexClass = false;
        inLineComment = false;
        if (curWord) { prevWord = curWord; curWord = ''; }
        line++;
        col = 0;
        continue;
      }
      col++;

      if (inLineComment) continue;

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
          col++;
        }
        continue;
      }

      if (inRegex) {
        if (ch === '\\') {
          if (next === '\n') {
            inRegex = false;
            inRegexClass = false;
          } else {
            i++;
            col++;
          }
          continue;
        }
        if (ch === '[') inRegexClass = true;
        else if (ch === ']') inRegexClass = false;
        else if (ch === '/' && !inRegexClass) {
          inRegex = false;
          prevSig = 'R';
          prevWord = '';
        }
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          if (next === '\n') {
            i++;
            line++;
            col = 0;
          } else if (next === '\r' && text[i + 2] === '\n') {
            i += 2;
            line++;
            col = 0;
          } else {
            i++;
            col++;
          }
          continue;
        }
        if (allowTemplateInterp && inString === '`' && ch === '$' && next === '{') {
          // Enter JS template interpolation ${ ... }
          inString = null;
          stack.push({ open: '${', expected: '}', line, col, isTemplateExpr: true });
          templateResumeDepths.push(stack.length);
          prevSig = '{';
          prevWord = '';
          curWord = '';
          i++;
          col++;
          continue;
        }
        if (inString.length === 3) {
          if (next3 === inString) {
            inString = null;
            prevSig = 'S';
            prevWord = '';
            i += 2;
            col += 2;
          }
        } else if (ch === inString) {
          inString = null;
          prevSig = 'S';
          prevWord = '';
        }
        continue;
      }

      // In SCSS/LESS avoid treating "https://..." inside url(...) as a // line comment
      const prevChar = i > 0 ? text[i - 1] : '';
      if (allowSlashComment && ch === '/' && next === '/' && prevChar !== ':') {
        inLineComment = true;
        if (curWord) { prevWord = curWord; curWord = ''; }
        i++;
        col++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        blockStart = { line, col };
        if (curWord) { prevWord = curWord; curWord = ''; }
        i++;
        col++;
        continue;
      }
      if (allowHashComment && ch === '#') {
        inLineComment = true;
        if (curWord) { prevWord = curWord; curWord = ''; }
        continue;
      }

      // Finalize identifier token before checking '/' so prevWord accurately reflects the immediate previous token
      if (curWord && !/[a-zA-Z0-9_$]/.test(ch)) {
        prevWord = curWord;
        curWord = '';
      }

      // Detect JS/TS regex literal /.../flags so quotes/brackets inside regex don't cause false positives
      if (
        allowJsRegex &&
        ch === '/' &&
        next !== '/' &&
        next !== '*' &&
        (prevSig === '' || '=(,[!&|?:;{}+-*%^~<>'.includes(prevSig) || (prevSig === 'I' && regexKeywords.has(prevWord)))
      ) {
        // Verify closing '/' exists on the same line before treating as regex
        let closedOnLine = false;
        let cls = false;
        for (let k = i + 1; k < text.length && text[k] !== '\n'; k++) {
          if (text[k] === '\\') { k++; continue; }
          if (text[k] === '[') cls = true;
          else if (text[k] === ']') cls = false;
          else if (text[k] === '/' && !cls) { closedOnLine = true; break; }
        }
        if (closedOnLine) {
          inRegex = true;
          inRegexClass = false;
          prevWord = '';
          continue;
        }
      }

      if (allowHashComment && (next3 === "'''" || next3 === '"""')) {
        inString = next3;
        stringStart = { line, col };
        prevWord = '';
        i += 2;
        col += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || (allowBacktick && ch === '`')) {
        inString = ch;
        stringStart = { line, col };
        prevWord = '';
        continue;
      }

      if (/[a-zA-Z0-9_$]/.test(ch)) {
        curWord += ch;
        prevSig = 'I';
      } else if (!/\s/.test(ch)) {
        prevSig = ch;
        prevWord = '';
      }

      if (pairs[ch]) {
        stack.push({ open: ch, expected: pairs[ch], line, col });
      } else if (closing.has(ch)) {
        const top = stack.pop();
        if (!top) {
          errors.push({ line, column: col, message: `Лишняя закрывающая скобка '${ch}'` });
        } else if (top.expected !== ch) {
          errors.push({
            line,
            column: col,
            message: `Несоответствие скобок: ожидалась '${top.expected}' (открыта на строке ${top.line}), встретилась '${ch}'`,
          });
        } else if (top.isTemplateExpr && templateResumeDepths.length) {
          templateResumeDepths.pop();
          inString = '`';
          stringStart = { line: top.line, col: top.col };
        }
      }
      if (errors.length >= 10) break;
    }

    if (inBlockComment && blockStart) {
      errors.push({ line: blockStart.line, column: blockStart.col, message: 'Незакрытый блочный комментарий /*' });
    }
    if (inString && stringStart) {
      errors.push({ line: stringStart.line, column: stringStart.col, message: `Незакрытая строка ${inString}` });
    }
    for (const unclosed of stack.slice(-5)) {
      errors.push({ line: unclosed.line, column: unclosed.col, message: `Не закрыта скобка '${unclosed.open}'` });
    }
    return errors;
  }

  function validateTextByExtension(filePath, text) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();

    if (ext === 'json') {
      const cleanJson = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      try {
        JSON.parse(cleanJson);
        return { path: filePath, kind: 'json', valid: true, errors: [] };
      } catch (err) {
        const posMatch = /position\s+(\d+)/i.exec(err.message);
        const loc = posMatch ? indexToLineCol(cleanJson, Number(posMatch[1])) : { line: 1, column: 1 };
        return {
          path: filePath,
          kind: 'json',
          valid: false,
          errors: [{ line: loc.line, column: loc.column, message: err.message }],
        };
      }
    }

    if ((ext === 'xml' || ext === 'svg') && typeof globalThis.DOMParser === 'function') {
      const doc = new globalThis.DOMParser().parseFromString(text, 'application/xml');
      const errNode = doc.querySelector('parsererror');
      if (errNode) {
        return {
          path: filePath,
          kind: ext,
          valid: false,
          errors: [{ line: 1, column: 1, message: (errNode.textContent || 'Ошибка XML').trim().slice(0, 300) }],
        };
      }
      return { path: filePath, kind: ext, valid: true, errors: [] };
    }

    if (ext === 'py' || ext === 'pyi') {
      const errors = validateCodeDelimiters(text, { allowHashComment: true, allowSlashComment: false, allowBacktick: false });
      const lines = text.split('\n');
      let hasTabs = false;
      let hasSpaces = false;
      let tripleQuote = null;
      for (let i = 0; i < lines.length; i++) {
        const lineStr = lines[i];
        const insideBefore = Boolean(tripleQuote);
        // Track triple-quoted multiline strings/docstrings so indentation inside them is ignored
        for (let j = 0; j < lineStr.length; j++) {
          if (lineStr[j] === '\\') { j++; continue; }
          if (!tripleQuote && lineStr[j] === '#') break;
          const t3 = lineStr.slice(j, j + 3);
          if (t3 === '"""' || t3 === "'''") {
            if (!tripleQuote) { tripleQuote = t3; j += 2; }
            else if (tripleQuote === t3) { tripleQuote = null; j += 2; }
          }
        }
        if (insideBefore) continue;
        const m = /^([ \t]+)\S/.exec(lineStr);
        if (!m) continue;
        if (m[1].includes('\t')) hasTabs = true;
        if (m[1].includes(' ')) hasSpaces = true;
        if (m[1].includes('\t') && m[1].includes(' ')) {
          errors.push({ line: i + 1, column: 1, message: 'Смешаны табы и пробелы в одном отступе' });
          break;
        }
      }
      if (hasTabs && hasSpaces && !errors.some(e => e.message.includes('табы'))) {
        errors.push({ line: 1, column: 1, message: 'В файле одновременно используются табы и пробелы для отступов' });
      }
      return { path: filePath, kind: 'python', valid: errors.length === 0, errors: errors.slice(0, 10) };
    }

    if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].includes(ext)) {
      const errors = validateCodeDelimiters(text, {
        allowHashComment: false,
        allowSlashComment: true,
        allowBacktick: true,
        allowJsRegex: true,
        allowTemplateInterp: true,
      });
      return { path: filePath, kind: ext, valid: errors.length === 0, errors: errors.slice(0, 10) };
    }

    if (ext === 'css') {
      const errors = validateCodeDelimiters(text, {
        allowHashComment: false,
        allowSlashComment: false,
        allowBacktick: false,
        allowJsRegex: false,
      });
      return { path: filePath, kind: 'css', valid: errors.length === 0, errors: errors.slice(0, 10) };
    }

    if (['scss', 'less', 'java', 'go', 'kt', 'swift'].includes(ext)) {
      const errors = validateCodeDelimiters(text, {
        allowHashComment: false,
        allowSlashComment: true,
        allowBacktick: ext === 'go',
        allowJsRegex: false,
      });
      return { path: filePath, kind: ext, valid: errors.length === 0, errors: errors.slice(0, 10) };
    }

    return {
      path: filePath,
      kind: ext || 'text',
      valid: true,
      errors: [],
      note: 'Специализированный валидатор для этого расширения отсутствует; кодировка UTF-8 корректна.',
    };
  }

  async function opValidate(root, operation) {
    const { clean, parts, name } = validateFilePath(operation.path);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    const handle = await dir.getFileHandle(name);
    const current = await readFileHandle(handle);
    return validateTextByExtension(clean, current.text);
  }

  async function restoreBackup(chatKey, root, backupId) {
    if (!store) throw new Error('Хранилище бэкапов недоступно.');
    const backup = await store.getBackup(backupId);
    if (!backup || backup.chatKey !== chatKey) throw new Error('Резервная копия не найдена.');
    if (backup.restoredAt) throw new Error('Эта правка уже была откачена.');

    if (backup.op === 'edit' || backup.op === 'write' || backup.op === 'delete') {
      const { clean, parts, name } = validateFilePath(backup.path);
      const dir = await resolveDir(root, parts.slice(0, -1), true);
      const handle = await dir.getFileHandle(name, { create: true });
      const bytes = encodeText(backup.beforeText);
      await writeBytes(handle, bytes);
      const verified = await readFileHandle(handle);
      await rememberVersion(chatKey, clean, verified);
      await store.markBackupRestored(backupId);
      return { restored: true, op: backup.op, path: clean };
    }

    if (backup.op === 'mkdir') {
      const targets = Array.isArray(backup.createdDirs) && backup.createdDirs.length
        ? [...backup.createdDirs].reverse()
        : [backup.path];
      for (const rel of targets) {
        const { parts } = validateDirPath(rel);
        if (!parts.length) continue;
        const name = parts[parts.length - 1];
        const parent = await resolveDir(root, parts.slice(0, -1), false);
        try {
          await parent.removeEntry(name, { recursive: false });
        } catch (err) {
          // Stop climbing if an upper folder now contains other files
          if (rel === targets[0]) throw err;
          break;
        }
      }
      await store.markBackupRestored(backupId);
      return { restored: true, op: 'mkdir', path: backup.path, removed: true };
    }

    if (backup.op === 'rmdir') {
      const dirs = Array.isArray(backup.dirs) ? backup.dirs : [backup.path];
      for (const d of dirs) {
        const { parts } = validateDirPath(d);
        if (parts.length) await resolveDir(root, parts, true);
      }
      for (const f of (backup.files || [])) {
        const { parts, name } = validateFilePath(f.path);
        const dir = await resolveDir(root, parts.slice(0, -1), true);
        const handle = await dir.getFileHandle(name, { create: true });
        await writeBytes(handle, encodeText(f.text));
      }
      await store.markBackupRestored(backupId);
      return { restored: true, op: 'rmdir', path: backup.path, restoredFiles: (backup.files || []).length };
    }

    if (backup.op === 'create') {
      const { clean, parts, name } = validateFilePath(backup.path);
      const dir = await resolveDir(root, parts.slice(0, -1), false);
      await dir.removeEntry(name);
      await store.markBackupRestored(backupId);
      return { restored: true, op: 'create', path: clean, removed: true };
    }

    if (backup.op === 'rename') {
      const src = validateFilePath(backup.from);
      const dst = validateFilePath(backup.to);
      const srcDir = await resolveDir(root, src.parts.slice(0, -1), true);
      let srcExists = false;
      try { await srcDir.getFileHandle(src.name); srcExists = true; } catch {}
      try { await srcDir.getDirectoryHandle(src.name); srcExists = true; } catch {}
      if (srcExists) {
        throw new Error(`Невозможно откатить переименование: путь "${src.clean}" уже занят.`);
      }
      const srcHandle = await srcDir.getFileHandle(src.name, { create: true });
      try {
        await writeBytes(srcHandle, encodeText(backup.beforeText));
      } catch (err) {
        try { await srcDir.removeEntry(src.name); } catch {}
        throw err;
      }
      try {
        const dstDir = await resolveDir(root, dst.parts.slice(0, -1), false);
        await dstDir.removeEntry(dst.name);
      } catch {}
      await store.markBackupRestored(backupId);
      return { restored: true, op: 'rename', path: src.clean };
    }

    if (backup.op === 'rename_dir') {
      const src = validateDirPath(backup.from);
      const dst = validateDirPath(backup.to);
      const dstParent = await resolveDir(root, dst.parts.slice(0, -1), false);
      const dstDir = await dstParent.getDirectoryHandle(dst.parts[dst.parts.length - 1]);
      await preflightDirTransfer(dstDir, dst.clean);
      const srcParent = await resolveDir(root, src.parts.slice(0, -1), true);
      const srcName = src.parts[src.parts.length - 1];
      let srcExists = false;
      try { await srcParent.getDirectoryHandle(srcName); srcExists = true; } catch {}
      try { await srcParent.getFileHandle(srcName); srcExists = true; } catch {}
      if (srcExists) {
        throw new Error(`Невозможно откатить переименование папки: путь "${src.clean}" уже занят.`);
      }
      const srcDir = await srcParent.getDirectoryHandle(srcName, { create: true });
      try {
        await copyDirRecursive(dstDir, srcDir);
        await dstParent.removeEntry(dst.parts[dst.parts.length - 1], { recursive: true });
      } catch (err) {
        try { await srcParent.removeEntry(srcName, { recursive: true }); } catch {}
        throw err;
      }
      await store.markBackupRestored(backupId);
      return { restored: true, op: 'rename_dir', path: src.clean };
    }

    throw new Error('Неизвестный тип резервной копии.');
  }

  async function executeSingle(chatKey, root, operation, budget) {
    if (!operation || typeof operation !== 'object') throw new Error('Ожидался объект операции.');
    switch (operation.op) {
      case 'list': return opList(root, operation);
      case 'search': return opSearch(root, operation);
      case 'read': return opRead(chatKey, root, operation, budget);
      case 'mkdir': return opMkdir(chatKey, root, operation);
      case 'create': return opCreate(chatKey, root, operation);
      case 'edit': return opEdit(chatKey, root, operation);
      case 'write': return opWrite(chatKey, root, operation);
      case 'diff': return opDiff(chatKey, root, operation);
      case 'delete': return opDelete(chatKey, root, operation);
      case 'rmdir': return opRmdir(chatKey, root, operation);
      case 'rename': return opRename(chatKey, root, operation);
      case 'validate': return opValidate(root, operation);
      default:
        throw new Error('Неизвестная операция: ' + String(operation.op));
    }
  }

  async function runSnapshot(chatKey, root) {
    const { files, meta, truncated } = await walkTree(root, '', { needMeta: true, maxEntries: 2500 });
    const currentObj = Object.fromEntries(meta);
    const prevObj = (store && await store.getMeta('snap:' + chatKey)) || currentObj;
    const changes = [];
    for (const [p, sig] of Object.entries(currentObj)) {
      if (prevObj[p] !== sig) {
        changes.push({ path: p, state: Object.prototype.hasOwnProperty.call(prevObj, p) ? 'modified' : 'added' });
      }
    }
    for (const p of Object.keys(prevObj)) {
      if (!Object.prototype.hasOwnProperty.call(currentObj, p)) {
        changes.push({ path: p, state: 'removed' });
      }
    }
    if (store) await store.setMeta('snap:' + chatKey, currentObj);
    return {
      folder: root.name,
      count: files.length,
      truncated,
      changes: changes.slice(0, 15),
      remaining: Math.max(0, changes.length - 15),
    };
  }

  async function runBatch(chatKey, root, operations, sharedBudget = null) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_BATCH_OPS) {
      throw new Error(`В пачке должно быть от 1 до ${MAX_BATCH_OPS} операций.`);
    }
    const results = [];
    const budgetState = sharedBudget || { remaining: MAX_REPLY_CHARS };
    for (const op of operations) {
      let result;
      try {
        if (budgetState.remaining < 1000) throw new Error('Достигнут лимит размера пакета. Запросите остальное следующей пачкой.');
        result = await executeSingle(chatKey, root, op, budgetState.remaining - 600);
        if (JSON.stringify(result).length > budgetState.remaining - 400) {
          throw new Error('Результат операции слишком длинный. Используйте startLine/endLine или уточните запрос.');
        }
      } catch (error) {
        const friendly = {
          NotFoundError: 'Файл или папка не найдены.',
          NotAllowedError: 'Браузер отозвал доступ к папке. Нажмите на папку в шапке.',
          TypeMismatchError: 'Имя занято объектом другого типа.',
          InvalidModificationError: 'Папка не пуста или занята.',
        };
        result = { error: friendly[error.name] || error.message };
      }
      budgetState.remaining -= JSON.stringify(result).length + 1;
      results.push(result);
    }
    return { results, remaining: budgetState.remaining };
  }

  async function previewFile(root, filePath) {
    const { clean, parts, name } = validateFilePath(filePath);
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    const handle = await dir.getFileHandle(name);
    const data = await readFileHandle(handle);
    return { path: clean, text: data.text, size: data.size };
  }

  function enqueue(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }

  return {
    snapshot: (chatKey, root) => enqueue(() => runSnapshot(chatKey, root)),
    batch: (chatKey, root, ops, sharedBudget = null) => enqueue(() => runBatch(chatKey, root, ops, sharedBudget)),
    createBatchBudget: () => ({ remaining: MAX_REPLY_CHARS }),
    listTree: (root, dir = '') => enqueue(() => walkTree(root, dir, { needMeta: false })),
    inspectDir: (root, relPath) => enqueue(() => inspectDir(root, relPath)),
    preview: (root, filePath) => enqueue(() => previewFile(root, filePath)),
    restore: (chatKey, root, backupId) => enqueue(() => restoreBackup(chatKey, root, backupId)),
    validateTextByExtension,
    validSegment,
    isAllowedTextFile,
    lineDiff,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createWorkspaceFiles };
}
