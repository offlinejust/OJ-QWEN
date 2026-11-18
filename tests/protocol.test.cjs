const test = require('node:test');
const assert = require('node:assert/strict');
const OjProtocol = require('../extension/lib/protocol.js');

test('parses fenced, raw, and line-numbered OJ_FILES_REPLY envelopes', () => {
  const turn = '11111111-2222-3333-4444-555555555555';

  const fenced = '```\nOJ_FILES_REPLY\n' + JSON.stringify({ turn, type: 'final', summary: 'Готово!' }) + '\nOJ_FILES_END\n```';
  const r1 = OjProtocol.parse(fenced, turn);
  assert.equal(r1.type, 'final');
  assert.equal(r1.summary, 'Готово!');

  const numbered = '1 OJ_FILES_REPLY\n2 ' + JSON.stringify({ turn, type: 'batch', operations: [{ op: 'search', query: 'foo' }] }) + '\n3 OJ_FILES_END';
  const r2 = OjProtocol.parse(numbered, turn);
  assert.equal(r2.type, 'batch');
  assert.equal(r2.operations[0].op, 'search');
});

test('accepts planning, memory, validation, and ask_user operations in batch (up to 8 ops)', () => {
  const turn = 'turn-plan';
  const ops = [
    { op: 'plan_create', goal: 'Build app', steps: [{ id: '1', title: 'Init', objective: 'Init files', approach: 'Create index.js', acceptance: ['index.js exists'] }] },
    { op: 'plan_update', reason: 'Add validation', addSteps: [{ id: '2', title: 'Check', objective: 'Validate', approach: 'validate', acceptance: ['valid'] }] },
    { op: 'plan_accept', stepId: '1', checks: [{ criterion: 'index.js exists', passed: true, evidence: 'Checked via read' }] },
    { op: 'plan_abort', reason: 'Wrong assumption' },
    { op: 'memory_save', key: 'arch', content: 'MVC' },
    { op: 'memory_delete', key: 'arch' },
    { op: 'ask_user', question: 'Which style?', options: ['A', 'B'] },
    { op: 'rmdir', path: 'old', recursive: true },
  ];
  const raw = 'OJ_FILES_REPLY\n' + JSON.stringify({ turn, type: 'batch', operations: ops }) + '\nOJ_FILES_END';
  const parsed = OjProtocol.parse(raw, turn);
  assert.equal(parsed.type, 'batch');
  assert.equal(parsed.operations.length, 8);
});

test('parseDetailed distinguishes broken JSON, other-turn, and invalid ops', () => {
  const turn = 'turn-a';
  const broken = '```\nOJ_FILES_REPLY\n{"turn":"turn-a","type":"final", broken}\nOJ_FILES_END\n```';
  const resBroken = OjProtocol.parseDetailed(broken, turn);
  assert.equal(resBroken.ok, false);
  assert.equal(resBroken.foundEnvelope, true);
  assert.ok(resBroken.reason.includes('Ошибка JSON'));

  const otherTurn = 'OJ_FILES_REPLY\n{"turn":"turn-b","type":"final","summary":"x"}\nOJ_FILES_END';
  const resOther = OjProtocol.parseDetailed(otherTurn, turn);
  assert.equal(resOther.ok, false);
  assert.equal(resOther.reason, 'other-turn');

  const badOp = 'OJ_FILES_REPLY\n{"turn":"turn-a","type":"batch","operations":[{"op":"exec_shell"}]}\nOJ_FILES_END';
  const resBadOp = OjProtocol.parseDetailed(badOp, turn);
  assert.equal(resBadOp.ok, false);
  assert.ok(resBadOp.reason.includes('Недопустимая операция'));
});

test('full protocol reminder triggers on message 1 and every 10th message after', () => {
  assert.equal(OjProtocol.shouldIncludeFullProtocol(0), true);
  assert.equal(OjProtocol.shouldIncludeFullProtocol(1), false);
  assert.equal(OjProtocol.shouldIncludeFullProtocol(9), false);
  assert.equal(OjProtocol.shouldIncludeFullProtocol(10), true);
  assert.equal(OjProtocol.shouldIncludeFullProtocol(11), false);
  assert.equal(OjProtocol.shouldIncludeFullProtocol(20), true);
});

