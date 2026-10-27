import type { MeetingSession } from '../types/meeting';
import { compactMindMap } from './mindMap';

export function applyRecoveredStructure(session: MeetingSession, data: any): MeetingSession {
  if (!Array.isArray(data?.sections) || !Array.isArray(data?.mindMapNodes) || !Array.isArray(data?.todos)) throw new Error('整理結果不完整，逐字稿已保留');
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  return {
    ...session,
    title: session.title.replace('・待整理', ''),
    recoveryStatus: 'complete',
    notes: data.sections.filter((n: any) => n && typeof n.topic === 'string').map((n: any) => ({
      id: n.id || crypto.randomUUID(), topic: n.topic, summary: n.summary || '',
      keyDecisions: Array.isArray(n.keyDecisions) ? n.keyDecisions : [], updatedAt: time,
    })),
    mindMapNodes: compactMindMap(data.mindMapNodes),
    todos: data.todos.filter((t: any) => t && typeof t.task === 'string').map((t: any) => ({
      id: t.id || crypto.randomUUID(), task: t.task, assignee: t.assignee || '待指派',
      priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
      dueDate: t.dueDate || undefined, completed: false, createdAt: time,
    })),
  };
}
