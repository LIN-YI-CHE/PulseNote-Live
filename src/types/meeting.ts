export interface TranscriptEntry {
  id: string;
  speaker: string;
  text: string;
  timestamp: string;
  isFinal?: boolean;
}

export interface NoteSection {
  id: string;
  topic: string;
  summary: string;
  keyDecisions: string[];
  updatedAt: string;
}

export interface MindMapNode {
  id: string;
  parentId: string | null;
  label: string;
  category?: 'root' | 'topic' | 'decision' | 'action' | 'detail';
  notes?: string;
  collapsed?: boolean;
}

export interface TodoItem {
  id: string;
  task: string;
  assignee: string;
  priority: 'high' | 'medium' | 'low';
  dueDate?: string;
  completed: boolean;
  createdAt: string;
}

export interface MeetingSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  transcripts: TranscriptEntry[];
  notes: NoteSection[];
  mindMapNodes: MindMapNode[];
  todos: TodoItem[];
  backupAudioBlobUrl?: string;
  hasLocalBackup?: boolean;
}

export interface LiveToolSyncPayload {
  toolName: 'syncMeetingNotes' | 'syncMindMapNodes' | 'syncTodoItems';
  args: any;
  timestamp: string;
}

export interface ToolCallInspectorItem {
  id: string;
  toolName: string;
  timestamp: string;
  args: any;
  callId?: string;
}
