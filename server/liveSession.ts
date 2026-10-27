import { WebSocket } from 'ws';
import { Modality } from '@google/genai';
import { compactMindMap } from '../src/utils/mindMap';

type Options = { getAI: () => any; model: string; textModel: string; instruction: string; declarations: any[] };

// One upstream session per browser connection. Readiness means the SDK setup completed.
export function attachLiveSession(client: WebSocket, options: Options) {
  let live: any = null;
  let generation = 0;
  let closed = false;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let resumeHandle: string | undefined;
  let evidence = '';
  let context = '';
  let structuredState: any = {};
  let map: any[] = [];
  let lastSync = Date.now();
  let lastAudio = 0;
  let textQueue = Promise.resolve();
  let structureTimer: ReturnType<typeof setTimeout> | undefined;
  let evidenceVersion = 0;
  let notesVersion = 0;
  const send = (payload: any) => { if (!closed && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload)); };
  const fail = (error: any) => {
    send({ type: 'error', code: 'LIVE_UNAVAILABLE', message: `即時 AI 連線失敗：${error?.message || String(error)}。錄音備份仍可繼續；可使用瀏覽器備援辨識。` });
    send({ type: 'session_status', status: 'degraded', mode: 'browser_speech', message: '即時 AI 尚未就緒；逐字稿使用瀏覽器備援，整理須待 AI 服務恢復。' });
  };
  const sync = (name: string, args: any, id?: string) => {
    if (!evidence.trim()) return false;
    if (name === 'syncMindMapNodes' && Array.isArray(args?.nodes)) {
      const merged = new Map(map.map(n => [n.id, n]));
      for (const node of args.nodes) merged.set(node.id, node);
      map = compactMindMap([...merged.values()]);
      args = { nodes: map, replace: true };
    }
    if (!options.declarations.some(d => d.name === name)) return false;
    if (name === 'syncMeetingNotes' || name === 'syncTodoItems') {
      const key = name === 'syncMeetingNotes' ? 'sections' : 'todos';
      const identity = key === 'sections' ? 'topic' : 'task';
      const merged = [...(Array.isArray(structuredState[key]) ? structuredState[key] : [])];
      for (const item of Array.isArray(args?.[key]) ? args[key] : []) {
        const index = merged.findIndex(old => old.id === item.id || old[identity] === item[identity]);
        if (index >= 0) merged[index] = item; else merged.push(item);
      }
      structuredState[key] = merged;
    }
    structuredState.nodes = map;
    context = JSON.stringify(structuredState);
    lastSync = Date.now();
    if (name === 'syncMeetingNotes') notesVersion = evidenceVersion;
    send({ type: 'tool_call', toolName: name, args, callId: id, timestamp: new Date().toLocaleTimeString('zh-TW', { hour12: false }) });
    return true;
  };
  const nudge = () => {
    if (live && evidence.trim()) live.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '請只根據已收到的真實會議發言更新摘要、心智圖與待辦。沒有新資訊就不要新增；未達成的決議不得當作決策。' }] }], turnComplete: true });
  };
  const connect = () => {
    if (connecting || closed) return connecting || Promise.resolve();
    const token = ++generation;
    const old = live; live = null;
    try { old?.close(); } catch {}
    send({ type: 'session_status', status: 'connecting' });
    let failed = false;
    let pendingResponses: any[] = [];
    const current = () => !closed && token === generation;
    const recover = (error: any, fatal = false) => {
      if (!current() || failed) return;
      failed = true; live = null;
      fail(error);
      if (!fatal && retries++ < 3) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, Math.min(1000 * 2 ** retries, 8000));
      }
    };
    connecting = (async () => {
      await Promise.resolve();
      try {
        const session = await options.getAI().live.connect({
          model: options.model,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            systemInstruction: `${options.instruction}\n僅依實際輸入整理，禁止使用示範內容或自行補造決議。未有會議語音或文字時不得呼叫工具。\n${context}`,
            tools: [{ functionDeclarations: options.declarations }],
            sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
            contextWindowCompression: { slidingWindow: {} },
          },
          callbacks: {
            onopen() {},
            onmessage(message: any) {
              if (!current() || failed) return;
              if (message.sessionResumptionUpdate?.resumable) resumeHandle = message.sessionResumptionUpdate.newHandle;
              const transcription = message.serverContent?.inputTranscription;
              if (transcription?.text) {
                evidence = (evidence + transcription.text).slice(-40000);
                evidenceVersion++;
                send({ type: 'input_transcription', text: transcription.text });
                if (!structureTimer) structureTimer = setTimeout(() => {
                  structureTimer = undefined;
                  if (closed || notesVersion >= evidenceVersion) return;
                  textQueue = textQueue.then(() => fallbackStructure()).catch(error => send({ type: 'error', message: `逐字稿已保留，但重點整理失敗：${error?.message || error}` }));
                }, 8000);
              }
              if (transcription?.finished || message.serverContent?.turnComplete || message.serverContent?.interrupted) send({ type: 'turn_complete' });
              const responses = (message.toolCall?.functionCalls || []).map((call: any) => ({
                id: call.id, name: call.name, response: { synced: sync(call.name, call.args, call.id) },
              }));
              if (responses.length) {
                if (live) live.sendToolResponse({ functionResponses: responses });
                else pendingResponses.push(...responses);
              }
              if (message.goAway) {
                send({ type: 'session_rollover', message: '即時服務正在延續連線，錄音備份持續中。' });
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, 100);
              }
            },
            onerror(error: any) { recover(error, /401|403|404|1008|API.?key|permission|quota|not found/i.test(error?.message || '')); },
            onclose(event: any) { recover(new Error(`服務已關閉（${event?.code || '未知代碼'}）：${event?.reason || ''}`), event?.code === 1008); },
          },
        });
        if (!current() || failed) { session.close(); return; }
        live = session;
        if (pendingResponses.length) live.sendToolResponse({ functionResponses: pendingResponses });
        pendingResponses = [];
        send({ type: 'session_status', status: 'connected', model: options.model, message: '即時 AI 已就緒 · 真實語音轉錄與整理中' });
      } catch (error) { if (current()) { failed = true; live = null; fail(error); } }
      finally { if (token === generation) connecting = null; }
    })();
    return connecting;
  };
  const fallbackStructure = async () => {
    const version = evidenceVersion;
    const properties = Object.assign({}, ...options.declarations.map(d => d.parameters.properties));
    const result = await options.getAI().models.generateContent({
      model: options.textModel,
      contents: `${options.instruction}\n只根據以下真實逐字稿整理；未知人員填待指派，未達成決議時 keyDecisions 留空，不得套用範例。\n既有結構：${context}\n逐字稿：${evidence}\n回傳 JSON {sections: [], nodes: [], todos: []}，沿用既有 ID。`,
      config: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties, required: ['sections', 'nodes', 'todos'] } },
    });
    if (closed) return;
    const data = JSON.parse(result.text || '{}');
    if (!Array.isArray(data.sections) || !Array.isArray(data.nodes) || !Array.isArray(data.todos)) throw new Error('AI 整理回應格式不完整');
    for (const [name, key] of [['syncMeetingNotes', 'sections'], ['syncMindMapNodes', 'nodes'], ['syncTodoItems', 'todos']]) sync(name, { [key]: data[key] });
    notesVersion = version;
  };
  const ping = setInterval(() => send({ type: 'ping' }), 15000);
  const watchdog = setInterval(() => {
    if (lastAudio && Date.now() - lastAudio < 6000 && Date.now() - lastSync > 20000) { try { nudge(); lastSync = Date.now(); } catch (error) { fail(error); } }
  }, 10000);
  client.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'session_start') {
        context = typeof msg.context === 'string' ? msg.context.slice(-40000) : '';
        try { const initial = JSON.parse(context || '{}'); structuredState = { title: initial.title, sections: initial.notes || [], todos: initial.todos || [] }; }
        catch { structuredState = {}; }
        map = compactMindMap(Array.isArray(msg.nodes) ? msg.nodes : []);
        evidence = typeof msg.transcript === 'string' ? msg.transcript.slice(-40000) : '';
        void connect();
      } else if (msg.type === 'reconnect_live') {
        retries = 0; clearTimeout(reconnectTimer); void connect();
      } else if (msg.type === 'audio' && typeof msg.audio === 'string' && live) {
        lastAudio = Date.now();
        live.sendRealtimeInput({ audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' } });
      } else if (msg.type === 'audio_end') {
        live?.sendRealtimeInput({ audioStreamEnd: true });
      } else if (msg.type === 'text_input' && typeof msg.text === 'string' && msg.text.trim()) {
        evidence = `${evidence}\n${msg.speaker || '與會者'}：${msg.text}`.slice(-40000);
        evidenceVersion++;
        textQueue = textQueue.then(async () => {
          await connecting;
          if (closed) return;
          if (live) live.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `真實會議發言：${msg.text}` }] }], turnComplete: true });
          else await fallbackStructure();
        }).catch(error => { send({ type: 'error', message: `逐字稿已保留，但 AI 整理失敗：${error?.message || error}` }); });
      } else if (msg.type === 'nudge_sync') { nudge(); }
    } catch (error: any) { send({ type: 'error', message: `即時資料處理失敗：${error?.message || error}` }); }
  });
  client.on('close', () => {
    closed = true; generation++; clearInterval(ping); clearInterval(watchdog); clearTimeout(reconnectTimer);
    clearTimeout(structureTimer);
    try { live?.close(); } catch {}
  });
}