test('compact protocol includes engineering rules when full and stays short otherwise', () => {
  const full = OjProtocol.buildTaskPacket({ turn: 't1', task: 'Fix bug', workspace: { count: 5 }, includeFullProtocol: true });
  const short = OjProtocol.buildTaskPacket({ turn: 't2', task: 'Next task', workspace: { count: 5 }, includeFullProtocol: false });
  const results = OjProtocol.buildResultsPacket({ turn: 't3', results: [{ ok: true }], includeFullProtocol: false });

  assert.ok(full.includes('engineeringRules'));
  assert.ok(full.includes('plan_create'));
  assert.ok(full.length > short.length + 1200);
  assert.ok(results.length < 350);

  const decoded = OjProtocol.decodeTaskPacket(short);
  assert.deepEqual(decoded, { task: 'Next task', turn: 't2' });
});

test('parseDetailed ignores our own outgoing OJ_FILES_BRIDGE packets', () => {
  const packet = OjProtocol.buildTaskPacket({ turn: 't-own', task: 'Hi', workspace: { count: 0 }, includeFullProtocol: true });
  assert.ok(packet.includes('OJ_FILES_REPLY') && packet.includes('OJ_FILES_END'));
  const res = OjProtocol.parseDetailed(packet, 't-own');
  assert.equal(res.ok, false);
  assert.equal(res.foundEnvelope, false);
});

test('token estimator gives sensible values for Cyrillic and code', () => {
  assert.equal(OjProtocol.estimateTokens(''), 0);
  const cyrTokens = OjProtocol.estimateTokens('Привет мир, это тест оценки токенов на русском языке.');
  const codeTokens = OjProtocol.estimateTokens('export function sum(a, b) { return a + b; }');
  assert.ok(cyrTokens > 15 && cyrTokens < 60, `unexpected cyrTokens=${cyrTokens}`);
  assert.ok(codeTokens > 6 && codeTokens < 30, `unexpected codeTokens=${codeTokens}`);
});

test('v1.2.0 audit regressions: OJ_FILES_BRIDGE inside reply, large >95KB payload, trailing text, quoted example before real packet', () => {
  const turn = 'turn-120';

  // 1. Valid reply whose JSON content contains literal "OJ_FILES_BRIDGE" must still parse!
  const selfEdit = '```\nOJ_FILES_REPLY\n' + JSON.stringify({
    turn,
    type: 'batch',
    operations: [{ op: 'create', path: 'protocol.js', text: 'const TAG = "OJ_FILES_BRIDGE TASK";\n' }],
  }) + '\nOJ_FILES_END\n```';
  const r1 = OjProtocol.parseDetailed(selfEdit, turn);
  assert.equal(r1.ok, true);
  assert.equal(r1.reply.operations[0].path, 'protocol.js');

  // 2. Large payload > 95 KB (up to 400 KB) parses cleanly
  const bigText = 'a'.repeat(120_000);
  const bigReply = 'OJ_FILES_REPLY\n' + JSON.stringify({
    turn,
    type: 'batch',
    operations: [{ op: 'create', path: 'big.txt', text: bigText }],
  }) + '\nOJ_FILES_END';
  const r2 = OjProtocol.parseDetailed(bigReply, turn);
  assert.equal(r2.ok, true);
  assert.equal(r2.reply.operations[0].text.length, 120_000);

  // 3. Trailing commentary after OJ_FILES_END and a quoted example earlier in the text
  const messy = [
    'Пример формата:\nOJ_FILES_REPLY\n{"turn":"<turn>","type":"final","summary":"..."}\nOJ_FILES_END',
    '',
    'OJ_FILES_REPLY',
    JSON.stringify({ turn, type: 'final', summary: 'Реальный итог с упоминанием OJ_FILES_BRIDGE' }),
    'OJ_FILES_END',
    'Готово!',
  ].join('\n');
  const r3 = OjProtocol.parseDetailed(messy, turn);
  assert.equal(r3.ok, true);
  assert.equal(r3.reply.summary, 'Реальный итог с упоминанием OJ_FILES_BRIDGE');
});
