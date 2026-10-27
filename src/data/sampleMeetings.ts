import { MeetingSession } from '../types/meeting';

export function createCleanInitialMeetingSession(): MeetingSession {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('zh-TW', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });

  return {
    id: `session-${crypto.randomUUID()}`,
    title: `${dateStr} 即時會議`,
    createdAt: `${dateStr} ${timeStr}`,
    updatedAt: timeStr,
    durationSeconds: 0,
    transcripts: [],
    notes: [],
    mindMapNodes: [
      {
        id: 'root',
        parentId: null,
        label: '會議核心主題',
        category: 'root',
        notes: '點擊此卡片或在左側收音/輸入發言，系統將自動圍繞核心主題建立心智圖分支。',
      },
    ],
    todos: [],
    hasLocalBackup: false,
  };
}
