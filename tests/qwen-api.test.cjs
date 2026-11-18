const test = require('node:test');
const assert = require('node:assert/strict');
const OjQwenApi = require('../extension/lib/qwen-api.js');
const OjProtocol = require('../extension/lib/protocol.js');

test('parses Qwen v2 projects payload variants', () => {
  const res1 = OjQwenApi.parseProjectsPayload({
    success: true,
    data: [
      { id: 'p-1', name: 'OJ-QWEN', updated_at: 100 },
      { id: 'p-2', name: 'Grisea', updated_at: 200 },
    ],
  });
  assert.equal(res1.length, 2);
  assert.deepEqual(res1.map(p => p.name), ['OJ-QWEN', 'Grisea']);

  const res2 = OjQwenApi.parseProjectsPayload({
    data: { items: [{ project_id: 'p-3', title: 'TestProj' }] },
  });
  assert.equal(res2.length, 1);
  assert.equal(res2[0].id, 'p-3');
  assert.equal(res2[0].name, 'TestProj');
});

test('listProjectChats paginates across multiple pages until empty', async () => {
  const pages = {
    1: { success: true, data: [{ id: 'c1', title: 'Chat 1' }, { id: 'c2', title: 'Chat 2' }] },
    2: { success: true, data: [{ id: 'c3', title: 'Chat 3' }, { id: 'c4', title: 'Chat 4' }] },
    3: { success: true, data: [{ id: 'c5', title: 'Chat 5' }] },
    4: { success: true, data: [] },
  };
  const calls = [];
  const fakeFetch = async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, async text() { return JSON.stringify(pages[page] || { data: [] }); } };
  };

  const chats = await OjQwenApi.listProjectChats('proj-123', { fetchImpl: fakeFetch });
  assert.equal(chats.length, 5);
  assert.deepEqual(chats.map(c => c.key), ['c:c1', 'c:c2', 'c:c3', 'c:c4', 'c:c5']);
  assert.equal(calls.length, 3); // Stops early when page 3 < page 1 size
});

test('parses history.messages tree with think/answer content_list and builds clean transcript + tokens', () => {
  const turn = '11111111-2222-3333-4444-555555555555';
  const taskPacket = OjProtocol.buildTaskPacket({ turn, task: 'Проверь README', workspace: { count: 2 }, includeFullProtocol: true });
  const batchReply = '```\nOJ_FILES_REPLY\n' + JSON.stringify({ turn, type: 'batch', operations: [{ op: 'list' }] }) + '\nOJ_FILES_END\n```';
  const resultsPacket = OjProtocol.buildResultsPacket({ turn: 't2', results: [{ files: ['README.md'] }] });
  const finalReply = '```\nOJ_FILES_REPLY\n' + JSON.stringify({ turn: 't2', type: 'final', summary: 'Всё проверено.' }) + '\nOJ_FILES_END\n```';

  const payload = {
    success: true,
    data: {
      id: 'chat-99',
      title: 'Тест',
      chat: {
        history: {
          currentId: 'm4',
          messages: {
            m1: { id: 'm1', parentId: null, role: 'user', content: taskPacket },
            m2: {
              id: 'm2',
              parentId: 'm1',
              role: 'assistant',
              content_list: [
                { phase: 'think', content: 'Скрытые размышления модели' },
                { phase: 'answer', content: batchReply },
              ],
            },
            m3: { id: 'm3', parentId: 'm2', role: 'user', content: resultsPacket },
            m4: {
              id: 'm4',
              parentId: 'm3',
              role: 'assistant',
              content_list: [
                { phase: 'think', content: 'Ещё размышления' },
                { phase: 'answer', content: finalReply },
              ],
            },
          },
        },
      },
    },
  };

  const detail = OjQwenApi.parseChatDetailPayload(payload);
  assert.equal(detail.rawMessages.length, 4);
  assert.equal(detail.rawMessages[1].thinking, 'Скрытые размышления модели');

  const built = OjQwenApi.buildTranscriptFromDetail(detail, OjProtocol);
  assert.equal(built.protocolMessages, 2);
  assert.equal(built.transcript.length, 2);
  assert.deepEqual(built.transcript[0], { role: 'user', text: 'Проверь README', unformatted: false, turn });
  assert.deepEqual(built.transcript[1], { role: 'qwen', text: 'Всё проверено.', unformatted: false, turn: 't2' });
  assert.ok(built.contextWindow.used > 100);
  assert.equal(built.contextWindow.limit, 1_000_000);
});

test('v1.2.0 audit regressions: preserves normal messages mentioning bridge markers & guards parentId cycles', () => {
  const payload = {
    data: {
      id: 'c-cycle',
      title: 'Cycle test',
      chat: {
        history: {
          currentId: 'm2',
          messages: {
            m1: { id: 'm1', parentId: 'm2', role: 'user', content: 'Почему в коде есть OJ_FILES_BRIDGE TASK?' },
            m2: { id: 'm2', parentId: 'm1', role: 'assistant', content: 'Потому что OJ_FILES_REPLY и OJ_FILES_END используются в протоколе.' },
          },
        },
      },
    },
  };
  const detail = OjQwenApi.parseChatDetailPayload(payload);
  assert.equal(detail.rawMessages.length, 2);
  const built = OjQwenApi.buildTranscriptFromDetail(detail, OjProtocol);
  assert.equal(built.transcript.length, 2);
  assert.equal(built.transcript[0].role, 'user');
  assert.equal(built.transcript[1].role, 'qwen');
});
