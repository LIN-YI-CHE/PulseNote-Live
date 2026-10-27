import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverRecording, structureTranscript } from '../server/recovery';
import { applyRecoveredStructure } from '../src/utils/recovery';
import { createCleanInitialMeetingSession } from '../src/data/sampleMeetings';

const data = { sections: [{ id: 'n1', topic: '合成實驗', summary: '星期五完成實驗', keyDecisions: [] }], mindMapNodes: [{ id: 'root', parentId: 'NONE', label: '實驗' }], todos: [{ id: 't1', task: '完成實驗', assignee: '待指派', priority: 'medium' }] };
const options = (ai: any, events: any[]) => ({ getAI: () => ai, transcribeModel: 'test-transcribe', textModel: 'test-text', schema: {}, emit: (event: any) => events.push(event) });

test('recording recovery emits the transcript before structured results', async () => {
  const events: any[] = [], requests: any[] = [];
  const ai = { models: { generateContent: async (request: any) => { requests.push(request); return { text: requests.length === 1 ? '星期五完成實驗' : JSON.stringify(data) }; } } };
  const result = await recoverRecording(Buffer.from('synthetic-audio'), 'audio/webm', '測試', options(ai, events));
  assert.equal(result.transcript, '星期五完成實驗');
  assert.deepEqual(events.map(e => e.type), ['progress', 'transcript', 'progress', 'result']);
  assert.equal(requests[0].contents.parts[0].inlineData.mimeType, 'audio/webm');
  assert.ok(requests[1].contents.includes(result.transcript));
  assert.equal(result.data.mindMapNodes[0].parentId, null);
});

test('structure failure preserves the already emitted transcript for retry', async () => {
  const events: any[] = []; let calls = 0;
  const ai = { models: { generateContent: async () => { if (++calls === 2) throw new Error('temporary model failure'); return { text: '保留這段真實來源' }; } } };
  const result = await recoverRecording(Buffer.from('audio'), 'audio/wav', '測試', options(ai, events));
  assert.equal(result.transcript, '保留這段真實來源');
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).stage, 'structuring');
  assert.equal(events.at(-1).transcriptRetained, true);
  assert.ok(events.some(e => e.type === 'transcript'));
});

test('long recording uses Files API and deletes its temporary cloud file', async () => {
  const events: any[] = [], uploads: any[] = [], requests: any[] = [], deleted: any[] = [];
  const ai = {
    files: { upload: async (request: any) => { uploads.push(request); return { name: 'files/synthetic', uri: 'test://synthetic', state: 'ACTIVE', mimeType: 'audio/webm' }; }, delete: async (request: any) => deleted.push(request) },
    models: { generateContent: async (request: any) => { requests.push(request); return { text: requests.length === 1 ? '長錄音測試' : JSON.stringify(data) }; } },
  };
  await recoverRecording(Buffer.alloc(15 * 1024 * 1024), 'audio/webm', '測試', options(ai, events));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].file.size, 15 * 1024 * 1024);
  assert.equal(requests[0].contents.parts[0].fileData.fileUri, 'test://synthetic');
  assert.deepEqual(deleted, [{ name: 'files/synthetic' }]);
});

test('a rejected long recording is cleaned up and never sent for transcription', async () => {
  const events: any[] = []; let deleted = false; let generated = false;
  const ai = { files: { upload: async () => ({ name: 'files/rejected', state: 'FAILED' }), delete: async () => { deleted = true; } }, models: { generateContent: async () => { generated = true; } } };
  const result = await recoverRecording(Buffer.alloc(15 * 1024 * 1024), 'audio/webm', '測試', options(ai, events));
  assert.equal(generated, false); assert.equal(deleted, true); assert.ok(result.error);
});

test('empty transcription produces no meeting structure', async () => {
  const events: any[] = []; let calls = 0;
  await recoverRecording(Buffer.from('silence'), 'audio/wav', '測試', options({ models: { generateContent: async () => { calls++; return { text: '' }; } } }, events));
  assert.equal(calls, 1); assert.equal(events.some(e => e.type === 'result' || e.type === 'transcript'), false);
  assert.equal(events.at(-1).stage, 'transcribing');
});

test('retrying structure uses text only and rejects incomplete results', async () => {
  const requests: any[] = [];
  const ai = { models: { generateContent: async (request: any) => { requests.push(request); return { text: JSON.stringify(data) }; } } };
  await structureTranscript('已保留的逐字稿', '測試', options(ai, []));
  assert.equal(requests.length, 1); assert.equal(requests[0].model, 'test-text');
  assert.equal(typeof requests[0].contents, 'string');
  await assert.rejects(() => structureTranscript('', '測試', options(ai, [])), /缺少/);
  await assert.rejects(() => structureTranscript('來源', '測試', options({ models: { generateContent: async () => ({ text: '{}' }) } }, [])), /不完整/);
});

test('applying recovery keeps original provenance and transcript', () => {
  const original = createCleanInitialMeetingSession();
  original.title = '測試（錄音重建・待整理）'; original.sourceMeetingId = 'source-meeting'; original.sourceRecordingName = 'meeting.webm';
  original.transcripts = [{ id: 't', speaker: '錄音轉錄', text: '星期五完成實驗', timestamp: '12:00', isFinal: true }];
  const recovered = applyRecoveredStructure(original, data);
  assert.equal(recovered.sourceMeetingId, 'source-meeting');
  assert.equal(recovered.sourceRecordingName, 'meeting.webm');
  assert.deepEqual(recovered.transcripts, original.transcripts);
  assert.equal(recovered.recoveryStatus, 'complete');
  assert.equal(recovered.title, '測試（錄音重建）');
  assert.equal(original.title, '測試（錄音重建・待整理）');
  assert.equal(recovered.todos[0].completed, false);
});
