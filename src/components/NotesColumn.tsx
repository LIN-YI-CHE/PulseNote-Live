import React, { useState, useRef, useEffect } from 'react';
import {
  Plus,
  Send,
  Edit3,
  Check,
  X,
  Trash2,
  Sparkles,
  MessageSquare,
  FileText,
} from 'lucide-react';
import { NoteSection, TranscriptEntry } from '../types/meeting';

interface NotesColumnProps {
  notes: NoteSection[];
  transcripts: TranscriptEntry[];
  livePartialTranscript: string;
  isLiveConnected: boolean;
  onUpdateNotes: (notes: NoteSection[]) => void;
  onSendManualUtterance: (speaker: string, text: string) => void;
  onNudgeSync: () => void;
}

export const NotesColumn: React.FC<NotesColumnProps> = ({
  notes,
  transcripts,
  livePartialTranscript,
  isLiveConnected,
  onUpdateNotes,
  onSendManualUtterance,
  onNudgeSync,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editDecisions, setEditDecisions] = useState('');

  const [speakerInput, setSpeakerInput] = useState('與會者');
  const [utteranceInput, setUtteranceInput] = useState('');
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts.length, livePartialTranscript]);

  const handleStartEdit = (sec: NoteSection) => {
    setEditingId(sec.id);
    setEditTopic(sec.topic);
    setEditSummary(sec.summary);
    setEditDecisions((sec.keyDecisions || []).join('\n'));
  };

  const handleSaveEdit = () => {
    if (!editingId || !editTopic.trim()) return;
    const decisions = editDecisions
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    onUpdateNotes(
      notes.map((n) =>
        n.id === editingId
          ? {
              ...n,
              topic: editTopic.trim(),
              summary: editSummary.trim(),
              keyDecisions: decisions,
              updatedAt: new Date().toLocaleTimeString('zh-TW', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            }
          : n
      )
    );
    setEditingId(null);
  };

  const handleAddSection = () => {
    const newId = `topic-${Date.now().toString().slice(-4)}`;
    const now = new Date().toLocaleTimeString('zh-TW', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const newSec: NoteSection = {
      id: newId,
      topic: `0${notes.length + 1}. 新增討論章節`,
      summary: '點擊編輯以補充本章節的討論重點與結論。',
      keyDecisions: [],
      updatedAt: now,
    };
    onUpdateNotes([...notes, newSec]);
    handleStartEdit(newSec);
  };

  const handleDeleteSection = (id: string) => {
    onUpdateNotes(notes.filter((n) => n.id !== id));
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!utteranceInput.trim()) return;
    onSendManualUtterance(speakerInput.trim() || '與會者', utteranceInput.trim());
    setUtteranceInput('');
  };

  return (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 overflow-hidden">
      {/* Top Half: Structured Meeting Notes & Key Decisions */}
      <div className="flex flex-col h-[54%] border-b border-slate-200 min-h-0">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 whitespace-nowrap">
              01. 結構化會議紀錄
            </h2>
            <span className="text-xs text-slate-400" aria-hidden="true">
              ·
            </span>
            <span className="text-xs text-slate-500 font-mono-tabular whitespace-nowrap">
              {notes.length} 章節
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isLiveConnected && (
              <button
                onClick={onNudgeSync}
                className="px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors whitespace-nowrap shrink-0"
                title="要求 Gemini 3.8 Live 立即根據最新對話整理結構"
              >
                立即歸納重點
              </button>
            )}
            <button
              onClick={handleAddSection}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新增段落</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {notes.length === 0 ? (
            <div className="py-8 text-center">
              <FileText className="w-6 h-6 text-slate-400 mx-auto mb-2" />
              <p className="text-xs text-slate-600 mb-1">
                尚無結構化會議重點
              </p>
              <p className="text-xs text-slate-400">
                啟動即時收音或注入測試對話後，Gemini 3.8 Live 將自動整理章節摘要與決策。
              </p>
            </div>
          ) : (
            notes.map((sec) => (
              <div
                key={sec.id}
                className="pb-4 border-b border-slate-100 last:border-b-0 last:pb-0"
              >
                {editingId === sec.id ? (
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <input
                      type="text"
                      value={editTopic}
                      onChange={(e) => setEditTopic(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      placeholder="章節標題..."
                    />
                    <textarea
                      value={editSummary}
                      onChange={(e) => setEditSummary(e.target.value)}
                      rows={3}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      placeholder="重點摘要..."
                    />
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">
                        關鍵決策（每行一項）：
                      </label>
                      <textarea
                        value={editDecisions}
                        onChange={(e) => setEditDecisions(e.target.value)}
                        rows={2}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        placeholder="輸入關鍵決策..."
                      />
                    </div>
                    <div className="flex items-center justify-end gap-1.5 pt-1">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-2.5 py-1 text-xs text-slate-600 hover:text-slate-900"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>儲存</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="group">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {sec.topic}
                      </h3>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] text-slate-400 font-mono-tabular">
                          {sec.updatedAt}
                        </span>
                        <button
                          onClick={() => handleStartEdit(sec)}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-blue-600 transition-opacity"
                          title="編輯章節"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteSection(sec.id)}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600 transition-opacity"
                          title="刪除章節"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed mb-2">
                      {sec.summary}
                    </p>

                    {sec.keyDecisions && sec.keyDecisions.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {sec.keyDecisions.map((dec, idx) => (
                          <div
                            key={idx}
                            className="flex items-start gap-2 text-xs text-slate-800"
                          >
                            <span className="font-mono-tabular text-blue-600 font-semibold select-none">
                              ›
                            </span>
                            <span className="leading-snug">{dec}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Bottom Half: Live Audio Transcription Stream */}
      <div className="flex flex-col flex-1 min-h-0 bg-slate-50/50">
        <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-slate-800 whitespace-nowrap">
              即時語音轉錄逐字稿
            </h3>
            <span className="text-xs text-slate-400" aria-hidden="true">
              ·
            </span>
            <span className="text-xs text-slate-500 font-mono-tabular whitespace-nowrap">
              {transcripts.length} 筆發言
            </span>
          </div>
          <span className="text-[11px] text-slate-500 whitespace-nowrap">
            純聽寫靜音模式
          </span>
        </div>

        {/* Transcript Feed */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
          {transcripts.length === 0 && !livePartialTranscript ? (
            <div className="py-6 text-center">
              <MessageSquare className="w-5 h-5 text-slate-400 mx-auto mb-1.5" />
              <p className="text-xs text-slate-500">
                等待麥克風語音輸入或測試對話注入...
              </p>
            </div>
          ) : (
            transcripts.map((tr) => (
              <div key={tr.id} className="text-xs leading-relaxed">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mb-0.5">
                  <span className="font-semibold text-slate-800">
                    {tr.speaker}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{tr.timestamp}</span>
                </div>
                <p className="text-slate-700 bg-white px-3 py-2 rounded border border-slate-200/80">
                  {tr.text}
                </p>
              </div>
            ))
          )}

          {/* Live streaming partial transcription */}
          {livePartialTranscript && (
            <div className="text-xs leading-relaxed">
              <div className="flex items-center gap-1.5 text-[11px] text-blue-600 mb-0.5">
                <span className="font-semibold">即時收音辨識中</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">LIVE</span>
              </div>
              <p className="text-slate-900 bg-blue-50/70 px-3 py-2 rounded border border-blue-200">
                {livePartialTranscript}
              </p>
            </div>
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* Manual Speech / Utterance Injection Bar */}
        <form
          onSubmit={handleManualSubmit}
          className="p-2.5 bg-white border-t border-slate-200 flex items-center gap-1.5 shrink-0"
        >
          <input
            type="text"
            value={speakerInput}
            onChange={(e) => setSpeakerInput(e.target.value)}
            className="w-20 px-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-600 shrink-0"
            placeholder="發言人"
            title="發言人名稱"
          />
          <input
            type="text"
            value={utteranceInput}
            onChange={(e) => setUtteranceInput(e.target.value)}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded text-slate-900 focus:outline-none focus:border-blue-600"
            placeholder="輸入會議發言並送入 Gemini 3.8 Live 測試..."
          />
          <button
            type="submit"
            disabled={!utteranceInput.trim()}
            className="p-1.5 text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded transition-colors shrink-0"
            title="傳送發言至 Gemini 3.8 Live"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
