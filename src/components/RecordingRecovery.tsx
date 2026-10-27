import React, { useEffect, useRef, useState } from 'react';
import { Upload, RefreshCw, X, Check } from 'lucide-react';
import type { MeetingSession } from '../types/meeting';
import { createCleanInitialMeetingSession } from '../data/sampleMeetings';
import { listRecordings, readRecording, type RecordingInfo } from '../utils/audioStorage';
import { applyRecoveredStructure } from '../utils/recovery';

const MIME_BY_EXTENSION: Record<string, string> = { webm: 'audio/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', aiff: 'audio/aiff' };

export function RecordingRecovery({ session, onRecovered, onClose }: {
  session: MeetingSession; onRecovered: (session: MeetingSession) => void; onClose: () => void;
}) {
  const source = useRef(session).current;
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const draft = useRef<MeetingSession | null>(source.recoveryStatus === 'transcript_only' ? source : null);
  const [file, setFile] = useState<File | null>(null);
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [recordingId, setRecordingId] = useState('');
  const [transcript, setTranscript] = useState(source.recoveryStatus === 'transcript_only' ? source.transcripts.map(t => t.text).join('\n') : '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('選取錄音後會另存一份重建結果，保留原會議。');
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [warning, setWarning] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    listRecordings(source.id).then(items => {
      if (!cancelled) { setRecordings(items); setRecordingId(items[0]?.id || ''); }
    }).catch(() => { if (!cancelled) setWarning('無法讀取瀏覽器錄音，仍可選取電腦裡已下載的錄音檔。'); });
    return () => { cancelled = true; controller.current?.abort(); };
  }, [source.id]);

  const close = () => { controller.current?.abort(); onClose(); };
  const keepTranscript = (text: string, filename: string) => {
    const recovered = createCleanInitialMeetingSession();
    recovered.title = `${source.title}（錄音重建・待整理）`;
    recovered.sourceMeetingId = source.id;
    recovered.sourceRecordingName = filename;
    recovered.recoveryStatus = 'transcript_only';
    recovered.transcripts = [{ id: `tr-${crypto.randomUUID()}`, speaker: '錄音轉錄', text, timestamp: new Date().toLocaleTimeString('zh-TW', { hour12: false }), isFinal: true }];
    draft.current = recovered; setTranscript(text); onRecovered(recovered);
  };

  const execute = async (retryStructure = false) => {
    setBusy(true); setError(null); setComplete(false); setWarning('');
    const abort = new AbortController(); controller.current = abort;
    let finished = false;
    try {
      if (retryStructure) {
        if (!transcript || !draft.current) throw new Error('沒有可重試的逐字稿');
        setStatus('使用已保留的逐字稿重新整理，不必再上傳錄音…');
        const response = await fetch('/api/meeting/structure-transcript', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
          body: JSON.stringify({ transcript, meetingTitle: source.title }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || '整理失敗');
        const recovered = applyRecoveredStructure(draft.current, result.data);
        draft.current = recovered; onRecovered(recovered); finished = true;
      } else {
        const recording = recordings.find(r => r.id === recordingId);
        const audio = file || (recording ? await readRecording(recording) : null);
        if (!audio) throw new Error('請先選取錄音檔或本場本機錄音');
        if (!audio.size) throw new Error('錄音檔是空的，請重新選取');
        if (audio.size > 200 * 1024 * 1024) throw new Error('錄音檔超過 200 MB，請先壓縮或分段後再試');
        const filename = file?.name || `本機錄音 ${recording?.createdAt || ''}`;
        const extension = file?.name.split('.').pop()?.toLowerCase() || '';
        const mimeType = MIME_BY_EXTENSION[extension] || audio.type.split(';')[0];
        if (!/^audio\//.test(mimeType)) throw new Error('請選取 WebM、MP3、M4A、WAV、OGG、FLAC 或 AAC 錄音');
        setStatus('正在上傳錄音檔…');
        const query = new URLSearchParams({ mimeType, meetingTitle: source.title });
        const response = await fetch(`/api/meeting/transcribe-file?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio, signal: abort.signal });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || `錄音上傳失敗（${response.status}）`);
        }
        if (!response.body) throw new Error('瀏覽器未收到處理結果，請重試');
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        const handle = (line: string) => {
          if (!line.trim()) return;
          const event = JSON.parse(line);
          if (event.type === 'progress') setStatus(event.message);
          else if (event.type === 'transcript') keepTranscript(event.text, filename);
          else if (event.type === 'result') {
            if (!draft.current) throw new Error('尚未收到逐字稿，無法保留來源');
            const recovered = applyRecoveredStructure(draft.current, event.data);
            draft.current = recovered; onRecovered(recovered); finished = true;
          } else if (event.type === 'warning') setWarning(event.message);
          else if (event.type === 'error') throw new Error(event.message);
        };
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
          if (done) { if (buffer.trim()) handle(buffer); break; }
        }
        if (!finished) throw new Error('連線在整理完成前中斷；若已收到逐字稿，可直接重試整理');
      }
      setComplete(true); setStatus('已另存重建結果：逐字稿、會議紀錄、心智圖與待辦事項。');
    } catch (err: any) {
      if (!abort.signal.aborted) { setError(err.message || '錄音重建失敗'); setStatus('處理未完成；已收到的逐字稿會保留在重建會議中。'); }
    } finally { if (!abort.signal.aborted) setBusy(false); }
  };

  return <dialog ref={dialog} aria-labelledby="recording-recovery-title" onCancel={event => { event.preventDefault(); close(); }} className="m-auto w-[calc(100%-2rem)] max-w-xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-black/40">
    <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
      <h2 id="recording-recovery-title" className="flex items-center gap-2 text-sm font-semibold"><Upload className="h-4 w-4 text-blue-600" />從錄音重建會議</h2>
      <button onClick={close} aria-label={busy ? '取消處理並關閉' : '關閉錄音重建'} className="flex h-10 w-10 items-center justify-center rounded hover:bg-slate-100"><X className="h-4 w-4" /></button>
    </div>
    <div className="space-y-4 p-5 text-sm">
      <p className="text-slate-600">即時辨識失敗也能補救。錄音會交由 Google Gemini 轉錄與整理，結果另存一份，原會議保留。</p>
      {recordings.length > 0 && <div className="space-y-1.5">
        <label htmlFor="local-recording" className="block font-medium">本場保存在此瀏覽器的錄音</label>
        <select id="local-recording" value={recordingId} disabled={busy} onChange={e => { setRecordingId(e.target.value); setFile(null); }} className="min-h-11 w-full rounded border border-slate-300 bg-white px-3">
          {recordings.map((r, i) => <option key={r.id} value={r.id}>{r.createdAt.replace('T', ' ').slice(0, 19)} · 第 {recordings.length - i} 段</option>)}
        </select>
      </div>}
      <div className="space-y-1.5">
        <label htmlFor="recovery-audio-file" className="block font-medium">選取電腦裡的錄音檔</label>
        <input id="recovery-audio-file" type="file" accept="audio/*,.webm,.mp3,.m4a,.mp4,.wav,.ogg,.flac,.aac,.aiff" disabled={busy} onChange={e => { setFile(e.target.files?.[0] || null); setComplete(false); setError(null); }} className="block min-h-11 w-full rounded border border-slate-300 p-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1" />
        <p className="text-xs text-slate-500">最多 200 MB；選取檔案時會優先使用該檔案。長錄音可能需要幾分鐘。</p>
      </div>
      <div role="status" aria-live="polite" className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed">
        {busy ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin" /> : complete ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : null}<span>{status}</span>
      </div>
      {transcript && <p className="text-xs text-emerald-700">逐字稿已保留（{transcript.length.toLocaleString()} 字），可在整理失敗後重試。</p>}
      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</p>}
      {warning && <p className="text-xs text-amber-800">{warning}</p>}
    </div>
    <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
      <button onClick={close} className="min-h-11 rounded border border-slate-300 px-3 text-sm">{busy ? '取消處理' : '關閉'}</button>
      {transcript && !complete && <button onClick={() => execute(true)} disabled={busy} className="min-h-11 rounded border border-blue-300 bg-white px-3 text-sm text-blue-700 disabled:opacity-50">只重試整理</button>}
      <button onClick={() => execute()} disabled={busy || (!file && !recordingId)} className="min-h-11 rounded bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? '正在處理…' : '從錄音重建'}</button>
    </div>
  </dialog>;
}
