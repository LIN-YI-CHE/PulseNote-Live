import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { attachLiveSession } from '../server/liveSession';

const declarations = [
  { name: 'syncMeetingNotes', parameters: { properties: { sections: { type: 'ARRAY', items: { type: 'OBJECT' } } } } },
  { name: 'syncMindMapNodes', parameters: { properties: { nodes: { type: 'ARRAY', items: { type: 'OBJECT' } } } } },
  { name: 'syncTodoItems', parameters: { properties: { todos: { type: 'ARRAY', items: { type: 'OBJECT' } } } } },
];
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t: any, getAI: () => any) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', client => attachLiveSession(client, { getAI, model: 'test-live', textModel: 'test-text', instruction: '只依逐字稿', declarations }));
  await once(wss, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as any).port}`);
  const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  t.after(async () => { ws.close(); for (const client of wss.clients) client.close(); await new Promise<void>(resolve => wss.close(() => resolve())); });
  const send = (data: any) => ws.send(JSON.stringify(data));
  const waitFor = async (predicate: (msg: any) => boolean, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = messages.find(predicate); if (result) return result; await pause(10); }
    assert.fail(`Expected response not received: ${JSON.stringify(messages)}`);
  };
  return { ws, send, messages, waitFor };
}

test('transport open is not readiness; PCM, transcript and three tool responses cross the bridge', async t => {
  let connectOptions: any;
  let release: (value: any) => void = () => {};
  const audio: any[] = [], acknowledgements: any[] = [];
  const upstream = { sendRealtimeInput: (msg: any) => audio.push(msg), sendToolResponse: (msg: any) => acknowledgements.push(msg), close() {} };
  const f = await fixture(t, () => ({ live: { connect: (options: any) => { connectOptions = options; options.callbacks.onopen(); return new Promise(resolve => { release = resolve; }); } } }));
  f.send({ type: 'session_start' });
  await f.waitFor(m => m.status === 'connecting');
  assert.equal(f.messages.some(m => m.status === 'connected'), false);
  release(upstream);
  await f.waitFor(m => m.status === 'connected');
  f.send({ type: 'audio', audio: 'AACAPw==' });
  f.send({ type: 'audio_end' });
  await pause();
  assert.deepEqual(audio, [{ audio: { data: 'AACAPw==', mimeType: 'audio/pcm;rate=16000' } }, { audioStreamEnd: true }]);
  connectOptions.callbacks.onmessage({ serverContent: { inputTranscription: { text: '星期五交付測試報告。', finished: true } }, toolCall: { functionCalls: [
    { id: '1', name: 'syncMeetingNotes', args: { sections: [{ id: 'n1', topic: '交付', summary: '星期五交付測試報告。', keyDecisions: [] }] } },
    { id: '2', name: 'syncMindMapNodes', args: { nodes: [{ id: 'root', label: '交付', parentId: 'NONE' }] } },
    { id: '3', name: 'syncTodoItems', args: { todos: [{ id: 'a1', task: '交付測試報告', assignee: '待指派' }] } },
  ] } });
  await f.waitFor(m => m.toolName === 'syncTodoItems');
  assert.ok(f.messages.some(m => m.type === 'input_transcription' && m.text === '星期五交付測試報告。'));
  assert.ok(f.messages.some(m => m.type === 'turn_complete'));
  assert.equal(acknowledgements[0].functionResponses.length, 3);
  assert.ok(acknowledgements[0].functionResponses.every((r: any) => r.response.synced));
});

test('no evidence means no invented notes, tasks or nudges', async t => {
  let callbacks: any;
  const requests: any[] = [];
  const f = await fixture(t, () => ({ live: { connect: async (o: any) => { callbacks = o.callbacks; return { close() {}, sendClientContent: (msg: any) => requests.push(msg), sendToolResponse() {} }; } } }));
  f.send({ type: 'session_start' }); await f.waitFor(m => m.status === 'connected');
  callbacks.onmessage({ toolCall: { functionCalls: [{ id: 'fake', name: 'syncMeetingNotes', args: { sections: [{ topic: '虛構範例' }] } }] } });
  f.send({ type: 'nudge_sync' }); await pause();
  assert.equal(f.messages.some(m => m.type === 'tool_call'), false);
  assert.equal(requests.length, 0);
});

test('missing credentials stay degraded and manual input never invokes canned heuristics', async t => {
  let attempts = 0;
  const f = await fixture(t, () => { attempts++; throw new Error('Missing GEMINI_API_KEY'); });
  f.send({ type: 'session_start' }); await f.waitFor(m => m.status === 'degraded');
  f.send({ type: 'reconnect_live' }); await pause();
  assert.equal(attempts, 2, 'a synchronous setup failure must not leave a permanently pending promise');
  f.send({ type: 'text_input', text: '請確認明天的實驗結果。' });
  await f.waitFor(m => m.type === 'error' && m.message.includes('整理失敗'));
  assert.equal(f.messages.some(m => m.status === 'connected'), false);
  assert.equal(f.messages.some(m => m.type === 'tool_call'), false);
});

test('failed Live uses real text-model response for supplied transcript', async t => {
  const requests: any[] = [];
  const data = { sections: [{ id: 'n1', topic: '實驗', summary: '明天確認實驗結果', keyDecisions: [] }], nodes: [], todos: [] };
  const f = await fixture(t, () => ({ live: { connect: async () => { throw new Error('Live unavailable'); } }, models: { generateContent: async (request: any) => { requests.push(request); return { text: JSON.stringify(data) }; } } }));
  f.send({ type: 'session_start' }); await f.waitFor(m => m.status === 'degraded');
  f.send({ type: 'text_input', text: '明天確認實驗結果' });
  const response = await f.waitFor(m => m.toolName === 'syncMeetingNotes');
  assert.deepEqual(response.args.sections, data.sections);
  assert.ok(requests[0].contents.includes('明天確認實驗結果'));
  assert.equal(requests[0].model, 'test-text');
});

test('manual reconnect ignores old callbacks and resumes with server-issued handle', async t => {
  const connections: any[] = [];
  const f = await fixture(t, () => ({ live: { connect: async (o: any) => { connections.push(o); return { close() { o.callbacks.onclose({ code: 1000 }); } }; } } }));
  f.send({ type: 'session_start' }); await f.waitFor(m => m.status === 'connected');
  connections[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'test-handle' } });
  f.send({ type: 'reconnect_live' }); await pause(60);
  assert.equal(connections.length, 2);
  assert.equal(connections[1].config.sessionResumption.handle, 'test-handle');
  connections[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: 'stale' } } });
  await pause(); assert.equal(f.messages.some(m => m.text === 'stale'), false);
});

test('disconnect while upstream connects closes the late session', async t => {
  let release: (value: any) => void = () => {};
  let closed = 0;
  const f = await fixture(t, () => ({ live: { connect: () => new Promise(resolve => { release = resolve; }) } }));
  f.send({ type: 'session_start' }); await f.waitFor(m => m.status === 'connecting');
  f.ws.close(); await once(f.ws, 'close'); await pause();
  release({ close() { closed++; } }); await pause();
  assert.equal(closed, 1);
});

test('transcript is structured even if the Live model never calls its tools', async t => {
  let callbacks: any;
  let calls = 0;
  const f = await fixture(t, () => ({
    live: { connect: async (o: any) => { callbacks = o.callbacks; return { close() {}, sendClientContent() {} }; } },
    models: { generateContent: async () => { calls++; return { text: JSON.stringify({ sections: [{ id: 'n', topic: '真實發言', summary: '保留此項實驗結果', keyDecisions: [] }], nodes: [], todos: [] }) }; } },
  }));
  f.send({ type: 'session_start' }); await f.waitFor(m => m.status === 'connected');
  callbacks.onmessage({ serverContent: { inputTranscription: { text: '保留此項實驗結果', finished: true } } });
  await f.waitFor(m => m.toolName === 'syncMeetingNotes', 10000);
  assert.equal(calls, 1);
});
