import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactMindMap } from '../src/utils/mindMap';
import { createCleanInitialMeetingSession as createEmptySession } from '../src/data/sampleMeetings';
import type { MindMapNode } from '../src/types/meeting';

test('new meetings contain no demonstration content', () => {
  const meeting = createEmptySession();
  assert.equal(meeting.transcripts.length, 0);
  assert.equal(meeting.notes.length, 0);
  assert.equal(meeting.todos.length, 0);
  assert.equal(meeting.mindMapNodes.length, 1);
  assert.notEqual(meeting.id, createEmptySession().id);
  assert.ok(meeting.createdAt.startsWith(String(new Date().getFullYear())));
});

test('mind maps cap width and depth without discarding details', () => {
  const input: MindMapNode[] = [{ id: 'root', parentId: null, label: '測試會議' }];
  for (let i = 0; i < 7; i++) {
    input.push({ id: `t${i}`, parentId: 'root', label: `主題${i}` });
    for (let j = 0; j < 9; j++) input.push({ id: `d${i}-${j}`, parentId: `t${i}`, label: `事實${i}-${j}` });
    input.push({ id: `deep${i}`, parentId: `d${i}-0`, label: `深入事實${i}` });
  }
  const output = compactMindMap(input);
  const topics = output.filter(n => n.parentId === 'root');
  assert.equal(topics.length, 4);
  assert.equal(output.filter(n => !n.parentId).length, 1);
  for (const topic of topics) assert.ok(output.filter(n => n.parentId === topic.id).length <= 5);
  for (const node of output) if (node.parentId !== 'root' && node.parentId) assert.ok(topics.some(t => t.id === node.parentId));
  const retained = JSON.stringify(output);
  for (const node of input) assert.ok(retained.includes(node.label), node.label);
  assert.deepEqual(compactMindMap(output), output);
});

test('cycles and orphan parents cannot crash layout', () => {
  const output = compactMindMap([
    { id: 'root', parentId: null, label: '會議' },
    { id: 'a', parentId: 'b', label: '循環甲' },
    { id: 'b', parentId: 'a', label: '循環乙' },
    { id: 'c', parentId: 'missing', label: '遺失父節點' },
  ]);
  assert.equal(output.length, 1);
  for (const text of ['循環甲', '循環乙', '遺失父節點']) assert.ok(output[0].notes?.includes(text));
});

test('duplicate topic titles merge and keep both sets of children', () => {
  const output = compactMindMap([
    { id: 'root', parentId: null, label: '會議' },
    { id: 'a', parentId: 'root', label: '進度' },
    { id: 'b', parentId: 'root', label: '進度' },
    { id: 'c', parentId: 'a', label: '第一項' },
    { id: 'd', parentId: 'b', label: '第二項' },
  ]);
  assert.equal(output.filter(n => n.parentId === 'root').length, 1);
  assert.equal(output.filter(n => n.parentId === 'a').length, 2);
});
