const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const isStore = process.argv.includes('--store');
const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));

const REPO_SLUG = 'offlinejust/OJ-QWEN';

if (manifest.version !== pkg.version) {
  throw new Error(`Version mismatch: package.json=${pkg.version}, manifest.json=${manifest.version}`);
}

// Verify there are no personal/local leaks in extension files (case-insensitive)
// Note: the public GitHub repository URL github.com/offlinejust/OJ-QWEN is intentionally allowed.
const forbidden = [
  'offlinejust.ru',
  'dav7offline',
  'oj-cent',
  'oj-server',
  '127.0.0.1:48391',
  'ojqweninstalledtoken',
  'c:\\users\\',
  'c:/users/',
];
const junkFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanDir(full);
    else {
      if (junkFiles.has(entry.name.toLowerCase())) continue;
      const content = fs.readFileSync(full, 'utf8').toLowerCase();
      for (const bad of forbidden) {
        if (content.includes(bad)) {
          throw new Error(`Forbidden string "${bad}" found in ${path.relative(root, full)}`);
        }
      }
    }
  }
}
scanDir(extDir);

function buildUpdaterCmd() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'title OJ-QWEN — Обновление расширения',
    'set "OJ_DIR=%~dp0"',
    'set "OJ_SELF=%~f0"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$l = Get-Content -LiteralPath $env:OJ_SELF -Encoding UTF8; $i = [Array]::IndexOf($l, \'::===POWERSHELL===\'); Invoke-Expression (($l[($i+1)..($l.Length-1)]) -join [Environment]::NewLine)" & exit /b',
    '::===POWERSHELL===',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ErrorActionPreference = "Stop"',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '',
    `$repo = "${REPO_SLUG}"`,
    '$rootDir = $env:OJ_DIR.TrimEnd("\\")',
    '$extDir = Join-Path $rootDir "extension"',
    '$manifestPath = Join-Path $extDir "manifest.json"',
    '$headers = @{ "User-Agent" = "OJ-QWEN-Updater"; "Accept" = "application/vnd.github+json" }',
    '',
    'function Compare-SemVer([string]$a, [string]$b) {',
    '  $pa = @(($a -replace "^[vV]", "").Split(".") | ForEach-Object { $n = $_ -replace "[^0-9].*$", ""; if ($n) { [int]$n } else { 0 } })',
    '  $pb = @(($b -replace "^[vV]", "").Split(".") | ForEach-Object { $n = $_ -replace "[^0-9].*$", ""; if ($n) { [int]$n } else { 0 } })',
    '  $len = [Math]::Max([Math]::Max($pa.Count, $pb.Count), 3)',
    '  for ($k = 0; $k -lt $len; $k++) {',
    '    $va = if ($k -lt $pa.Count) { $pa[$k] } else { 0 }',
    '    $vb = if ($k -lt $pb.Count) { $pb[$k] } else { 0 }',
    '    if ($va -gt $vb) { return 1 }',
    '    if ($va -lt $vb) { return -1 }',
    '  }',
    '  return 0',
    '}',
    '',
    'function Sync-Directory([string]$srcDir, [string]$dstDir) {',
    '  if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }',
    '  $srcRoot = (Resolve-Path -LiteralPath $srcDir).Path.TrimEnd("\\")',
    '  $dstRoot = (Resolve-Path -LiteralPath $dstDir).Path.TrimEnd("\\")',
    '  $srcFiles = @{}',
    '  Get-ChildItem -LiteralPath $srcRoot -Recurse -Force | ForEach-Object {',
    '    $rel = $_.FullName.Substring($srcRoot.Length + 1)',
    '    $target = Join-Path $dstRoot $rel',
    '    if ($_.PSIsContainer) {',
    '      if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }',
    '    } else {',
    '      $srcFiles[$rel.ToLowerInvariant()] = $true',
    '      $parent = Split-Path -Parent $target',
    '      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }',
    '      Copy-Item -LiteralPath $_.FullName -Destination $target -Force',
    '    }',
    '  }',
    '  # Remove obsolete files that no longer exist in the new release (without locking root folder)',
    '  Get-ChildItem -LiteralPath $dstRoot -Recurse -File -Force | ForEach-Object {',
    '    $rel = $_.FullName.Substring($dstRoot.Length + 1).ToLowerInvariant()',
    '    if (-not $srcFiles.ContainsKey($rel)) {',
    '      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue',
    '    }',
    '  }',
    '}',
    '',
    'function Resolve-LatestRelease() {',
    '  # Optional local test override (used by automated tests only)',
    '  if ($env:OJ_UPD_LOCAL_ZIP -and (Test-Path -LiteralPath $env:OJ_UPD_LOCAL_ZIP)) {',
    '    return @{ version = ($env:OJ_UPD_LOCAL_VER); zipPath = $env:OJ_UPD_LOCAL_ZIP; url = $null; name = (Split-Path -Leaf $env:OJ_UPD_LOCAL_ZIP) }',
    '  }',
    '  try {',
    '    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 20',
    '    $ver = ([string]$rel.tag_name) -replace "^[vV]", ""',
    '    $asset = $rel.assets | Where-Object { $_.name -match "^OJ-QWEN-.*\\.zip$" -and $_.name -notmatch "-store\\.zip$" } | Select-Object -First 1',
    '    if ($ver -and $asset) {',
    '      return @{ version = $ver; url = $asset.browser_download_url; name = $asset.name; zipPath = $null }',
    '    }',
    '  } catch {',
    '    $code = 0',
    '    try { $code = [int]$_.Exception.Response.StatusCode } catch {}',
    '    if ($code -eq 404) { throw "На GitHub пока нет опубликованных релизов." }',
    '    Write-Host "GitHub API недоступен (HTTP $code), пробую прямую проверку релиза..." -ForegroundColor DarkYellow',
    '  }',
    '  # Fallback without API rate limit: follow /releases/latest redirect',
    '  $req = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")',
    '  $req.UserAgent = "OJ-QWEN-Updater"',
    '  $req.AllowAutoRedirect = $true',
    '  $req.Timeout = 20000',
    '  $resp = $req.GetResponse()',
    '  $finalUri = $resp.ResponseUri.AbsoluteUri',
    '  $resp.Close()',
    '  if ($finalUri -match "/releases/tag/v?([^/?#]+)") {',
    '    $ver = $Matches[1]',
    '    $name = "OJ-QWEN-$ver.zip"',
    '    return @{ version = $ver; url = "https://github.com/$repo/releases/download/v$ver/$name"; name = $name; zipPath = $null }',
    '  }',
    '  throw "Не удалось получить информацию о последнем релизе с GitHub."',
    '}',
    '',
    '$exitCode = 0',
    'try {',
    '  $localVer = "0.0.0"',
    '  if (Test-Path -LiteralPath $manifestPath) {',
    '    $localVer = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version',
    '  }',
    '  Write-Host "Текущая версия OJ-QWEN: $localVer" -ForegroundColor Cyan',
    '  Write-Host "Проверяю последний релиз на GitHub..."',
    '',
    '  $info = Resolve-LatestRelease',
    '  $latestVer = $info.version',
    '  if (-not $latestVer) { throw "Не удалось определить номер версии релиза." }',
    '',
    '  if ((Compare-SemVer $latestVer $localVer) -le 0) {',
    '    Write-Host "У вас уже установлена последняя версия ($localVer)." -ForegroundColor Green',
    '  } else {',
    '    Write-Host "Найдена новая версия $latestVer! Загружаю $($info.name)..." -ForegroundColor Yellow',
    '    $tmpRoot = Join-Path $env:TEMP ("oj-qwen-upd-" + $PID + "-" + (Get-Random))',
    '    $zipFile = Join-Path $tmpRoot $info.name',
    '    $unpackDir = Join-Path $tmpRoot "unpacked"',
    '    New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null',
    '',
    '    try {',
    '      if ($info.zipPath) {',
    '        Copy-Item -LiteralPath $info.zipPath -Destination $zipFile -Force',
    '      } else {',
    '        Invoke-WebRequest -Uri $info.url -OutFile $zipFile -Headers $headers -UseBasicParsing -TimeoutSec 60',
    '      }',
    '      Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '      [System.IO.Compression.ZipFile]::ExtractToDirectory($zipFile, $unpackDir)',
    '      $newExt = Join-Path $unpackDir "extension"',
    '      if (-not (Test-Path -LiteralPath (Join-Path $newExt "manifest.json"))) {',
    '        throw "В скачанном архиве не найдена папка extension/manifest.json."',
    '      }',
    '',
    '      # Copy backup first (never Move-Item on $extDir so open Explorer/browser handles never fail the update)',
    '      $bakDir = Join-Path $tmpRoot "extension.bak"',
    '      if (Test-Path -LiteralPath $extDir) {',
    '        Copy-Item -LiteralPath $extDir -Destination $bakDir -Recurse -Force',
    '      }',
    '      try {',
    '        Sync-Directory -srcDir $newExt -dstDir $extDir',
    '        $newReadme = Join-Path $unpackDir "Установка.txt"',
    '        if (Test-Path -LiteralPath $newReadme) {',
    '          Copy-Item -LiteralPath $newReadme -Destination (Join-Path $rootDir "Установка.txt") -Force',
    '        }',
    '        # Safe self-update of Обновить.cmd (cmd.exe already buffered the single command line in RAM)',
    '        $newCmd = Join-Path $unpackDir "Обновить.cmd"',
    '        if (Test-Path -LiteralPath $newCmd) {',
    '          Copy-Item -LiteralPath $newCmd -Destination $env:OJ_SELF -Force -ErrorAction SilentlyContinue',
    '        }',
    '      } catch {',
    '        if (Test-Path -LiteralPath $bakDir) {',
    '          Sync-Directory -srcDir $bakDir -dstDir $extDir',
    '        }',
    '        throw',
    '      }',
    '      Write-Host ""',
    '      Write-Host "Готово! OJ-QWEN обновлён: $localVer -> $latestVer" -ForegroundColor Green',
    '      Write-Host "Теперь откройте chrome://extensions (или browser://extensions) и нажмите кнопку обновления (стрелка по кругу) у OJ-QWEN." -ForegroundColor White',
    '    } finally {',
    '      if (Test-Path -LiteralPath $tmpRoot) { Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }',
    '    }',
    '  }',
    '} catch {',
    '  Write-Host ("Ошибка обновления: " + $_.Exception.Message) -ForegroundColor Red',
    '  Write-Host "Можно скачать архив вручную: https://github.com/$repo/releases/latest" -ForegroundColor Yellow',
    '  $exitCode = 1',
    '} finally {',
    '  if ($env:OJ_UPD_NOPAUSE -ne "1") {',
    '    Write-Host ""',
    '    try { [void](Read-Host "Нажмите Enter, чтобы закрыть окно") } catch {}',
    '  }',
    '}',
    'if ($exitCode -ne 0) { exit $exitCode }',
    '',
  ].join('\r\n');
}

