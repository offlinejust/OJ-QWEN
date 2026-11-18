var OjMarkdown = (() => {
  function isSafeUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  // Render inline markdown (code, bold, italic, strike, links, @file pills) safely using DOM nodes only
  function appendInline(parent, text, doc = document) {
    // Tokenize inline constructs: `code`, **bold**, *italic*, ~~strike~~, [label](url)
    const tokenRe = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|~~[^~\n]+?~~|\*[^*\n]+?\*|\[[^\]\n]+\]\((?:https?:\/\/[^\s)]+)\))/g;
    let lastIndex = 0;
    let match;

    while ((match = tokenRe.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        const code = doc.createElement('code');
        code.className = 'md-inline-code';
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.startsWith('**') && token.endsWith('**')) {
        const strong = doc.createElement('strong');
        appendInline(strong, token.slice(2, -2), doc);
        parent.appendChild(strong);
      } else if (token.startsWith('~~') && token.endsWith('~~')) {
        const del = doc.createElement('del');
        appendInline(del, token.slice(2, -2), doc);
        parent.appendChild(del);
      } else if (token.startsWith('*') && token.endsWith('*')) {
        const em = doc.createElement('em');
        appendInline(em, token.slice(1, -1), doc);
        parent.appendChild(em);
      } else if (token.startsWith('[')) {
        const linkMatch = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
        if (linkMatch && isSafeUrl(linkMatch[2])) {
          const a = doc.createElement('a');
          a.href = linkMatch[2];
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = linkMatch[1];
          parent.appendChild(a);
        } else {
          parent.appendChild(doc.createTextNode(token));
        }
      }
      lastIndex = match.index + token.length;
    }

    if (lastIndex < text.length) {
      parent.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }
  }

  function createCodeBlock(lang, codeText, doc, onCopy) {
    const wrap = doc.createElement('div');
    wrap.className = 'md-code-block';

    const header = doc.createElement('div');
    header.className = 'md-code-head';
    const langSpan = doc.createElement('span');
    langSpan.textContent = lang || 'text';
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'md-copy-btn';
    copyBtn.textContent = 'Копировать';
    copyBtn.addEventListener('click', async () => {
      try {
        if (onCopy) await onCopy(codeText);
        else await navigator.clipboard.writeText(codeText);
        copyBtn.textContent = 'Скопировано';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
      } catch {
        copyBtn.textContent = 'Ошибка';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
      }
    });
    header.append(langSpan, copyBtn);

    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.textContent = codeText;
    pre.appendChild(code);

    wrap.append(header, pre);
    return wrap;
  }

  function parseTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  }

  function isTableSeparator(line) {
    return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
  }

  function parseFenceStart(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('```')) return null;
    const rest = trimmed.slice(3);
    // Single-line inline triple-backtick code like ```foo``` is NOT a multi-line fence
    if (rest.includes('```')) return null;
    const firstToken = rest.trim().split(/[\s:]/)[0] || '';
    const lang = firstToken.replace(/[^a-zA-Z0-9_+#.-]/g, '');
    return { lang };
  }

  function parseHeading(line) {
    return /^(#{1,6})\s+(.+)$/.exec(line);
  }

  function isHrLine(line) {
    return /^(?:---+|\*\*\*+|___+)\s*$/.test(line.trim());
  }

  function isBlockStarter(lines, idx) {
    const line = lines[idx];
    if (!line.trim()) return true;
    if (parseFenceStart(line)) return true;
    if (parseHeading(line)) return true;
    if (isHrLine(line)) return true;
    if (/^>\s?/.test(line)) return true;
    if (/^\s*[-*+]\s+/.test(line)) return true;
    if (/^\s*\d+\.\s+/.test(line)) return true;
    if (line.includes('|') && idx + 1 < lines.length && isTableSeparator(lines[idx + 1])) return true;
    return false;
  }

  function render(markdownText, { doc = document, onCopy = null } = {}) {
    const frag = doc.createDocumentFragment();
    const text = String(markdownText ?? '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Blank line
      if (!line.trim()) {
        i++;
        continue;
      }

      // Fenced code block
      const fence = parseFenceStart(line);
      if (fence) {
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // consume closing fence
        frag.appendChild(createCodeBlock(fence.lang, codeLines.join('\n'), doc, onCopy));
        continue;
      }

      // Heading
      const headingMatch = parseHeading(line);
      if (headingMatch) {
        const level = Math.min(6, headingMatch[1].length);
        const h = doc.createElement('h' + level);
        h.className = 'md-h';
        appendInline(h, headingMatch[2].trim(), doc);
        frag.appendChild(h);
        i++;
        continue;
      }

      // Horizontal rule
      if (isHrLine(line)) {
        frag.appendChild(doc.createElement('hr'));
        i++;
        continue;
      }

      // Table (header + separator)
      if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const tableWrap = doc.createElement('div');
        tableWrap.className = 'md-table-wrap';
        const table = doc.createElement('table');
        table.className = 'md-table';
        const thead = doc.createElement('thead');
        const headTr = doc.createElement('tr');
        for (const cell of parseTableRow(line)) {
          const th = doc.createElement('th');
          appendInline(th, cell, doc);
          headTr.appendChild(th);
        }
        thead.appendChild(headTr);
        table.appendChild(thead);
        i += 2;

        const tbody = doc.createElement('tbody');
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const tr = doc.createElement('tr');
          for (const cell of parseTableRow(lines[i])) {
            const td = doc.createElement('td');
            appendInline(td, cell, doc);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        frag.appendChild(tableWrap);
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        const bq = doc.createElement('blockquote');
        bq.className = 'md-quote';
        bq.appendChild(render(quoteLines.join('\n'), { doc, onCopy }));
        frag.appendChild(bq);
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const ul = doc.createElement('ul');
        ul.className = 'md-list';
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const li = doc.createElement('li');
          appendInline(li, lines[i].replace(/^\s*[-*+]\s+/, ''), doc);
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = doc.createElement('ol');
        ol.className = 'md-list';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = doc.createElement('li');
          appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ''), doc);
          ol.appendChild(li);
          i++;
        }
        frag.appendChild(ol);
        continue;
      }

      // Paragraph (accumulate lines until blank or block starter; always advance at least 1 line)
      const paraLines = [];
      while (i < lines.length && !isBlockStarter(lines, i)) {
        paraLines.push(lines[i]);
        i++;
      }
      if (!paraLines.length && i < lines.length) {
        paraLines.push(lines[i]);
        i++;
      }
      const p = doc.createElement('p');
      p.className = 'md-p';
      paraLines.forEach((pLine, idx) => {
        if (idx > 0) p.appendChild(doc.createElement('br'));
        appendInline(p, pLine, doc);
      });
      frag.appendChild(p);
    }

    return frag;
  }

  return { render, isSafeUrl };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OjMarkdown;
}
