import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  FileDown,
  FolderClock,
  Plus,
  Trash2,
  Edit3,
  Check,
  AlertCircle,
  VolumeX,
  Download,
  Code2,
  Sparkles,
  Upload,
  X,
  ShieldCheck,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Copy,
  MessageSquare,
} from 'lucide-react';
import {
  MeetingSession,
  MindMapNode,
  NoteSection,
  TodoItem,
  ToolCallInspectorItem,
} from './types/meeting';
import { createCleanInitialMeetingSession } from './data/sampleMeetings';
import { compactMindMap } from './utils/mindMap';
import { saveAudioChunk, listRecordings, readRecording } from './utils/audioStorage';
import { RecordingRecovery } from './components/RecordingRecovery';
import { MindMapCanvas } from './components/MindMapCanvas';
import { NotesColumn } from './components/NotesColumn';
import { TodoColumn } from './components/TodoColumn';
import {
  generateMeetingMarkdown,
  downloadTextFile,
} from './utils/exportUtils';

const STORAGE_KEY = 'pulsenote_live_sessions_v1';

function float32ToPcm16Base64(float32Array: Float32Array): string {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function downsampleAndConvertToPcm16(
  inputBuffer: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): string {
  if (inputSampleRate === targetSampleRate) {
    return float32ToPcm16Base64(inputBuffer);
  }
  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.floor(inputBuffer.length / ratio));
  const buffer = new ArrayBuffer(newLength * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < newLength; i++) {
    const startIdx = Math.floor(i * ratio);
    const endIdx = Math.min(inputBuffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = startIdx; j < endIdx; j++) {
      sum += inputBuffer[j];
      count++;
    }
    const avg = count > 0 ? sum / count : (inputBuffer[startIdx] || 0);
    const s = Math.max(-1, Math.min(1, avg));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export default function App() {
  // Load persisted sessions from localStorage (filtering out legacy mock templates)
  const [sessions, setSessions] = useState<MeetingSession[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter(s => s && typeof s.id === 'string' && !s.id.startsWith('session-default-') && !s.title?.includes('跨部門產品與架構雙週例會'));
          if (valid.length !== parsed.length) localStorage.setItem(`${STORAGE_KEY}_legacy_backup`, saved);
          if (valid.length) return valid.map(s => ({ ...s, backupAudioBlobUrl: undefined, hasLocalBackup: false }));
        }
      }
    } catch {
      // fallback
    }
    return [createCleanInitialMeetingSession()];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => sessions[0].id
  );
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState<boolean>(false);
  const [showInspectorDrawer, setShowInspectorDrawer] = useState<boolean>(false);
  const [showCatchUpModal, setShowCatchUpModal] = useState<boolean>(false);
  const [showRecordingRecovery, setShowRecordingRecovery] = useState(false);
  const [showCorrectionModal, setShowCorrectionModal] = useState<boolean>(false);
  const [correctionInstruction, setCorrectionInstruction] = useState<string>('');
  const [isCorrecting, setIsCorrecting] = useState<boolean>(false);
  const [correctionToast, setCorrectionToast] = useState<string | null>(null);
  const [isListeningVoiceCorrection, setIsListeningVoiceCorrection] = useState<boolean>(false);
  const voiceRecognitionRef = useRef<any>(null);

  // Catch-up / Reconstruction modal state
  const [catchUpText, setCatchUpText] = useState<string>('');
  const [isCatchingUp, setIsCatchingUp] = useState<boolean>(false);
  const [catchUpError, setCatchUpError] = useState<string | null>(null);

  // Title inline editing
  const [isEditingTitle, setIsEditingTitle] = useState<boolean>(false);
  const [titleInput, setTitleInput] = useState<string>('');

  // Gemini 3.8 Live WebSocket & Microphone state
  const [isLiveRecording, setIsLiveRecording] = useState<boolean>(false);
  const [wsStatus, setWsStatus] = useState<
    'disconnected' | 'connecting' | 'connected' | 'degraded'
  >('disconnected');
  const [livePartialTranscript, setLivePartialTranscript] =
    useState<string>('');
  const [micLevel, setMicLevel] = useState<number>(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [lastToolSyncInfo, setLastToolSyncInfo] = useState<string>(
    '就緒 · 支援長會議無縫滾動連線'
  );
  const [isStartingMic, setIsStartingMic] = useState(false);
  const isStartingMicRef = useRef(false);
  const [isConvergingMindMap, setIsConvergingMindMap] = useState<boolean>(false);
  const [isConvergingNotes, setIsConvergingNotes] = useState<boolean>(false);
  const lastToolCallTimestampRef = useRef<number>(Date.now());

  // Draggable Column Widths State (Left: Notes, Right: Todos, Center: MindMap auto fills)
  const [leftColWidthPercent, setLeftColWidthPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('pulsenote_left_col_width');
      return saved ? Math.max(18, Math.min(55, parseFloat(saved))) : 33;
    } catch {
      return 33;
    }
  });

  const [rightColWidthPercent, setRightColWidthPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('pulsenote_right_col_width');
      return saved ? Math.max(16, Math.min(42, parseFloat(saved))) : 24;
    } catch {
      return 24;
    }
  });

  const [isRightColCollapsed, setIsRightColCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pulsenote_right_col_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const [isDraggingLeftResizer, setIsDraggingLeftResizer] = useState<boolean>(false);
  const [isDraggingRightResizer, setIsDraggingRightResizer] = useState<boolean>(false);
  const workspaceContainerRef = useRef<HTMLDivElement | null>(null);

  // Global mousemove/mouseup listener for column resizing
  useEffect(() => {
    if (!isDraggingLeftResizer && !isDraggingRightResizer) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!workspaceContainerRef.current) return;
      const rect = workspaceContainerRef.current.getBoundingClientRect();
      const totalWidth = rect.width;
      if (totalWidth <= 0) return;

      if (isDraggingLeftResizer) {
        const offsetLeft = e.clientX - rect.left;
        const percent = (offsetLeft / totalWidth) * 100;
        const clamped = Math.max(18, Math.min(55, percent));
        setLeftColWidthPercent(clamped);
        try {
          localStorage.setItem('pulsenote_left_col_width', String(clamped));
        } catch {
          // ignore
        }
      } else if (isDraggingRightResizer) {
        const offsetRight = rect.right - e.clientX;
        const percent = (offsetRight / totalWidth) * 100;
        const clamped = Math.max(16, Math.min(42, percent));
        setRightColWidthPercent(clamped);
        try {
          localStorage.setItem('pulsenote_right_col_width', String(clamped));
        } catch {
          // ignore
        }
      }
    };

    const handleMouseUp = () => {
      setIsDraggingLeftResizer(false);
      setIsDraggingRightResizer(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingLeftResizer, isDraggingRightResizer]);

  const [copySuccessBanner, setCopySuccessBanner] = useState<string | null>(null);

  // Auto-sync client sessions to server storage so backend retains meeting data
  useEffect(() => {
    let cancelled = false;
    fetch('/api/sessions').then(async response => {
      if (!response.ok) throw new Error('無法讀取伺服器會議歷史');
      const result = await response.json();
      if (!result.success || !Array.isArray(result.sessions)) throw new Error('會議歷史格式不正確');
      if (cancelled) return;
      setSessions(local => {
        const merged = new Map<string, MeetingSession>();
        for (const session of result.sessions) {
          if (session && typeof session.id === 'string' && !session.id.startsWith('session-default-') &&
            Array.isArray(session.transcripts) && Array.isArray(session.notes) && Array.isArray(session.todos) && Array.isArray(session.mindMapNodes)) {
            merged.set(session.id, { ...session, backupAudioBlobUrl: undefined, hasLocalBackup: false });
          }
        }
        for (const session of local) merged.set(session.id, session);
        return [...merged.values()];
      });
      setSessionsHydrated(true);
    }).catch(error => {
      if (!cancelled) setErrorBanner(`${error.message}；目前保留瀏覽器本機紀錄，暫停覆寫伺服器資料。`);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!sessionsHydrated || sessions.length === 0) return;
    const timer = setTimeout(() => {
      fetch('/api/sessions/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions }),
      }).catch((err) => {
        // background sync warning
        console.warn('Auto-sync to server error:', err);
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [sessions, sessionsHydrated]);

  // Local Audio Backup via MediaRecorder (Safety net for 60+ min meetings)
  const [backupAudioUrl, setBackupAudioUrl] = useState<string | null>(null);
  const [backupAudioExtension, setBackupAudioExtension] = useState('webm');
  const [isBackingUp, setIsBackingUp] = useState(false);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Inspector Logs for Gemini 3.8 Live Tool Calls
  const [inspectorLogs, setInspectorLogs] = useState<ToolCallInspectorItem[]>([]);

  // Refs for callbacks to avoid stale closures (per Live API Rules)
  const wsRef = useRef<WebSocket | null>(null);
  const liveReadyRef = useRef(false);
  const pendingConnectionRef = useRef<Promise<WebSocket> | null>(null);
  const browserSpeechActiveRef = useRef(false);
  const startBrowserRecognitionRef = useRef<(() => void) | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const liveRecognitionRef = useRef<any>(null);

  const activeSessionIdRef = useRef<string>(activeSessionId);
  const partialBufferRef = useRef<string>('');
  const interimSpeechBufferRef = useRef<string>('');
  const interimCommitTimerRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const [speechLang, setSpeechLang] = useState<'zh-TW' | 'en-US'>('zh-TW');
  const speechLangRef = useRef<'zh-TW' | 'en-US'>('zh-TW');
  const timerRef = useRef<number | null>(null);
  const isRecordingRef = useRef<boolean>(false);

  useEffect(() => () => {
    isRecordingRef.current = false;
    liveRecognitionRef.current?.abort();
    voiceRecognitionRef.current?.abort();
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    processorRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    void audioCtxRef.current?.close();
    wsRef.current?.close();
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (interimCommitTimerRef.current) window.clearTimeout(interimCommitTimerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
  }, []);

  useEffect(() => {
    speechLangRef.current = speechLang;
  }, [speechLang]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    isRecordingRef.current = isLiveRecording;
  }, [isLiveRecording]);

  // Client-side auto-sync watchdog: periodic nudge to prevent Gemini Live from stalling
  useEffect(() => {
    if (!isLiveRecording) return;

    const watchdogInterval = window.setInterval(() => {
      const now = Date.now();
      const timeSinceLastToolCall = now - lastToolCallTimestampRef.current;

      // If more than 20 seconds have elapsed without tool calls during recording
      if (timeSinceLastToolCall > 20000) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'nudge_sync' }));
          setLastToolSyncInfo('自動催化即時整理中...');
        }
      }
    }, 10000);

    return () => {
      window.clearInterval(watchdogInterval);
    };
  }, [isLiveRecording]);

  // Persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {
      console.error('Failed to save sessions to localStorage:', e);
    }
  }, [sessions]);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const updateActiveSession = useCallback(
    (updater: (prev: MeetingSession) => MeetingSession) => {
      const targetId = activeSessionIdRef.current;
      const nowStr = new Date().toLocaleTimeString('zh-TW', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
      setSessions((prevList) =>
        prevList.map((s) =>
          s.id === targetId
            ? {
                ...updater(s),
                updatedAt: new Date().toLocaleString('sv-SE'),
              }
            : s
        )
      );
    },
    []
  );

  // Merge tool call payloads from Gemini 3.8 Live into active session state
  const handleLiveToolCall = useCallback(
    (toolName: string, args: any, timestamp: string, callId?: string) => {
      if (!args) return;
      lastToolCallTimestampRef.current = Date.now();

      // Log to Inspector
      setInspectorLogs((prev) => [
        {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          toolName,
          timestamp,
          args,
          callId,
        },
        ...prev.slice(0, 49),
      ]);

      if (toolName === 'syncMeetingNotes' && Array.isArray(args.sections)) {
        updateActiveSession((prev) => {
          const merged = [...prev.notes];
          for (const incoming of args.sections) {
            if (!incoming || !incoming.topic) continue;
            const idx = merged.findIndex(
              (n) => n.id === incoming.id || n.topic === incoming.topic
            );
            const sectionObj: NoteSection = {
              id: incoming.id || `topic-${Date.now().toString().slice(-4)}`,
              topic: incoming.topic,
              summary: incoming.summary || '',
              keyDecisions: Array.isArray(incoming.keyDecisions)
                ? incoming.keyDecisions
                : [],
              updatedAt: timestamp,
            };
            if (idx >= 0) {
              merged[idx] = sectionObj;
            } else {
              merged.push(sectionObj);
            }
          }
          return { ...prev, notes: merged };
        });
        setLastToolSyncInfo(`已同步重點摘要 (${timestamp})`);
      }

      if (toolName === 'syncMindMapNodes' && Array.isArray(args.nodes)) {
        updateActiveSession((prev) => {
          const merged = args.replace ? [] : [...prev.mindMapNodes];
          for (const incoming of args.nodes) {
            if (!incoming || !incoming.label) continue;
            const normalizedParentId =
              !incoming.parentId || incoming.parentId === 'NONE'
                ? null
                : incoming.parentId;
            const nodeObj: MindMapNode = {
              id: incoming.id || `node-${Date.now().toString().slice(-4)}`,
              parentId: incoming.id === 'root' ? null : normalizedParentId,
              label: incoming.label,
              category: incoming.category || 'topic',
              notes: incoming.notes,
            };
            const idx = merged.findIndex((n) => n.id === nodeObj.id);
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], ...nodeObj };
            } else {
              merged.push(nodeObj);
            }
          }
          return { ...prev, mindMapNodes: compactMindMap(merged) };
        });
        setLastToolSyncInfo(`已更新三層心智圖 (${timestamp})`);
      }

      if (toolName === 'syncTodoItems' && Array.isArray(args.todos)) {
        updateActiveSession((prev) => {
          const merged = [...prev.todos];
          for (const incoming of args.todos) {
            if (!incoming || !incoming.task) continue;
            const idx = merged.findIndex(
              (t) => t.id === incoming.id || t.task === incoming.task
            );
            const priorityVal: TodoItem['priority'] =
              incoming.priority === 'high' ||
              incoming.priority === 'medium' ||
              incoming.priority === 'low'
                ? incoming.priority
                : 'medium';
            if (idx >= 0) {
              merged[idx] = {
                ...merged[idx],
                task: incoming.task,
                assignee: incoming.assignee || merged[idx].assignee,
                priority: priorityVal,
                dueDate: incoming.dueDate || merged[idx].dueDate,
              };
            } else {
              merged.unshift({
                id:
                  incoming.id ||
                  `todo-${Date.now().toString().slice(-4)}-${Math.random()
                    .toString(36)
                    .slice(2, 5)}`,
                task: incoming.task,
                assignee: incoming.assignee || '待指派',
                priority: priorityVal,
                dueDate: incoming.dueDate,
                completed: false,
                createdAt: timestamp,
              });
            }
          }
          return { ...prev, todos: merged };
        });
        setLastToolSyncInfo(`已萃取待辦事項 (${timestamp})`);
      }
    },
    [updateActiveSession]
  );

  // Reuse a single connection attempt; report readiness only after upstream setup.
  const ensureLiveWebSocket = useCallback((): Promise<WebSocket> => {
    if (pendingConnectionRef.current) return pendingConnectionRef.current;
    if (wsRef.current?.readyState === WebSocket.OPEN) return Promise.resolve(wsRef.current);
    const sessionId = activeSessionIdRef.current;
    setWsStatus('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live`);
    wsRef.current = ws;
    const current = () => wsRef.current === ws && activeSessionIdRef.current === sessionId;
    const flushTranscript = () => {
      const text = partialBufferRef.current.trim();
      if (!text || !current()) return;
      partialBufferRef.current = '';
      setLivePartialTranscript('');
      updateActiveSession(prev => ({ ...prev, transcripts: [...prev.transcripts, {
        id: `tr-${crypto.randomUUID()}`, speaker: '現場收音', text,
        timestamp: new Date().toLocaleTimeString('zh-TW', { hour12: false }), isFinal: true,
      }] }));
    };
    const fallback = () => {
      liveReadyRef.current = false;
      setWsStatus('degraded');
      audioQueueRef.current = [];
      if (isRecordingRef.current && !browserSpeechActiveRef.current) {
        browserSpeechActiveRef.current = true;
        startBrowserRecognitionRef.current?.();
      }
    };
    const attempt = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        pendingConnectionRef.current = null;
        if (error) reject(error); else resolve(ws);
      };
      const timeout = window.setTimeout(() => {
        if (!current()) return finish(new Error('會議已切換'));
        fallback();
        setErrorBanner('即時 AI 連線逾時；錄音備份持續中，正在嘗試瀏覽器備援辨識。');
        if (ws.readyState === WebSocket.OPEN) finish();
        else { ws.close(); finish(new Error('無法連線到會議伺服器')); }
      }, 12000);
      ws.onopen = () => {
        const session = sessionsRef.current.find(s => s.id === sessionId);
        ws.send(JSON.stringify({ type: 'session_start', nodes: session?.mindMapNodes || [],
          context: JSON.stringify({ title: session?.title, notes: session?.notes, todos: session?.todos }),
          transcript: session?.transcripts.map(t => `${t.speaker}：${t.text}`).join('\n') || '',
        }));
      };
      ws.onmessage = event => {
        if (!current()) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
          if (msg.type === 'session_status') {
            if (msg.status === 'connected') {
              const pendingBrowserText = interimSpeechBufferRef.current.trim();
              if (pendingBrowserText) {
                updateActiveSession(prev => ({ ...prev, transcripts: [...prev.transcripts, {
                  id: `tr-${crypto.randomUUID()}`, speaker: '現場收音', text: pendingBrowserText,
                  timestamp: new Date().toLocaleTimeString('zh-TW', { hour12: false }), isFinal: true,
                }] }));
                ws.send(JSON.stringify({ type: 'text_input', speaker: '現場收音', text: pendingBrowserText }));
              }
              browserSpeechActiveRef.current = false;
              liveRecognitionRef.current?.abort();
              liveRecognitionRef.current = null;
              interimSpeechBufferRef.current = '';
              liveReadyRef.current = true;
              setWsStatus('connected'); setErrorBanner(null);
              if (isRecordingRef.current) for (const audio of audioQueueRef.current.splice(0)) ws.send(JSON.stringify({ type: 'audio', audio }));
              else audioQueueRef.current = [];
              finish();
            } else if (msg.status === 'degraded') { flushTranscript(); fallback(); finish(); }
            else if (msg.status === 'connecting') { liveReadyRef.current = false; setWsStatus('connecting'); }
            if (msg.message) setLastToolSyncInfo(msg.message);
          } else if (msg.type === 'session_rollover') {
            liveReadyRef.current = false; setWsStatus('connecting');
            setLastToolSyncInfo(msg.message || '即時服務正在延續連線…');
          } else if (msg.type === 'input_transcription' && msg.text && !browserSpeechActiveRef.current) {
            partialBufferRef.current += msg.text;
            setLivePartialTranscript(partialBufferRef.current);
          } else if (msg.type === 'turn_complete') { flushTranscript(); }
          else if (msg.type === 'tool_call') handleLiveToolCall(msg.toolName, msg.args, msg.timestamp, msg.callId);
          else if (msg.type === 'error') { setErrorBanner(msg.message); }
        } catch (error) { console.error('Invalid live response:', error); }
      };
      ws.onerror = () => {
        if (current()) fallback();
        finish(new Error('即時連線失敗，請檢查伺服器與網路。'));
      };
      ws.onclose = () => {
        finish(new Error('即時連線已中斷'));
        if (!current()) return;
        flushTranscript(); fallback();
        wsRef.current = null;
        if (isRecordingRef.current) window.setTimeout(() => {
          if (isRecordingRef.current && activeSessionIdRef.current === sessionId) ensureLiveWebSocket().catch(() => {});
        }, 2000);
      };
    });
    pendingConnectionRef.current = attempt;
    return attempt;
  }, [handleLiveToolCall, updateActiveSession]);

  // Late messages from the previous meeting must never mutate a new one.
  useEffect(() => {
    liveReadyRef.current = false;
    pendingConnectionRef.current = null;
    const old = wsRef.current; wsRef.current = null; old?.close();
    audioQueueRef.current = []; partialBufferRef.current = ''; interimSpeechBufferRef.current = '';
    setLivePartialTranscript(''); setWsStatus('disconnected');
    setBackupAudioUrl(sessionsRef.current.find(s => s.id === activeSessionId)?.backupAudioBlobUrl || null);
    let cancelled = false;
    listRecordings(activeSessionId).then(async recordings => {
      if (!recordings[0]) return;
      const blob = await readRecording(recordings[0]);
      if (cancelled) return;
      const url = URL.createObjectURL(blob);
      setBackupAudioUrl(url);
      setBackupAudioExtension(blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm');
      setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, backupAudioBlobUrl: url, hasLocalBackup: true } : s));
    }).catch(error => console.warn('Could not restore local audio:', error));
    return () => { cancelled = true; };
  }, [activeSessionId]);

  // Centralized robust speech committer: writes to transcript list and triggers 3-column structuring
  const commitTranscriptAndStructure = useCallback(
    (speaker: string, text: string) => {
      const clean = text.trim();
      if (!clean) return;

      const nowTime = new Date().toLocaleTimeString('zh-TW', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      // Clear interim states
      interimSpeechBufferRef.current = '';
      partialBufferRef.current = '';
      setLivePartialTranscript('');

      if (interimCommitTimerRef.current) {
        window.clearTimeout(interimCommitTimerRef.current);
        interimCommitTimerRef.current = null;
      }

      // Add to session transcripts with speaker (e.g. "現場收音")
      updateActiveSession((prev) => ({
        ...prev,
        transcripts: [
          ...prev.transcripts,
          {
            id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            speaker,
            text: clean,
            timestamp: nowTime,
            isFinal: true,
          },
        ],
      }));

      // Send to backend to trigger instant structure updates (notes, mind map, todos)
      const targetSessionId = activeSessionIdRef.current;
      ensureLiveWebSocket()
        .then((ws) => {
          if (activeSessionIdRef.current !== targetSessionId || ws.readyState !== WebSocket.OPEN) return;
          setLastToolSyncInfo('Gemini 正在分析對話並即時生成心智圖與重點...');
          ws.send(
            JSON.stringify({
              type: 'text_input',
              speaker,
              text: clean,
            })
          );
        })
        .catch((err) => {
          console.error('Failed to send utterance to Live session:', err);
          setErrorBanner('逐字稿已保留，但尚未送達 AI 整理服務。請恢復連線後重試。');
        });
    },
    [ensureLiveWebSocket, updateActiveSession]
  );

  // Start / Stop Live Microphone Audio Capture (with local MediaRecorder & SpeechRecognition)
  const handleToggleLiveMic = async () => {
    if (isStartingMicRef.current) return;
    if (isLiveRecording) {
      // Stop recording
      setIsLiveRecording(false);
      isRecordingRef.current = false;
      browserSpeechActiveRef.current = false;
      audioQueueRef.current = [];
      setMicLevel(0);
      setIsBackingUp(false);

      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }

      if (interimCommitTimerRef.current) {
        window.clearTimeout(interimCommitTimerRef.current);
        interimCommitTimerRef.current = null;
      }

      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }

      // Stop speech recognition
      if (liveRecognitionRef.current) {
        try {
          liveRecognitionRef.current.abort();
        } catch {}
        liveRecognitionRef.current = null;
      }

      // Stop MediaRecorder and build downloadable local backup audio
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        mediaRecorderRef.current.stop();
      }

      if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }

      // Flush remaining transcript and nudge final sync
      const leftover = interimSpeechBufferRef.current.trim();
      if (leftover) {
        commitTranscriptAndStructure('現場收音', leftover);
      }
      const liveLeftover = partialBufferRef.current.trim();
      if (liveLeftover) {
        partialBufferRef.current = '';
        setLivePartialTranscript('');
        updateActiveSession(prev => ({ ...prev, transcripts: [...prev.transcripts, {
          id: `tr-${crypto.randomUUID()}`, speaker: '現場收音', text: liveLeftover,
          timestamp: new Date().toLocaleTimeString('zh-TW', { hour12: false }), isFinal: true,
        }] }));
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'audio_end' }));
        wsRef.current.send(JSON.stringify({ type: 'nudge_sync' }));
      }
      return;
    }

    // Phase 1: Request Microphone Access
    isStartingMicRef.current = true;
    setIsStartingMic(true);
    let stream: MediaStream;
    try {
      setErrorBanner(null);
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('麥克風需要 HTTPS 或 localhost 安全網址，以及瀏覽器麥克風權限');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;
    } catch (micErr: any) {
      console.error('Microphone access error:', micErr);
      if (
        micErr?.name === 'NotAllowedError' ||
        micErr?.name === 'PermissionDeniedError'
      ) {
        setErrorBanner(
          '瀏覽器尚未授予麥克風權限：請點擊網址列旁的網站設定（鎖頭/麥克風圖示），將麥克風設為「允許」後重試。'
        );
      } else if (
        micErr?.name === 'NotReadableError' ||
        micErr?.name === 'TrackStartError'
      ) {
        setErrorBanner(
          '麥克風裝置已被其他應用程式（如 Google Meet、Zoom 或系統設定）獨佔使用中，請釋放裝置後重試。'
        );
      } else if (
        micErr?.name === 'NotFoundError' ||
        micErr?.name === 'DevicesNotFoundError'
      ) {
        setErrorBanner('電腦未偵測到可用的麥克風輸入裝置，請檢查硬體連接。');
      } else {
        setErrorBanner(`無法啟動麥克風（${micErr?.message || '未知錯誤'}）。可使用「速記補全」或手動輸入發言。`);
      }
      isStartingMicRef.current = false;
      setIsStartingMic(false);
      return;
    }

    // Phase 2: Start Audio Processing & Local Backup & Recognition
    try {
      // Mark capture active before starting callbacks that inspect this flag.
      isRecordingRef.current = true;
      setIsLiveRecording(true);
      // 1. AudioContext initialization with graceful sampleRate fallback and immediate resume
      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      let audioCtx: AudioContext;
      try {
        audioCtx = new AudioContextClass({ sampleRate: 16000 });
      } catch {
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      audioCtxRef.current = audioCtx;

      // 2. Set up Web Audio Analyser and connect to silentGain -> destination to drive hardware audio pull clock
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;

      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;

      source.connect(analyser);
      analyser.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      const timeData = new Uint8Array(analyser.fftSize);
      const updateVolumeMeter = () => {
        if (!isRecordingRef.current) return;
        analyser.getByteTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const val = (timeData[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / timeData.length);
        const level = Math.min(100, Math.round(rms * 450));
        setMicLevel(level);

        animFrameRef.current = requestAnimationFrame(updateVolumeMeter);
      };
      updateVolumeMeter();

      // PCM16 mono at 16 kHz is the Live API input format. The silent output
      // keeps the processing callback running without playing microphone feedback.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = event => {
        if (!isRecordingRef.current || browserSpeechActiveRef.current) return;
        const audio = downsampleAndConvertToPcm16(event.inputBuffer.getChannelData(0), audioCtx.sampleRate);
        const ws = wsRef.current;
        if (liveReadyRef.current && ws?.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify({ type: 'audio', audio }));
          else setErrorBanner('網路傳送速度不足，部分即時音訊延遲；請保留本機錄音備份。');
        } else {
          if (audioQueueRef.current.length >= 320) {
            audioQueueRef.current.shift();
            setErrorBanner('AI 連線尚未恢復；先前音訊保留於錄音備份，請稍後補轉錄。');
          }
          audioQueueRef.current.push(audio);
        }
      };
      source.connect(processor); processor.connect(silentGain);

      // 3. Local WebM Audio Backup via MediaRecorder
      try {
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        const backupSessionId = activeSessionIdRef.current;
        const recordingInfo = { id: crypto.randomUUID(), sessionId: backupSessionId, mimeType: recorder.mimeType, createdAt: new Date().toISOString() };
        let chunkIndex = 0;
        let saveQueue = Promise.resolve();
        recordedChunksRef.current = chunks;
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data);
            const index = chunkIndex++;
            saveQueue = saveQueue.then(() => saveAudioChunk(recordingInfo, index, e.data)).catch(() => {
              setErrorBanner('瀏覽器本機錄音儲存失敗或空間不足，請停止後立即下載錄音備份，避免重新整理頁面。');
            });
          }
        };
        recorder.onstop = async () => {
          if (mediaRecorderRef.current === recorder) setIsBackingUp(false);
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: recorder.mimeType });
            const url = URL.createObjectURL(blob);
            if (activeSessionIdRef.current === backupSessionId) setBackupAudioUrl(url);
            setBackupAudioExtension(blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm');
            setSessions(prev => prev.map(session => session.id === backupSessionId ? { ...session, backupAudioBlobUrl: url, hasLocalBackup: true } : session));
          }
          await saveQueue;
        };
        recorder.start(1000); // 1-second chunks
        mediaRecorderRef.current = recorder;
        setIsBackingUp(true);
      } catch (recErr) {
        console.warn('MediaRecorder not available or failed to start:', recErr);
        setErrorBanner('此瀏覽器無法建立錄音備份；請使用支援錄音的 Chrome 或 Edge，或另行保存音訊。');
      }

      // 4. Browser Native Speech Recognition (Instant local transcription with fresh-instance loop)
      const SpeechRecognitionClass =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;

      if (!SpeechRecognitionClass) {
        startBrowserRecognitionRef.current = () => setErrorBanner(
          '此瀏覽器不支援 Web Speech API。請使用最新版 Google Chrome 或 Microsoft Edge 開啟，即可獲得即時語音辨識功能。您亦可在逐字稿欄位手動輸入或貼上發言。'
        );
      } else {
        let recognitionFailures = 0;
        const startRecognitionInstance = () => {
          if (!isRecordingRef.current || !browserSpeechActiveRef.current) return;
          try {
            const recognition = new SpeechRecognitionClass();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = speechLangRef.current || 'zh-TW';
            recognition.maxAlternatives = 1;

            recognition.onstart = () => {
              setLastToolSyncInfo(`語音收音運作中 (${speechLangRef.current === 'zh-TW' ? '繁中' : '英文'}) · 正在聆聽...`);
            };

            recognition.onresult = (event: any) => {
              if (!browserSpeechActiveRef.current || !isRecordingRef.current) return;
              recognitionFailures = 0;
              let interim = '';
              for (let i = event.resultIndex; i < event.results.length; ++i) {
                const res = event.results[i];
                if (res.isFinal) {
                  const finalUtterance = res[0].transcript.trim();
                  if (finalUtterance) {
                    commitTranscriptAndStructure('現場收音', finalUtterance);
                  }
                } else {
                  interim += res[0].transcript;
                }
              }

              if (interim.trim()) {
                interimSpeechBufferRef.current = interim.trim();
                setLivePartialTranscript(interim.trim());

                if (interimCommitTimerRef.current) {
                  window.clearTimeout(interimCommitTimerRef.current);
                }
              }
            };

            recognition.onerror = (recErr: any) => {
              console.warn('SpeechRecognition event error:', recErr?.error);
              recognitionFailures++;
              if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(recErr?.error) || recognitionFailures >= 3) browserSpeechActiveRef.current = false;
              if (recErr?.error === 'not-allowed') {
                setErrorBanner('瀏覽器麥克風語音辨識權限未開啟或被拒絕，請點擊網址列旁的網站設定將麥克風設為「允許」。');
              } else if (recErr?.error === 'audio-capture') {
                setErrorBanner('找不到可用麥克風，或麥克風正被其他會議軟體獨佔。');
              } else if (recErr?.error === 'network') {
                setErrorBanner('瀏覽器語音辨識服務網路連線受阻（Google Speech Network Error）。若處於企業內網或 VPN 環境可能受限，您可直接於逐字稿輸入框貼上/鍵入發言，系統將立即自動分析！');
              }
            };

            recognition.onend = () => {
              if (browserSpeechActiveRef.current && interimSpeechBufferRef.current.trim()) {
                commitTranscriptAndStructure('現場收音', interimSpeechBufferRef.current.trim());
              }
              // If user is still recording, instantiate a FRESH instance after 150ms!
              if (isRecordingRef.current && browserSpeechActiveRef.current) {
                window.setTimeout(() => {
                  if (isRecordingRef.current) {
                    startRecognitionInstance();
                  }
                }, Math.min(500 * 2 ** recognitionFailures, 4000));
              }
            };

            recognition.start();
            liveRecognitionRef.current = recognition;
          } catch (err: any) {
            console.warn('Could not initialize SpeechRecognition instance:', err);
          }
        };

        startBrowserRecognitionRef.current = startRecognitionInstance;
      }

      setIsLiveRecording(true);
      isRecordingRef.current = true;

      // Start meeting timer
      timerRef.current = window.setInterval(() => {
        updateActiveSession((prev) => ({
          ...prev,
          durationSeconds: prev.durationSeconds + 1,
        }));
      }, 1000);

      // 5. Connect WebSocket in background without blocking mic capture
      ensureLiveWebSocket().then(() => {
        if (!liveReadyRef.current && isRecordingRef.current && !browserSpeechActiveRef.current) {
          browserSpeechActiveRef.current = true;
          startBrowserRecognitionRef.current?.();
        }
      }).catch((err) => {
        console.warn('Live WebSocket connect error (local capture active):', err);
        setErrorBanner(err.message);
      });
    } catch (liveErr: any) {
      console.error('Audio initialization error:', liveErr);
      liveRecognitionRef.current?.abort();
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      processorRef.current?.disconnect();
      processorRef.current = null;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (timerRef.current) window.clearInterval(timerRef.current);
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      setIsBackingUp(false);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      setIsLiveRecording(false);
      isRecordingRef.current = false;
      setErrorBanner(
        `麥克風音訊處理器啟動異常（${liveErr?.message || '未知錯誤'}）。請檢查瀏覽器安全性設定。`
      );
    } finally {
      isStartingMicRef.current = false;
      setIsStartingMic(false);
    }
  };

  const handleSendUtteranceToLive = async (speaker: string, text: string) => {
    commitTranscriptAndStructure(speaker, text);
  };

  const handleDeleteTranscript = (id: string) => {
    updateActiveSession((prev) => ({
      ...prev,
      transcripts: prev.transcripts.filter((t) => t.id !== id),
    }));
  };

  const handleClearTranscripts = () => {
    updateActiveSession((prev) => ({
      ...prev,
      transcripts: [],
    }));
  };

  const handleResetCurrentSession = () => {
    if (isRecordingRef.current || isStartingMicRef.current) {
      setErrorBanner('請先停止收音，再清空或切換會議。');
      return;
    }
    const oldSocket = wsRef.current; wsRef.current = null; oldSocket?.close();
    pendingConnectionRef.current = null; liveReadyRef.current = false;
    partialBufferRef.current = ''; interimSpeechBufferRef.current = ''; audioQueueRef.current = [];
    setLivePartialTranscript(''); setWsStatus('disconnected');
    const nowTime = new Date().toLocaleTimeString('zh-TW', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    updateActiveSession((prev) => ({
      ...prev,
      notes: [],
      transcripts: [],
      mindMapNodes: [
        {
          id: 'root',
          parentId: 'NONE',
          label: prev.title || '會議核心主題',
          category: 'root',
        },
      ],
      todos: [],
      durationSeconds: 0,
      updatedAt: nowTime,
    }));
  };

  const handleNudgeSync = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setLastToolSyncInfo('要求 Gemini 3.8 Live 同步結構...');
      wsRef.current.send(JSON.stringify({ type: 'nudge_sync' }));
    }
  };

  // Catch-up / Reconstruction handler using REST API /api/meeting/restructure
  const handleExecuteCatchUp = async () => {
    if (!catchUpText.trim()) return;
    setIsCatchingUp(true);
    setCatchUpError(null);

    try {
      const response = await fetch('/api/meeting/restructure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingTitle: activeSession.title,
          textContext: catchUpText.trim(),
          existingNotes: activeSession.notes,
          existingMindMap: activeSession.mindMapNodes,
          existingTodos: activeSession.todos,
        }),
      });

      const resData = await response.json();
      if (!response.ok || !resData.success) {
        throw new Error(resData.error || '整理失敗');
      }

      const { sections, mindMapNodes, todos } = resData.data;

      updateActiveSession((prev) => {
        // Append or replace notes
        const nowTime = new Date().toLocaleTimeString('zh-TW', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        });
        const formattedNotes: NoteSection[] = Array.isArray(sections)
          ? sections.map((s: any, idx: number) => ({
              id: s.id || `topic-catchup-${idx}`,
              topic: s.topic,
              summary: s.summary,
              keyDecisions: s.keyDecisions || [],
              updatedAt: nowTime,
            }))
          : prev.notes;

        const formattedNodes: MindMapNode[] = Array.isArray(mindMapNodes)
          ? mindMapNodes.map((n: any) => ({
              id: n.id,
              parentId: !n.parentId || n.parentId === 'NONE' ? null : n.parentId,
              label: n.label,
              category: n.category || 'topic',
              notes: n.notes,
            }))
          : prev.mindMapNodes;

        const formattedTodos: TodoItem[] = Array.isArray(todos)
          ? todos.map((t: any, idx: number) => ({
              id: t.id || `todo-catchup-${idx}`,
              task: t.task,
              assignee: t.assignee || '待指派',
              priority: t.priority || 'medium',
              dueDate: t.dueDate,
              completed: false,
              createdAt: nowTime,
            }))
          : prev.todos;

        return {
          ...prev,
          notes: [...prev.notes, ...formattedNotes],
          mindMapNodes: formattedNodes.length > 0 ? formattedNodes : prev.mindMapNodes,
          todos: [...formattedTodos, ...prev.todos],
        };
      });

      setShowCatchUpModal(false);
      setCatchUpText('');
      setLastToolSyncInfo('已成功補全會議紀錄、心智圖與待辦清單！');
    } catch (err: any) {
      console.error('Catch-up error:', err);
      setCatchUpError(err?.message || '整理失敗，請稍後重試');
    } finally {
      setIsCatchingUp(false);
    }
  };

  // Conversational AI Error Correction Handler
  const handleExecuteCorrection = async (customInstruction?: string) => {
    const text = (customInstruction || correctionInstruction).trim();
    if (!text) return;
    setIsCorrecting(true);

    try {
      const response = await fetch('/api/meeting/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: text,
          session: activeSession,
        }),
      });

      const resData = await response.json();
      if (!response.ok || !resData.success) {
        throw new Error(resData.error || '修正失敗');
      }

      updateActiveSession((prev) => ({
        ...prev,
        notes: Array.isArray(resData.notes) ? resData.notes : prev.notes,
        mindMapNodes: Array.isArray(resData.mindMapNodes)
          ? resData.mindMapNodes
          : prev.mindMapNodes,
        todos: Array.isArray(resData.todos) ? resData.todos : prev.todos,
        transcripts: Array.isArray(resData.transcripts)
          ? resData.transcripts
          : prev.transcripts,
      }));

      const summaryMsg = resData.summary || '已根據您的指令完成錯詞與內容修正！';
      setCorrectionToast(summaryMsg);
      setLastToolSyncInfo(summaryMsg);
      setShowCorrectionModal(false);
      setCorrectionInstruction('');
      setTimeout(() => setCorrectionToast(null), 6000);
    } catch (err: any) {
      console.error('Correction error:', err);
      setErrorBanner(`AI 對話修訂失敗：${err?.message || '請確認網路狀態'}`);
    } finally {
      setIsCorrecting(false);
    }
  };

  const handleToggleVoiceCorrection = () => {
    if (isListeningVoiceCorrection) {
      if (voiceRecognitionRef.current) {
        voiceRecognitionRef.current.stop();
      }
      setIsListeningVoiceCorrection(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setErrorBanner('目前瀏覽器環境未支援即時語音識別，請直接鍵入修正指令。');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'zh-TW';
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onstart = () => {
        setIsListeningVoiceCorrection(true);
      };

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript.trim()) {
          setCorrectionInstruction(transcript);
        }
      };

      recognition.onerror = (event: any) => {
        console.warn('Voice recognition error in correction:', event);
        setIsListeningVoiceCorrection(false);
      };

      recognition.onend = () => {
        setIsListeningVoiceCorrection(false);
      };

      recognition.start();
      voiceRecognitionRef.current = recognition;
    } catch (err: any) {
      console.error('Failed to start voice recognition:', err);
      setIsListeningVoiceCorrection(false);
    }
  };

  const handleCloseCorrectionModal = () => {
    if (voiceRecognitionRef.current) {
      voiceRecognitionRef.current.stop();
    }
    setIsListeningVoiceCorrection(false);
    setShowCorrectionModal(false);
  };

  // Smart Mind Map Convergence Handler
  const handleExecuteConvergeMindMap = async () => {
    if (!activeSession || activeSession.mindMapNodes.length <= 2) return;
    setIsConvergingMindMap(true);

    try {
      setLastToolSyncInfo('Gemini 正在將分散分支聚合為 3~4 個核心主題柱...');
      const response = await fetch('/api/meeting/converge-mindmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingTitle: activeSession.title,
          mindMapNodes: activeSession.mindMapNodes,
          notes: activeSession.notes,
        }),
      });

      const resData = await response.json();
      if (!response.ok || !resData.success) {
        throw new Error(resData.error || '收斂聚合失敗');
      }

      if (Array.isArray(resData.nodes) && resData.nodes.length > 0) {
        updateActiveSession((prev) => ({
          ...prev,
          mindMapNodes: resData.nodes.map((n: any) => ({
            id: n.id,
            parentId:
              !n.parentId || n.parentId === 'NONE' ? null : n.parentId,
            label: n.label,
            category: n.category || 'topic',
            notes: n.notes,
          })),
        }));

        const successMsg = resData.summary || '已成功將心智圖收斂聚合為核心支柱！';
        setCorrectionToast(successMsg);
        setLastToolSyncInfo(successMsg);
        setTimeout(() => setCorrectionToast(null), 5000);
      }
    } catch (err: any) {
      console.error('Convergence error:', err);
      setErrorBanner(`心智圖收斂失敗：${err?.message || '請稍後重試'}`);
    } finally {
      setIsConvergingMindMap(false);
    }
  };

  // Smart Structured Notes Convergence Handler
  const handleExecuteConvergeNotes = async () => {
    if (!activeSession || activeSession.notes.length <= 1) return;
    setIsConvergingNotes(true);

    try {
      setLastToolSyncInfo('Gemini 正在智慧整頓結構化會議紀錄，聚合核心議題與決策...');
      const response = await fetch('/api/meeting/converge-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingTitle: activeSession.title,
          notes: activeSession.notes,
          transcripts: activeSession.transcripts,
          mindMapNodes: activeSession.mindMapNodes,
        }),
      });

      const resData = await response.json();
      if (!response.ok || !resData.success) {
        throw new Error(resData.error || '會議紀錄整頓失敗');
      }

      if (Array.isArray(resData.sections) && resData.sections.length > 0) {
        const nowTime = new Date().toLocaleTimeString('zh-TW', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        updateActiveSession((prev) => ({
          ...prev,
          notes: resData.sections.map((s: any, idx: number) => ({
            id: s.id || `topic-${idx + 1}`,
            topic: s.topic || `核心議題 ${idx + 1}`,
            summary: s.summary || '',
            keyDecisions: Array.isArray(s.keyDecisions) ? s.keyDecisions : [],
            updatedAt: s.updatedAt || nowTime,
          })),
        }));

        const successMsg =
          resData.summary || '已成功將會議紀錄智慧收斂整頓！';
        setCorrectionToast(successMsg);
        setLastToolSyncInfo(successMsg);
        setTimeout(() => setCorrectionToast(null), 5000);
      }
    } catch (err: any) {
      console.error('Notes convergence error:', err);
      setErrorBanner(`會議紀錄收斂失敗：${err?.message || '請稍後重試'}`);
    } finally {
      setIsConvergingNotes(false);
    }
  };

  // Force Unstick & Instant Reconnect Trigger
  const handleForceUnstick = () => {
    setLastToolSyncInfo('正在強制催化輸出與重整連線...');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'reconnect_live',
          contextSummary: `目前會議標題：${activeSession.title}。已記錄 ${activeSession.notes.length} 個章節重點、${activeSession.mindMapNodes.length} 個心智圖節點與 ${activeSession.todos.length} 個待辦事項。`,
        })
      );
      setTimeout(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'nudge_sync' }));
        }
      }, 800);
    } else {
      ensureLiveWebSocket()
        .then((ws) => {
          ws.send(JSON.stringify({ type: 'nudge_sync' }));
        })
        .catch(() => {});
    }
  };

  const handleCreateNewSession = () => {
    if (isRecordingRef.current || isStartingMicRef.current) { setErrorBanner('請先停止收音，再建立新會議。'); return; }
    const newSession = createCleanInitialMeetingSession();
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setBackupAudioUrl(null);
    setShowHistoryDrawer(false);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRecordingRef.current || isStartingMicRef.current) return;
    if (sessions.length <= 1) return;
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (activeSessionId === id) {
      setActiveSessionId(remaining[0].id);
    }
  };

  const handleExportMarkdownReport = () => {
    if (!activeSession) return;
    const md = generateMeetingMarkdown(activeSession);
    downloadTextFile(
      md,
      `${activeSession.title.replace(/\s+/g, '_')}.md`,
      'text/markdown;charset=utf-8'
    );
  };

  const handleAddTodoFromNode = (
    task: string,
    priority: 'high' | 'medium' | 'low' = 'medium'
  ) => {
    if (!activeSession) return;
    const newTodo: TodoItem = {
      id: `todo-${Date.now().toString().slice(-5)}`,
      task,
      assignee: '待指派',
      priority,
      completed: false,
      createdAt: new Date().toLocaleTimeString('zh-TW', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    updateActiveSession((prev) => ({
      ...prev,
      todos: [newTodo, ...prev.todos],
    }));
  };

  const handleCopySessionForDiscussion = (sessionToCopy = activeSession) => {
    if (!sessionToCopy) return;
    let text = `【會議紀錄】：${sessionToCopy.title}\n`;
    text += `【會議時間】：${sessionToCopy.createdAt || sessionToCopy.updatedAt}\n\n`;

    text += `### 一、結構化章節與重點摘要\n`;
    if (sessionToCopy.notes.length === 0) {
      text += `(尚無結構化章節)\n`;
    } else {
      sessionToCopy.notes.forEach((n, idx) => {
        text += `${idx + 1}. 【${n.topic}】\n`;
        text += `   - 重點摘要：${n.summary}\n`;
        if (n.keyDecisions && n.keyDecisions.length > 0) {
          text += `   - 關鍵決策：\n`;
          n.keyDecisions.forEach((dec) => {
            text += `     * ${dec}\n`;
          });
        }
      });
    }

    text += `\n### 二、三層架構心智圖節點\n`;
    sessionToCopy.mindMapNodes.forEach((node) => {
      const parent = sessionToCopy.mindMapNodes.find((p) => p.id === node.parentId);
      text += `- [${node.category || 'node'}] ${node.label} ${
        parent ? `(所屬分支: ${parent.label})` : '(核心根主題)'
      }${node.notes ? ` :: 備忘：${node.notes}` : ''}\n`;
    });

    text += `\n### 三、待辦事項清單\n`;
    if (sessionToCopy.todos.length === 0) {
      text += `(無待辦事項)\n`;
    } else {
      sessionToCopy.todos.forEach((td, idx) => {
        text += `${idx + 1}. [${td.completed ? '已完成' : '進行中'}] ${td.task} (負責: ${
          td.assignee
        }, 優先級: ${td.priority}${td.dueDate ? `, 期限: ${td.dueDate}` : ''})\n`;
      });
    }

    if (sessionToCopy.transcripts.length > 0) {
      text += `\n### 四、即時語音轉錄逐字稿 (${sessionToCopy.transcripts.length} 筆發言)\n`;
      sessionToCopy.transcripts.forEach((tr) => {
        text += `[${tr.timestamp}] ${tr.speaker}: ${tr.text}\n`;
      });
    }

    navigator.clipboard.writeText(text).then(() => {
      setCopySuccessBanner(
        `已成功複製會議完整內容！請直接在對話框中貼上（Ctrl+V），即可與 AI 針對本場會議進行深度討論。`
      );
      setTimeout(() => setCopySuccessBanner(null), 6000);
    });
  };

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#F8FAFC] text-slate-900">
      {/* Strict 3-Zone Top Navigation Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3 bg-white border-b border-slate-200 shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            setShowHistoryDrawer(false);
            setShowInspectorDrawer(false);
          }}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
        >
          PulseNote Live
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-600">
          <a
            href="#workspace"
            onClick={(e) => {
              e.preventDefault();
              setShowHistoryDrawer(false);
              setShowInspectorDrawer(false);
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              !showHistoryDrawer && !showInspectorDrawer
                ? 'text-slate-900 font-semibold'
                : ''
            }`}
          >
            即時工作台
          </a>
          <a
            href="#catchup"
            onClick={(e) => {
              e.preventDefault();
              setShowCatchUpModal(true);
            }}
            className="text-purple-700 hover:text-purple-900 transition-colors whitespace-nowrap shrink-0 font-semibold flex items-center gap-1"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>速記補全重構</span>
          </a>
          <a
            href="#correct"
            onClick={(e) => {
              e.preventDefault();
              setShowCorrectionModal(true);
            }}
            className="text-amber-800 hover:text-amber-950 transition-colors whitespace-nowrap shrink-0 font-semibold flex items-center gap-1"
            title="用自然語言向 AI 下指令修正錯字、人名或心智圖"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>對話修訂錯詞</span>
          </a>
          <a
            href="#history"
            onClick={(e) => {
              e.preventDefault();
              setShowHistoryDrawer((prev) => !prev);
              setShowInspectorDrawer(false);
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              showHistoryDrawer ? 'text-blue-600 font-semibold' : ''
            }`}
          >
            會議歷史 ({sessions.length})
          </a>
          <a
            href="#inspector"
            onClick={(e) => {
              e.preventDefault();
              setShowInspectorDrawer((prev) => !prev);
              setShowHistoryDrawer(false);
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              showInspectorDrawer ? 'text-blue-600 font-semibold' : ''
            }`}
          >
            模型呼叫檢查器 ({inspectorLogs.length})
          </a>
          <a
            href="#export"
            onClick={(e) => {
              e.preventDefault();
              handleExportMarkdownReport();
            }}
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            匯出 Markdown
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action Button & Language selector */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setSpeechLang((prev) => (prev === 'zh-TW' ? 'en-US' : 'zh-TW'))}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300/80 rounded-lg transition-colors whitespace-nowrap shrink-0"
            title="切換語音收音語言（預設繁體中文，亦支援英語）"
          >
            <span className="text-[10px] text-slate-500 font-mono">辨識語言:</span>
            <span className="font-semibold text-slate-900">
              {speechLang === 'zh-TW' ? '繁中' : 'English'}
            </span>
          </button>

          <button
            onClick={handleToggleLiveMic}
            disabled={isStartingMic}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-xs ${
              isLiveRecording
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isLiveRecording ? (
              <>
                <div className="flex items-end gap-0.5 h-3.5 w-3.5 mr-0.5">
                  <span
                    className="w-1 bg-white rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(25, micLevel)}%` }}
                  />
                  <span
                    className="w-1 bg-white rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(35, (micLevel * 1.3) % 100)}%` }}
                  />
                  <span
                    className="w-1 bg-white rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(20, (micLevel * 0.7) % 100)}%` }}
                  />
                </div>
                <span>停止即時收音</span>
              </>
            ) : (
              <>
                <Mic className="w-3.5 h-3.5" />
                <span>{isStartingMic ? '正在啟動麥克風…' : '開始即時收音'}</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Secondary Contextual Workspace Toolbar */}
      <div className="flex items-center justify-between gap-4 px-6 py-2 bg-slate-50 border-b border-slate-200 shrink-0">
        {/* Left: Meeting Title & Status */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setShowHistoryDrawer((prev) => !prev)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            title="管理多場會議紀錄"
          >
            <FolderClock className="w-3.5 h-3.5" />
            <span>會議列表</span>
          </button>
          <span className="text-slate-300" aria-hidden="true">
            /
          </span>

          {isEditingTitle ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && titleInput.trim()) {
                    updateActiveSession((prev) => ({
                      ...prev,
                      title: titleInput.trim(),
                    }));
                    setIsEditingTitle(false);
                  }
                }}
                className="px-2 py-0.5 text-xs font-semibold bg-white border border-blue-400 rounded text-slate-900 focus:outline-none"
                autoFocus
              />
              <button
                onClick={() => {
                  if (titleInput.trim()) {
                    updateActiveSession((prev) => ({
                      ...prev,
                      title: titleInput.trim(),
                    }));
                  }
                  setIsEditingTitle(false);
                }}
                className="p-1 text-blue-600 hover:text-blue-800"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <h1 className="text-xs font-semibold text-slate-900 truncate max-w-md">
                {activeSession.title}
              </h1>
              <button
                onClick={() => {
                  setTitleInput(activeSession.title);
                  setIsEditingTitle(true);
                }}
                className="p-1 text-slate-400 hover:text-slate-700 shrink-0"
                title="修改會議名稱"
              >
                <Edit3 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Right: Live Telemetry, Audio Backup & Quick Actions */}
        <div className="flex items-center gap-2.5 text-xs text-slate-600 shrink-0 flex-wrap justify-end">
          {/* Recording Timer & Audio Meter */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200/80 rounded-md">
            <span className="text-slate-500 whitespace-nowrap text-[11px]">時長</span>
            <span className="font-mono-tabular font-semibold text-slate-900 text-xs">
              {formatDuration(activeSession.durationSeconds)}
            </span>
            {isLiveRecording && (
              <div className="flex items-center gap-1.5 ml-1 pl-1.5 border-l border-slate-200">
                <span className="text-[11px] text-slate-500 font-medium whitespace-nowrap">音量</span>
                <div
                  className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden"
                  title={`麥克風即時音量：${micLevel}%`}
                >
                  <div
                    className={`h-full transition-all duration-75 ${
                      micLevel > 15
                        ? 'bg-emerald-500'
                        : micLevel > 0
                        ? 'bg-emerald-400'
                        : 'bg-slate-300'
                    }`}
                    style={{ width: `${Math.max(6, micLevel)}%` }}
                  />
                </div>
                <span className="font-mono-tabular text-[10px] text-slate-600 w-6 text-right">
                  {micLevel}%
                </span>
              </div>
            )}
          </div>

          {/* Local Audio Backup Status & Download Button */}
          {backupAudioUrl ? (
            <a
              href={backupAudioUrl}
              download={`${activeSession.title.replace(/\s+/g, '_')}_本機錄音備份.${backupAudioExtension}`}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition-colors whitespace-nowrap shrink-0"
              title="下載剛才在瀏覽器本機錄下的完整音訊檔"
            >
              <Download className="w-3.5 h-3.5" />
              <span>錄音備份</span>
            </a>
          ) : isBackingUp ? (
            <div className="hidden sm:flex items-center gap-1 text-[11px] text-emerald-700 font-medium px-2 py-0.5 bg-emerald-50/80 rounded border border-emerald-200/60">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>本機錄音備份中</span>
            </div>
          ) : null}

          {/* Live Session Status Pill */}
          <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 border border-slate-200/80 rounded-md text-xs">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                wsStatus === 'connected'
                  ? 'bg-emerald-500 animate-pulse'
                  : wsStatus === 'connecting'
                  ? 'bg-amber-500 animate-ping'
                  : 'bg-slate-300'
              }`}
            />
            <span
              className={
                wsStatus === 'connected'
                  ? 'text-emerald-700 font-medium'
                  : wsStatus === 'connecting'
                  ? 'text-amber-600 font-medium'
                  : 'text-slate-500'
              }
            >
              {wsStatus === 'connected'
                ? 'AI 已連線'
                : wsStatus === 'connecting'
                ? '重連中...'
                : wsStatus === 'degraded' ? 'AI 未就緒・備援模式' : '待命'}
            </span>
          </div>

          {/* AI Assistance Buttons Group */}
          <div className="flex items-center gap-1 bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/60">
            <button
              onClick={() => setShowRecordingRecovery(true)}
              disabled={isLiveRecording || isStartingMic}
              className="flex items-center gap-1 rounded-md border border-blue-200/80 bg-white px-2 py-1 text-xs font-medium text-blue-700 shadow-2xs hover:bg-blue-50 disabled:opacity-40"
              title="選取本場錄音或電腦裡的音檔，重建逐字稿、會議紀錄、心智圖與待辦；請先停止收音"
            >
              <Upload className="h-3 w-3" /><span>錄音重建</span>
            </button>
            {/* Conversational Error Correction Button */}
            <button
              onClick={() => setShowCorrectionModal(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-800 bg-white hover:bg-amber-50 border border-amber-200/80 rounded-md transition-colors whitespace-nowrap shadow-2xs"
              title="用自然語言對話請 AI 修正人名錯字、心智圖節點或待辦內容"
            >
              <Edit3 className="w-3 h-3 text-amber-600" />
              <span>對話修訂</span>
            </button>

            {/* Fast Catch-Up Trigger Button */}
            <button
              onClick={() => setShowCatchUpModal(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-purple-700 bg-white hover:bg-purple-50 border border-purple-200/80 rounded-md transition-colors whitespace-nowrap shadow-2xs"
              title="貼上或口述會議重點，Gemini 將立即重新結構化整場會議的心智圖與待辦"
            >
              <Sparkles className="w-3 h-3 text-purple-600" />
              <span>速記補全</span>
            </button>

            {/* Force Catalyze / Unstick Button */}
            <button
              onClick={handleForceUnstick}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-white hover:bg-blue-50 border border-blue-200/80 rounded-md transition-colors whitespace-nowrap shadow-2xs"
              title="當感覺 AI 停止更新或停頓時，點擊此處立即催化輸出並重整連線"
            >
              <RefreshCw className="w-3 h-3 text-blue-600" />
              <span>催化重整</span>
            </button>
          </div>

          {/* Utility Buttons Group */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleResetCurrentSession}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:text-red-700 bg-white hover:bg-red-50 border border-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
              title="清空目前會議的所有非本次紀錄，乾淨重新開始"
            >
              <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-600" />
              <span>清空重置</span>
            </button>

            <button
              onClick={() => handleCopySessionForDiscussion(activeSession)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 rounded transition-colors whitespace-nowrap shrink-0 shadow-2xs"
              title="一鍵複製整場會議紀錄（包含逐字稿、重點章節與心智圖），可直接貼在對話框中與 AI 進行深度討論"
            >
              <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />
              <span>複製會議 (與 AI 討論)</span>
            </button>

            <button
              onClick={handleExportMarkdownReport}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
              title="匯出完整 Markdown 會議報告"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>匯出 .MD</span>
            </button>
          </div>
        </div>
      </div>

      {/* Copy Success Notification Banner */}
      {copySuccessBanner && (
        <div className="flex items-center justify-between px-6 py-2.5 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-800 shrink-0 animate-in fade-in">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-medium">{copySuccessBanner}</span>
          </div>
          <button
            onClick={() => setCopySuccessBanner(null)}
            className="text-xs font-medium underline text-emerald-700 hover:text-emerald-900"
          >
            關閉提示
          </button>
        </div>
      )}

      {/* Error Notification Banner */}
      {errorBanner && (
        <div className="flex items-center justify-between px-6 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            onClick={() => setErrorBanner(null)}
            className="text-xs font-medium underline hover:text-red-900"
          >
            關閉提示
          </button>
        </div>
      )}

      {/* Main Workspace */}
      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        {/* Collapsible LocalStorage Meeting History Drawer */}
        {showHistoryDrawer && (
          <aside className="w-72 bg-white border-r border-slate-200 flex flex-col shrink-0 z-20">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <span className="text-xs font-semibold text-slate-900">
                本地保存會議歷史
              </span>
              <button
                onClick={handleCreateNewSession}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded transition-colors whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新會議</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {sessions.map((sess) => {
                const isActive = sess.id === activeSession.id;
                return (
                  <div
                    key={sess.id}
                    onClick={() => {
                      if (isRecordingRef.current || isStartingMicRef.current) {
                        setErrorBanner('請先停止收音，再切換會議。');
                        return;
                      }
                      setActiveSessionId(sess.id);
                      setShowHistoryDrawer(false);
                    }}
                    className={`p-3.5 cursor-pointer transition-colors flex items-start justify-between gap-2 ${
                      isActive ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-xs truncate ${
                          isActive
                            ? 'font-semibold text-blue-900'
                            : 'font-medium text-slate-800'
                        }`}
                      >
                        {sess.title}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-500 font-mono-tabular">
                        <span>{sess.updatedAt}</span>
                        <span aria-hidden="true">·</span>
                        <span>{sess.mindMapNodes.length} 節點</span>
                        <span aria-hidden="true">·</span>
                        <span>{sess.todos.length} 待辦</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopySessionForDiscussion(sess);
                        }}
                        className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
                        title="一鍵複製此會議紀錄以供貼至 AI 進行深度討論"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      {sessions.length > 1 && (
                        <button
                          onClick={(e) => handleDeleteSession(sess.id, e)}
                          className="p-1 text-slate-400 hover:text-red-600 rounded shrink-0"
                          title="刪除此會議紀錄"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {/* 3-Column Simultaneous Live Workspace with Resizable Split Columns */}
        <main
          ref={workspaceContainerRef}
          className={`flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden relative ${
            isDraggingLeftResizer || isDraggingRightResizer ? 'select-none' : ''
          }`}
          style={{
            cursor:
              isDraggingLeftResizer || isDraggingRightResizer
                ? 'col-resize'
                : 'default',
          }}
        >
          {/* Column 1: Structured Notes & Live Transcripts (Resizable Left Column) */}
          <section
            style={{ width: `${leftColWidthPercent}%` }}
            className="w-full lg:w-auto h-full min-h-0 overflow-hidden flex flex-col shrink-0 min-w-[260px] max-w-full lg:max-w-[65%]"
          >
            <NotesColumn
              notes={activeSession.notes}
              transcripts={activeSession.transcripts}
              livePartialTranscript={livePartialTranscript}
              isLiveConnected={wsStatus === 'connected'}
              onUpdateNotes={(notes) =>
                updateActiveSession((prev) => ({ ...prev, notes }))
              }
              onSendManualUtterance={handleSendUtteranceToLive}
              onNudgeSync={handleNudgeSync}
              onOpenCatchUpModal={() => setShowCatchUpModal(true)}
              onOpenCorrectionModal={() => setShowCorrectionModal(true)}
              onConvergeNotes={handleExecuteConvergeNotes}
              isConvergingNotes={isConvergingNotes}
              onDeleteTranscript={handleDeleteTranscript}
              onClearTranscripts={handleClearTranscripts}
            />
          </section>

          {/* Left Draggable Resizer Splitter */}
          <div
            onMouseDown={() => setIsDraggingLeftResizer(true)}
            onDoubleClick={() => {
              setLeftColWidthPercent(33);
              try {
                localStorage.setItem('pulsenote_left_col_width', '33');
              } catch {
                // ignore
              }
            }}
            className={`hidden lg:flex flex-col items-center justify-center w-1.5 hover:w-2 bg-slate-200 hover:bg-blue-500 cursor-col-resize select-none relative group transition-all shrink-0 z-10 ${
              isDraggingLeftResizer ? 'w-2 bg-blue-600' : ''
            }`}
            title="按住拖曳調整左欄寬度；雙擊重設為 33%"
          >
            <div className="w-1 h-7 rounded-full bg-slate-400 group-hover:bg-white transition-colors" />
          </div>

          {/* Column 2: Interactive 3-Tier SVG Mind Map Canvas (Fills remaining workspace dynamically) */}
          <section className="flex-1 min-w-[280px] h-full min-h-0 overflow-hidden flex flex-col">
            <MindMapCanvas
              nodes={activeSession.mindMapNodes}
              meetingTitle={activeSession.title}
              onUpdateNodes={(mindMapNodes) =>
                updateActiveSession((prev) => ({ ...prev, mindMapNodes }))
              }
              onOpenInspector={() => setShowInspectorDrawer(true)}
              onConvergeMindMap={handleExecuteConvergeMindMap}
              isConverging={isConvergingMindMap}
              onAddTodoFromNode={handleAddTodoFromNode}
            />
          </section>

          {/* Right Draggable Resizer Splitter */}
          {!isRightColCollapsed && (
            <div
              onMouseDown={() => setIsDraggingRightResizer(true)}
              onDoubleClick={() => {
                setRightColWidthPercent(24);
                try {
                  localStorage.setItem('pulsenote_right_col_width', '24');
                } catch {
                  // ignore
                }
              }}
              className={`hidden lg:flex flex-col items-center justify-center w-1.5 hover:w-2 bg-slate-200 hover:bg-blue-500 cursor-col-resize select-none relative group transition-all shrink-0 z-10 ${
                isDraggingRightResizer ? 'w-2 bg-blue-600' : ''
              }`}
              title="按住拖曳調整右欄寬度；雙擊重設為 24%"
            >
              <div className="w-1 h-7 rounded-full bg-slate-400 group-hover:bg-white transition-colors" />
            </div>
          )}

          {/* Column 3: Actionable To-Do List (Resizable Right Column or Collapsible) */}
          {isRightColCollapsed ? (
            <div
              onClick={() => {
                setIsRightColCollapsed(false);
                try {
                  localStorage.setItem('pulsenote_right_col_collapsed', 'false');
                } catch {
                  // ignore
                }
              }}
              className="hidden lg:flex flex-col items-center justify-start py-4 px-1.5 bg-slate-100 hover:bg-slate-200 border-l border-slate-200 cursor-pointer transition-colors shrink-0 select-none group"
              title="點擊展開待辦事項清單"
            >
              <div className="flex flex-col items-center gap-2">
                <ChevronLeft className="w-4 h-4 text-slate-500 group-hover:text-blue-600 transition-colors" />
                <span className="text-[11px] font-semibold text-slate-700 [writing-mode:vertical-rl] tracking-wider">
                  展開待辦清單
                </span>
                <span className="px-1 py-0.5 text-[10px] font-mono-tabular bg-slate-300 text-slate-800 rounded-full">
                  {activeSession.todos.length}
                </span>
              </div>
            </div>
          ) : (
            <section
              style={{ width: `${rightColWidthPercent}%` }}
              className="w-full lg:w-auto h-full min-h-0 overflow-hidden flex flex-col shrink-0 min-w-[220px] max-w-full lg:max-w-[45%] relative"
            >
              <TodoColumn
                todos={activeSession.todos}
                onUpdateTodos={(todos) =>
                  updateActiveSession((prev) => ({ ...prev, todos }))
                }
              />
              {/* Quick collapse button on right edge of todo column header */}
              <button
                type="button"
                onClick={() => {
                  setIsRightColCollapsed(true);
                  try {
                    localStorage.setItem('pulsenote_right_col_collapsed', 'true');
                  } catch {
                    // ignore
                  }
                }}
                className="hidden lg:flex items-center justify-center absolute top-2.5 right-2.5 p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
                title="收合待辦清單，擴大心智圖畫布"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </section>
          )}
        </main>

        {/* Right Drawer: Live Model Data Inspector */}
        {showInspectorDrawer && (
          <aside className="w-96 bg-white border-l border-slate-200 flex flex-col shrink-0 z-30 shadow-lg">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-blue-600" />
                <span className="text-xs font-semibold text-slate-900">
                  Gemini 3.8 Live 原始數據檢視器
                </span>
              </div>
              <button
                onClick={() => setShowInspectorDrawer(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
              即時顯示模型觸發的 Tool Calling 原始 JSON 參數，方便精準判斷模型產出內容。
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {inspectorLogs.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  尚未收到 Tool Call 數據
                </div>
              ) : (
                inspectorLogs.map((log) => (
                  <div
                    key={log.id}
                    className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-blue-700">
                        {log.toolName}
                      </span>
                      <span className="text-[11px] font-mono-tabular text-slate-400">
                        {log.timestamp}
                      </span>
                    </div>
                    <pre className="p-2 bg-white border border-slate-200 rounded text-[10.5px] font-mono overflow-x-auto text-slate-800 leading-tight">
                      {JSON.stringify(log.args, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {showRecordingRecovery && <RecordingRecovery
        session={activeSession}
        onClose={() => setShowRecordingRecovery(false)}
        onRecovered={recovered => {
          setSessions(prev => prev.some(s => s.id === recovered.id) ? prev.map(s => s.id === recovered.id ? recovered : s) : [recovered, ...prev]);
          setActiveSessionId(recovered.id);
        }}
      />}

      {/* Modal: Catch-up / Reconstruct Meeting from Notes or Speech */}
      {showCatchUpModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  口述或貼上會議要點 · Gemini 一鍵補全重構
                </h3>
              </div>
              <button
                onClick={() => setShowCatchUpModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <p className="text-xs text-slate-600 leading-relaxed">
                如果您記得剛才 61 分鐘會議的討論內容、決策或待辦，可直接在下方貼上速記、大綱或口述重點，Gemini 會立即為這場會議重構出<b>結構化紀錄、三層精煉心智圖與待辦清單</b>：
              </p>

              <textarea
                value={catchUpText}
                onChange={(e) => setCatchUpText(e.target.value)}
                placeholder="例如：
1. 討論了 Q4 語音平台改版，決定導入 Gemini 3.8 Live，目標延遲小於 500ms。
2. 建宏負責在週五前交付 WebSocket 壓力測試報告。
3. 庭瑜負責三欄式工作台的 Figma 原型設計，下週二交付。
4. 柏翰提醒資安合規，需在存入資料庫前完成敏感個資遮罩驗證..."
                rows={7}
                className="w-full p-3 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-600 font-sans leading-relaxed"
              />

              {catchUpError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                  {catchUpError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 bg-slate-50 border-t border-slate-200">
              <button
                onClick={() => setShowCatchUpModal(false)}
                className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900"
              >
                取消
              </button>
              <button
                onClick={handleExecuteCatchUp}
                disabled={isCatchingUp || !catchUpText.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                {isCatchingUp ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Gemini 分析重構中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>立即補全此會議</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification for Correction */}
      {correctionToast && (
        <div className="fixed top-14 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white text-xs font-medium rounded-lg shadow-xl animate-fade-in">
          <Check className="w-4 h-4 shrink-0" />
          <span>{correctionToast}</span>
        </div>
      )}

      {/* Modal: Conversational AI Error Correction */}
      {showCorrectionModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-amber-700" />
                <h3 className="text-sm font-semibold text-slate-900">
                  跟 AI 對話修正錯詞與調整內容
                </h3>
              </div>
              <button
                onClick={handleCloseCorrectionModal}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-600 leading-relaxed">
                您可以像跟助理講話一樣，用<b>打字</b>或點擊右下方<b>麥克風直接說話</b>告訴 AI 要修正什麼。AI 會自動搜尋目前的<b>逐字稿、重點筆記、心智圖與待辦清單</b>並精準智慧替換：
              </p>

              {/* Quick suggestion prompt chips */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-slate-400">
                  常用指令範例（點擊可直接帶入）：
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    '把「建宏」全部修正為「建弘」',
                    '心智圖的第二個主幹改名為「企業通訊閘道器」',
                    '把待辦事項中建弘的任務期限改為「下週三」',
                    '將逐字稿提到的「批批哀」更正為「PII 個資遮罩」',
                  ].map((example, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setCorrectionInstruction(example)}
                      className="px-2.5 py-1 text-[11px] text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded transition-colors text-left"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative">
                <textarea
                  value={correctionInstruction}
                  onChange={(e) => setCorrectionInstruction(e.target.value)}
                  placeholder="例如：
- 把所有的『林建宏』修正為『林建弘』
- 心智圖架構那段的決策，把 200 改成 500
- 待辦事項第二項的負責人換成『許庭瑜』..."
                  rows={4}
                  className="w-full p-3 pr-12 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 font-sans leading-relaxed"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleToggleVoiceCorrection}
                  className={`absolute right-2.5 bottom-3 p-2 rounded-full transition-all ${
                    isListeningVoiceCorrection
                      ? 'bg-red-600 text-white animate-pulse ring-4 ring-red-200'
                      : 'text-slate-400 hover:text-amber-800 hover:bg-amber-100'
                  }`}
                  title={
                    isListeningVoiceCorrection
                      ? '停止語音口述'
                      : '點擊以語音說出修正指令（免打字）'
                  }
                >
                  <Mic className="w-4 h-4" />
                </button>
              </div>

              {isListeningVoiceCorrection && (
                <div className="flex items-center gap-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping shrink-0" />
                  <span>
                    正在聆聽您的語音指令... 請對著麥克風說話（如：「把建宏全部改成建弘」），完成後點擊右下角「執行對話修訂」。
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 bg-slate-50 border-t border-slate-200">
              <button
                onClick={handleCloseCorrectionModal}
                className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900"
              >
                取消
              </button>
              <button
                onClick={() => handleExecuteCorrection()}
                disabled={isCorrecting || !correctionInstruction.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50 rounded-lg transition-colors"
              >
                {isCorrecting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Gemini 全面校正替換中...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>執行對話修訂</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