fs.mkdirSync(distDir, { recursive: true });
const stageDir = path.join(distDir, isStore ? 'stage-store' : 'stage');
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

if (isStore) {
  // Flat ZIP with manifest.json directly at archive root (for Chrome Web Store / Opera Add-ons / Edge Add-ons)
  fs.cpSync(extDir, stageDir, {
    recursive: true,
    filter: src => !junkFiles.has(path.basename(src).toLowerCase()),
  });
} else {
  fs.cpSync(extDir, path.join(stageDir, 'extension'), {
    recursive: true,
    filter: src => !junkFiles.has(path.basename(src).toLowerCase()),
  });
  fs.writeFileSync(path.join(stageDir, 'Обновить.cmd'), buildUpdaterCmd(), 'utf8');
  fs.writeFileSync(
    path.join(stageDir, 'Установка.txt'),
    [
      `OJ-QWEN ${manifest.version}`,
      '',
      '=== ПЕРВАЯ УСТАНОВКА ===',
      '1. Распакуй этот архив в постоянную папку (например, C:\\OJ-QWEN).',
      '2. Открой страницу расширений в Chrome, Edge или Яндекс Браузере (chrome://extensions или browser://extensions).',
      '3. Включи «Режим разработчика», нажми «Загрузить распакованное расширение» и выбери папку extension.',
      '4. Открой https://chat.qwen.ai, войди в аккаунт и нажми кнопку OJ-QWEN внизу справа (или Alt + Q).',
      '5. Чтобы дать Qwen доступ к файлам проекта, нажми «Выбрать папку» в шапке нужного чата.',
      '',
      '=== КАК ОБНОВЛЯТЬ ===',
      '1. Просто запусти двойным кликом файл «Обновить.cmd» в этой же папке — он сам скачает свежую версию с GitHub и обновит папку extension.',
      '2. Открой страницу расширений в браузере и нажми кнопку обновления (↻) у OJ-QWEN.',
      '   Все настройки, планы, память и бэкапы сохранятся!',
      '',
      `Страница релизов: https://github.com/${REPO_SLUG}/releases/latest`,
      'Никакие серверы, Node.js, Git, API-ключи и ручной системный промпт не требуются.',
      'По умолчанию включён режим безопасности «Всё спрашивать» (можно переключить в Настройках).',
      '',
    ].join('\r\n'),
    'utf8'
  );
}

const zipName = isStore
  ? `OJ-QWEN-${manifest.version}-store.zip`
  : `OJ-QWEN-${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);
fs.rmSync(zipPath, { force: true });

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

if (process.platform === 'win32') {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${psQuote(path.join(stageDir, '*'))} -DestinationPath ${psQuote(zipPath)} -Force`,
    ],
    { stdio: 'inherit' }
  );
} else {
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
}

fs.rmSync(stageDir, { recursive: true, force: true });
console.log('Packed:', zipPath);
