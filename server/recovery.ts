import { setTimeout as delay } from 'node:timers/promises';
import { compactMindMap } from '../src/utils/mindMap';

export type RecoveryOptions = {
  getAI: () => any; transcribeModel: string; textModel: string; schema: any;
  signal?: AbortSignal; emit: (event: any) => void;
};

export async function recoverRecording(audio: Buffer, mimeType: string, title: string, options: RecoveryOptions) {
  const ai = options.getAI();
  let uploaded: any;
  let transcript = '';
  let stage = 'transcribing';
  try {
    options.emit({ type: 'progress', stage, message: '正在將錄音轉成逐字稿…' });
    let audioPart: any;
    // Base64 expands by 4/3; use the Files API well below the 20 MB request cap.
    if (audio.length > 14 * 1024 * 1024) {
      options.emit({ type: 'progress', stage: 'processing_file', message: '正在準備長錄音…' });
      uploaded = await ai.files.upload({ file: new Blob([new Uint8Array(audio)], { type: mimeType }), config: { mimeType, displayName: 'PulseNote meeting recovery', abortSignal: options.signal } });
      const deadline = Date.now() + 120000;
      while (uploaded.state === 'PROCESSING') {
        if (Date.now() > deadline) throw new Error('長錄音處理逾時，請稍後重試或分段上傳');
        await delay(1000, undefined, { signal: options.signal });
        uploaded = await ai.files.get({ name: uploaded.name });
      }
      if (uploaded.state === 'FAILED' || !uploaded.uri) throw new Error('錄音檔處理失敗，請確認檔案可播放');
      audioPart = { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || mimeType } };
    } else audioPart = { inlineData: { data: audio.toString('base64'), mimeType } };
    const response = await ai.models.generateContent({
      model: options.transcribeModel,
      contents: { parts: [audioPart, { text: '請精確逐字轉錄這段會議錄音為繁體中文，依語言內容保留專有名詞。可辨識時標示說話者與時間；無法辨識的人名不可猜測。只轉錄實際語音，沒有語音就回傳空字串，不要補造內容或做摘要。' }] },
      config: { abortSignal: options.signal, maxOutputTokens: 65536, httpOptions: { timeout: 300000 } },
    });
    transcript = (response.text || '').trim();
    if (!transcript) throw new Error('錄音未辨識出語音，請確認選到正確且可播放的錄音檔');
    options.emit({ type: 'transcript', text: transcript });
    stage = 'structuring';
    options.emit({ type: 'progress', stage, message: '逐字稿已保留，正在整理會議紀錄、心智圖與待辦…' });
    const data = await structureTranscript(transcript, title, options);
    options.emit({ type: 'result', data });
    return { transcript, data };
  } catch (error: any) {
    if (options.signal?.aborted) throw error;
    options.emit({ type: 'error', stage, message: error?.message || '錄音重建失敗', transcriptRetained: Boolean(transcript) });
    return { transcript, error: error?.message || '錄音重建失敗' };
  } finally {
    if (uploaded?.name) {
      try { await ai.files.delete({ name: uploaded.name }); }
      catch { options.emit({ type: 'warning', message: '雲端暫存檔未能立即刪除，Google Files API 會在 48 小時後自動刪除。' }); }
    }
  }
}

export async function structureTranscript(transcript: string, title: string, options: Omit<RecoveryOptions, 'emit' | 'transcribeModel'>) {
  if (!transcript.trim()) throw new Error('缺少可整理的逐字稿');
  const response = await options.getAI().models.generateContent({
    model: options.textModel,
    contents: `根據以下真實會議逐字稿，整理結構化章節摘要 sections、心智圖 mindMapNodes 與待辦 todos。只使用逐字稿中的事實，不得補造人名、決策、任務或期限。未達成決議時 keyDecisions 留空，未指定負責人填待指派，未指定期限留空。章節最多5個，心智圖最多三層 root -> topic -> decision/action/detail，直屬root的主題最多4個，每主題最多5個子節點，細節寫入notes；主題不足時不要湊數。\n會議標題（僅供命名）：${title}\n逐字稿：\n${transcript}`,
    config: { responseMimeType: 'application/json', responseSchema: options.schema, abortSignal: options.signal, httpOptions: { timeout: 180000 } },
  });
  const parsed = JSON.parse(response.text || '{}');
  if (!Array.isArray(parsed.sections) || !Array.isArray(parsed.mindMapNodes) || !Array.isArray(parsed.todos)) throw new Error('AI 整理回應不完整，逐字稿已保留，可重試整理');
  return { ...parsed, mindMapNodes: compactMindMap(parsed.mindMapNodes) };
}
