import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Play,
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
} from 'lucide-react';
import {
  MeetingSession,
  MindMapNode,
  NoteSection,
  TodoItem,
  ToolCallInspectorItem,
} from './types/meeting';
import {
  INITIAL_MEETING_SESSIONS,
  SIMULATED_MEETING_SCRIPT,
} from './data/sampleMeetings';
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

export default function App() {
  // Load persisted sessions from localStorage
  const [sessions, setSessions] = useState<MeetingSession[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // fallback
    }
    return INITIAL_MEETING_SESSIONS;
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => sessions[0]?.id || INITIAL_MEETING_SESSIONS[0].id
  );
  const [showHistoryDrawer, setShowHistoryDrawer] = useState<boolean>(false);
  const [showInspectorDrawer, setShowInspectorDrawer] = useState<boolean>(false);
  const [showCatchUpModal, setShowCatchUpModal] = useState<boolean>(false);

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
    'disconnected' | 'connecting' | 'connected'
  >('disconnected');
  const [livePartialTranscript, setLivePartialTranscript] =
    useState<string>('');
  const [micLevel, setMicLevel] = useState<number>(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [lastToolSyncInfo, setLastToolSyncInfo] = useState<string>(
    '就緒 · 支援長會議無縫滾動連線'
  );
  const [simStepIndex, setSimStepIndex] = useState<number>(0);

  // Local Audio Backup via MediaRecorder (Safety net for 60+ min meetings)
  const [backupAudioUrl, setBackupAudioUrl] = useState<string | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Inspector Logs for Gemini 3.8 Live Tool Calls
  const [inspectorLogs, setInspectorLogs] = useState<ToolCallInspectorItem[]>([]);

  // Refs for callbacks to avoid stale closures (per Live API Rules)
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const activeSessionIdRef = useRef<string>(activeSessionId);
  const partialBufferRef = useRef<string>('');
  const timerRef = useRef<number | null>(null);
  const isRecordingRef = useRef<boolean>(false);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    isRecordingRef.current = isLiveRecording;
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
                updatedAt: `2026-10-19 ${nowStr}`,
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
          const merged = [...prev.mindMapNodes];
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
          return { ...prev, mindMapNodes: merged };
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

  // Ensure WebSocket connection with keepalive ping-pong and auto-reconnect
  const ensureLiveWebSocket = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        resolve(wsRef.current);
        return;
      }

      setWsStatus('connecting');
      setErrorBanner(null);

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // Handle server ping keepalive
          if (msg.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            return;
          }

          if (msg.type === 'session_status' && msg.status === 'connected') {
            setWsStatus('connected');
            setLastToolSyncInfo(
              msg.rolloverCount
                ? `連線已平滑延續 (第 ${msg.rolloverCount + 1} 階段)`
                : 'Gemini 3.8 Live 已連線 · 傾聽中'
            );
            resolve(ws);
          } else if (msg.type === 'session_rollover') {
            setLastToolSyncInfo(msg.message || '連線自動無縫延續中...');
          } else if (msg.type === 'input_transcription' && msg.text) {
            partialBufferRef.current += msg.text;
            setLivePartialTranscript(partialBufferRef.current);
          } else if (msg.type === 'turn_complete') {
            if (partialBufferRef.current.trim()) {
              const finalTxt = partialBufferRef.current.trim();
              const nowTime = new Date().toLocaleTimeString('zh-TW', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });
              updateActiveSession((prev) => ({
                ...prev,
                transcripts: [
                  ...prev.transcripts,
                  {
                    id: `tr-${Date.now()}`,
                    speaker: '現場收音',
                    text: finalTxt,
                    timestamp: nowTime,
                    isFinal: true,
                  },
                ],
              }));
              partialBufferRef.current = '';
              setLivePartialTranscript('');
            }
          } else if (msg.type === 'tool_call') {
            handleLiveToolCall(
              msg.toolName,
              msg.args,
              msg.timestamp,
              msg.callId
            );
          } else if (msg.type === 'error') {
            setErrorBanner(msg.message);
          }
        } catch (err) {
          console.error('Error parsing WS message:', err);
        }
      };

      ws.onerror = () => {
        setWsStatus('disconnected');
        reject(new Error('WebSocket error'));
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        // Auto-reconnect if user is still actively recording!
        if (isRecordingRef.current) {
          setLastToolSyncInfo('連線中斷，正在自動重新連線（麥克風持續錄音備份中）...');
          setTimeout(() => {
            if (isRecordingRef.current) {
              ensureLiveWebSocket().catch(() => {});
            }
          }, 1500);
        }
      };
    });
  }, [handleLiveToolCall, updateActiveSession]);

  // Start / Stop Live Microphone Audio Capture (with local MediaRecorder safety net)
  const handleToggleLiveMic = async () => {
    if (isLiveRecording) {
      // Stop recording
      setIsLiveRecording(false);
      isRecordingRef.current = false;
      setMicLevel(0);

      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
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
      if (partialBufferRef.current.trim()) {
        const leftover = partialBufferRef.current.trim();
        const nowTime = new Date().toLocaleTimeString('zh-TW', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        updateActiveSession((prev) => ({
          ...prev,
          transcripts: [
            ...prev.transcripts,
            {
              id: `tr-${Date.now()}`,
              speaker: '現場收音',
              text: leftover,
              timestamp: nowTime,
              isFinal: true,
            },
          ],
        }));
        partialBufferRef.current = '';
        setLivePartialTranscript('');
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'nudge_sync' }));
      }
      return;
    }

    // Start recording
    try {
      setErrorBanner(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      // 1. Start browser-local backup recording via MediaRecorder
      try {
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        recordedChunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };
        recorder.onstop = () => {
          if (recordedChunksRef.current.length > 0) {
            const blob = new Blob(recordedChunksRef.current, { type: mime });
            const url = URL.createObjectURL(blob);
            setBackupAudioUrl(url);
            updateActiveSession((prev) => ({
              ...prev,
              backupAudioBlobUrl: url,
              hasLocalBackup: true,
            }));
          }
        };
        recorder.start(1000); // chunk every 1 sec
        mediaRecorderRef.current = recorder;
      } catch (recErr) {
        console.warn('MediaRecorder not available or failed to start:', recErr);
      }

      // 2. Start WebSocket connection to Gemini 3.8 Live
      const ws = await ensureLiveWebSocket();

      // 3. Start 16kHz PCM Web Audio processor
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        setMicLevel(Math.min(100, Math.round(rms * 400)));

        if (ws.readyState === WebSocket.OPEN) {
          const base64Audio = float32ToPcm16Base64(inputData);
          ws.send(JSON.stringify({ type: 'audio', audio: base64Audio }));
        }
      };

      setIsLiveRecording(true);
      isRecordingRef.current = true;
      timerRef.current = window.setInterval(() => {
        updateActiveSession((prev) => ({
          ...prev,
          durationSeconds: prev.durationSeconds + 1,
        }));
      }, 1000);
    } catch (err: any) {
      console.error('Microphone access or Live connection error:', err);
      setErrorBanner(
        '無法啟動麥克風（請確認瀏覽器麥克風權限），您仍可點擊「注入測試對話」或「速記補全」體驗完整功能。'
      );
    }
  };

  // Inject a manual or simulated dialogue turn into Gemini 3.8 Live
  const handleSendUtteranceToLive = async (speaker: string, text: string) => {
    const nowTime = new Date().toLocaleTimeString('zh-TW', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    updateActiveSession((prev) => ({
      ...prev,
      transcripts: [
        ...prev.transcripts,
        {
          id: `tr-${Date.now()}`,
          speaker,
          text,
          timestamp: nowTime,
          isFinal: true,
        },
      ],
    }));

    try {
      const ws = await ensureLiveWebSocket();
      setLastToolSyncInfo('Gemini 3.8 Live 正在分析對話並更新圖表...');
      ws.send(
        JSON.stringify({
          type: 'text_input',
          speaker,
          text,
        })
      );
    } catch (err) {
      console.error('Failed to send utterance to Live session:', err);
    }
  };

  const handleInjectSimulatedTurn = () => {
    const turn =
      SIMULATED_MEETING_SCRIPT[simStepIndex % SIMULATED_MEETING_SCRIPT.length];
    setSimStepIndex((prev) => prev + 1);
    handleSendUtteranceToLive(turn.speaker, turn.text);
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

  const handleCreateNewSession = () => {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString('zh-TW', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const newId = `session-${Date.now()}`;
    const newSession: MeetingSession = {
      id: newId,
      title: `新會議紀錄 (${dateStr} ${timeStr})`,
      createdAt: `${dateStr} ${timeStr}`,
      updatedAt: `${dateStr} ${timeStr}`,
      durationSeconds: 0,
      transcripts: [],
      notes: [],
      mindMapNodes: [
        {
          id: 'root',
          parentId: null,
          label: '會議核心主題',
          category: 'root',
        },
      ],
      todos: [],
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newId);
    setBackupAudioUrl(null);
    setShowHistoryDrawer(false);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleToggleLiveMic}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              isLiveRecording
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isLiveRecording ? (
              <>
                <MicOff className="w-3.5 h-3.5" />
                <span>停止即時收音</span>
              </>
            ) : (
              <>
                <Mic className="w-3.5 h-3.5" />
                <span>開始即時收音</span>
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
        <div className="flex items-center gap-3 text-xs text-slate-600 shrink-0">
          {/* Recording Timer & Audio Meter */}
          <div className="flex items-center gap-2">
            <span className="text-slate-500 whitespace-nowrap">收音時長</span>
            <span className="font-mono-tabular font-semibold text-slate-900">
              {formatDuration(activeSession.durationSeconds)}
            </span>
            {isLiveRecording && (
              <div
                className="w-14 h-2 bg-slate-200 rounded-full overflow-hidden"
                title="麥克風即時音量"
              >
                <div
                  className="h-full bg-emerald-600 transition-all duration-100"
                  style={{ width: `${Math.max(8, micLevel)}%` }}
                />
              </div>
            )}
          </div>

          {/* Local Audio Backup Status & Download Button */}
          {backupAudioUrl ? (
            <a
              href={backupAudioUrl}
              download={`${activeSession.title.replace(/\s+/g, '_')}_本機錄音備份.webm`}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition-colors whitespace-nowrap shrink-0"
              title="下載剛才在瀏覽器本機錄下的完整音訊檔"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下載錄音備份 (WebM)</span>
            </a>
          ) : isLiveRecording ? (
            <div className="flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>本機雙重備份中</span>
            </div>
          ) : null}

          <span className="text-slate-300" aria-hidden="true">
            ·
          </span>

          {/* Live Session Status */}
          <div className="hidden lg:flex items-center gap-1.5 text-xs">
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
                ? 'gemini-3.8-live 連線中'
                : wsStatus === 'connecting'
                ? '自動重連中...'
                : '待命'}
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-500 font-mono-tabular">
              {lastToolSyncInfo}
            </span>
          </div>

          {/* Fast Catch-Up Trigger Button */}
          <button
            onClick={() => setShowCatchUpModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200/80 rounded transition-colors whitespace-nowrap shrink-0"
            title="貼上或口述會議重點，Gemini 將立即重新結構化整場會議的心智圖與待辦"
          >
            <Sparkles className="w-3 h-3" />
            <span>速記補全</span>
          </button>

          {/* Simulated Speech Button */}
          <button
            onClick={handleInjectSimulatedTurn}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200/80 rounded transition-colors whitespace-nowrap shrink-0"
            title="送入測試發言測試 Gemini 3.8 Live"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>
              測試發言 ({(simStepIndex % SIMULATED_MEETING_SCRIPT.length) + 1}/
              {SIMULATED_MEETING_SCRIPT.length})
            </span>
          </button>

          <button
            onClick={handleExportMarkdownReport}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
            title="匯出完整 Markdown 會議報告"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span>匯出 .MD</span>
          </button>
        </div>
      </div>

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
                );
              })}
            </div>
          </aside>
        )}

        {/* 3-Column Simultaneous Live Workspace */}
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden">
          {/* Column 1 (30% -> 4 cols): Structured Notes & Live Transcripts */}
          <section className="lg:col-span-4 h-full min-h-0 overflow-hidden">
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
            />
          </section>

          {/* Column 2 (45% -> 5 cols): Interactive 3-Tier SVG Mind Map Canvas */}
          <section className="lg:col-span-5 h-full min-h-0 overflow-hidden">
            <MindMapCanvas
              nodes={activeSession.mindMapNodes}
              meetingTitle={activeSession.title}
              onUpdateNodes={(mindMapNodes) =>
                updateActiveSession((prev) => ({ ...prev, mindMapNodes }))
              }
              onOpenInspector={() => setShowInspectorDrawer(true)}
            />
          </section>

          {/* Column 3 (25% -> 3 cols): Actionable To-Do List */}
          <section className="lg:col-span-3 h-full min-h-0 overflow-hidden">
            <TodoColumn
              todos={activeSession.todos}
              onUpdateTodos={(todos) =>
                updateActiveSession((prev) => ({ ...prev, todos }))
              }
            />
          </section>
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
    </div>
  );
}
