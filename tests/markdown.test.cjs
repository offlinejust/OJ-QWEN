const test = require('node:test');
const assert = require('node:assert/strict');
const OjMarkdown = require('../extension/lib/markdown.js');

// Minimal DOM mock to verify safe DOM construction without innerHTML XSS
class MockNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this._text = '';
  }
  appendChild(child) {
    if (child.tagName === '#fragment') {
      this.children.push(...child.children);
    } else {
      this.children.push(child);
    }
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  addEventListener() {}
  set textContent(v) { this._text = String(v); }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._text;
  }
}

const mockDoc = {
  createDocumentFragment: () => new MockNode('#fragment'),
  createElement: tag => new MockNode(tag.toLowerCase()),
  createTextNode: txt => {
    const n = new MockNode('#text');
    n.textContent = txt;
    return n;
  },
};

function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}

test('renders headings, lists, code blocks, tables, and strips unsafe javascript: links', () => {
  const md = [
    '# Заголовок',
    '',
    'Обычный **жирный** и `код` и [безопасная](https://example.com) и [xss](javascript:alert(1)).',
    '',
    '- пункт 1',
    '- пункт 2',
    '',
    '```js',
    'const x = "<script>alert(1)</script>";',
    '```',
    '',
    '| Col A | Col B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');

  const root = new MockNode('div');
  root.appendChild(OjMarkdown.render(md, { doc: mockDoc }));

  assert.equal(findAll(root, n => n.tagName === 'h1').length, 1);
  assert.equal(findAll(root, n => n.tagName === 'li').length, 2);
  assert.equal(findAll(root, n => n.tagName === 'table').length, 1);
  assert.equal(findAll(root, n => n.tagName === 'script').length, 0);

  const links = findAll(root, n => n.tagName === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(OjMarkdown.isSafeUrl('javascript:alert(1)'), false);
  assert.equal(OjMarkdown.isSafeUrl('https://qwen.ai'), true);
  assert.equal(findAll(root, n => n.className === 'md-table-wrap').length, 1);
});

test('never hangs on fenced code with metadata, inline triple backticks, or empty heading markers', () => {
  const nastyInputs = [
    '```js title="app.js"\nconst x = 1;\n```',
    '```ts:src/app.ts\nexport const y = 2;\n```',
    '```inline```',
    '# ',
    '###   ',
    '```unclosed\nline 1\nline 2',
    '> Цитата\n>\n> **жирный**\n\n---\n\n1. Первый\n2. Второй',
  ];
  for (const input of nastyInputs) {
    const root = new MockNode('div');
    root.appendChild(OjMarkdown.render(input, { doc: mockDoc }));
    assert.ok(root.children.length >= 1, `Expected rendered output for: ${input}`);
  }
});
