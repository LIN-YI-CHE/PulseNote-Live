const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3307';
const root = path.resolve(process.env.TEST_OUTPUT_DIR || 'test-results');
fs.mkdirSync(root, { recursive: true });
const results = [];
const errors = [];
const tone = path.join(root, 'test-tone.wav');
const data = Buffer.alloc(16000 * 2 * 4);
for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 12000), i * 2);
const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
fs.writeFileSync(tone, Buffer.concat([header, data]));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`] });
  try {
    async function pageFor(mode, options = {}) {
      const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 }, permissions: ['microphone'] });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      const stats = { sockets: 0, audio: 0, pcmBytes: 0, syncs: [], sentTranscript: false };
      await page.route('**/api/sessions', async route => {
        if (options.hydrationFailure) return route.fulfill({ status: 503, body: '{}' });
        await route.fulfill({ json: { success: true, sessions: options.remoteSessions || [] } });
      });
      await page.route('**/api/sessions/sync', async route => { stats.syncs.push(route.request().postDataJSON()); await route.fulfill({ json: { success: true } }); });
      await page.addInitScript(() => {
        window.__recognitionStarts = 0; window.__micCalls = 0;
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (...args) => { window.__micCalls++; return original(...args); };
        class FakeRecognition {
          start() {
            window.__recognitionStarts++; this.onstart?.();
            this.timer = setTimeout(() => {
              const interim = [{ transcript: '備援辨識測試發言' }]; interim.isFinal = false;
              this.onresult?.({ resultIndex: 0, results: [interim] });
              this.finalTimer = setTimeout(() => {
                const final = [{ transcript: '備援辨識測試發言' }]; final.isFinal = true;
                this.onresult?.({ resultIndex: 0, results: [final] });
              }, 1200);
            }, 100);
          }
          abort() { clearTimeout(this.timer); clearTimeout(this.finalTimer); this.onend?.(); }
        }
        window.SpeechRecognition = FakeRecognition;
        window.webkitSpeechRecognition = FakeRecognition;
      });
      if (options.denyMic) await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
      if (options.force48k) await page.addInitScript(() => {
        const OriginalAudioContext = window.AudioContext;
        window.AudioContext = class extends OriginalAudioContext { constructor() { super({ sampleRate: 48000 }); } };
      });
      await page.routeWebSocket('**/ws/live', ws => {
        stats.sockets++;
        ws.onMessage(raw => {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'session_start') ws.send(JSON.stringify({ type: 'session_status', status: mode === 'degraded' ? 'degraded' : 'connected', message: mode === 'degraded' ? '備援模式測試' : '即時 AI 測試通道已就緒' }));
          if (msg.type === 'audio') {
            stats.audio++; stats.pcmBytes = Buffer.from(msg.audio, 'base64').length;
            if (stats.audio >= 3 && !stats.sentTranscript) {
              stats.sentTranscript = true;
              ws.send(JSON.stringify({ type: 'input_transcription', text: '星期五交付合成測試報告。' }));
              ws.send(JSON.stringify({ type: 'turn_complete' }));
              ws.send(JSON.stringify({ type: 'tool_call', toolName: 'syncMeetingNotes', timestamp: '12:00', args: { sections: [{ id: 'n1', topic: '合成測試交付', summary: '星期五交付合成測試報告。', keyDecisions: [] }] } }));
              ws.send(JSON.stringify({ type: 'tool_call', toolName: 'syncMindMapNodes', timestamp: '12:00', args: { nodes: [{ id: 'root', parentId: null, label: '測試會議' }, { id: 'topic', parentId: 'root', label: '合成測試' }, { id: 'decision', parentId: 'topic', label: '星期五交付' }] } }));
              ws.send(JSON.stringify({ type: 'tool_call', toolName: 'syncTodoItems', timestamp: '12:00', args: { todos: [{ id: 'todo', task: '交付合成測試報告', assignee: '待指派', priority: 'medium' }] } }));
            }
          }
          if (msg.type === 'text_input') stats.lastText = msg.text;
        });
      });
      await page.goto(base); await page.getByRole('button', { name: '開始即時收音', exact: true }).waitFor();
      return { context, page, stats };
    }
    const f = await pageFor('connected', { force48k: true });
    assert.equal(await f.page.getByText(/示範劇本|產品研發與 Gemini|智慧客服語音平台/).count(), 0);
    results.push({ name: 'fresh-session-no-demo', status: 'PASS' });
    await f.page.getByRole('button', { name: '開始即時收音', exact: true }).click();
    await f.page.getByText('合成測試交付', { exact: true }).waitFor();
    assert.ok(f.stats.audio >= 3); assert.ok(f.stats.pcmBytes > 0 && f.stats.pcmBytes <= 8192 && f.stats.pcmBytes % 2 === 0);
    assert.equal(f.stats.pcmBytes, 2730, '48 kHz microphone frames must be downsampled to 16 kHz PCM16');
    assert.equal(f.stats.sockets, 1); assert.equal(await f.page.evaluate(() => window.__recognitionStarts), 0);
    await f.page.waitForFunction(() => Number(document.querySelector('[title^="麥克風即時音量"]')?.title.match(/(\d+)%/)?.[1]) > 0);
    const session = () => f.page.evaluate(() => JSON.parse(localStorage.getItem('pulsenote_live_sessions_v1'))[0]);
    const saved = await session(); assert.equal(saved.transcripts.length, 1); assert.equal(saved.notes.length, 1); assert.equal(saved.todos.length, 1); assert.equal(saved.mindMapNodes.length, 3);
    results.push({ name: 'real-web-audio-pcm-transcript-notes-map-todos', status: 'PASS', packets: f.stats.audio, pcmBytes: f.stats.pcmBytes });
    await f.page.getByRole('button', { name: '停止即時收音', exact: true }).click();
    await f.page.getByRole('link', { name: '錄音備份', exact: true }).waitFor();
    const backupBytes = await f.page.getByRole('link', { name: '錄音備份', exact: true }).evaluate(async a => (await (await fetch(a.href)).blob()).size);
    assert.ok(backupBytes > 100);
    const decodedDuration = await f.page.getByRole('link', { name: '錄音備份', exact: true }).evaluate(async a => {
      const audio = new AudioContext();
      try { return (await audio.decodeAudioData(await (await fetch(a.href)).arrayBuffer())).duration; }
      finally { await audio.close(); }
    });
    assert.ok(decodedDuration > 0);
    results.push({ name: 'stop-releases-mic-and-produces-audio-backup', status: 'PASS', backupBytes });
    await f.page.getByRole('button', { name: '開始即時收音', exact: true }).click();
    await f.page.getByRole('button', { name: '停止即時收音', exact: true }).waitFor();
    await f.page.waitForTimeout(1300);
    await f.page.getByRole('button', { name: '停止即時收音', exact: true }).click();
    assert.equal(await f.page.evaluate(() => window.__micCalls), 2); assert.equal(f.stats.sockets, 1);
    results.push({ name: 'restart-reuses-single-live-connection', status: 'PASS' });
    await f.page.reload();
    await f.page.getByRole('link', { name: '錄音備份', exact: true }).waitFor();
    const restoredBytes = await f.page.getByRole('link', { name: '錄音備份', exact: true }).evaluate(async a => (await (await fetch(a.href)).blob()).size);
    assert.ok(restoredBytes > 0);
    results.push({ name: 'recording-survives-reload-in-indexeddb', status: 'PASS', restoredBytes });
    const sourceBefore = await session();
    const recoveryData = { sections: [{ id: 'rnote', topic: '錄音補救成功', summary: '星期五交付合成測試報告。', keyDecisions: [] }], mindMapNodes: [{ id: 'root', parentId: null, label: '錄音重建' }, { id: 'rtopic', parentId: 'root', label: '交付' }], todos: [{ id: 'rtodo', task: '錄音重建待辦', assignee: '待指派', priority: 'medium' }] };
    await f.page.route('**/api/meeting/transcribe-file?**', async route => {
      assert.ok(route.request().postDataBuffer().length > 0);
      await route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'progress', stage: 'transcribing', message: '合成轉錄中' },
        { type: 'transcript', text: '星期五交付合成測試報告。' },
        { type: 'progress', stage: 'structuring', message: '合成整理中' },
        { type: 'result', data: recoveryData },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
    await f.page.getByRole('button', { name: '錄音重建', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelectorAll('#local-recording option').length === 2);
    assert.equal(await f.page.locator('#local-recording option').count(), 2);
    await f.page.getByRole('button', { name: '從錄音重建', exact: true }).click();
    await f.page.getByText('已另存重建結果：逐字稿、會議紀錄、心智圖與待辦事項。', { exact: true }).waitFor();
    const reconstructed = await f.page.evaluate(() => JSON.parse(localStorage.getItem('pulsenote_live_sessions_v1')));
    assert.equal(reconstructed.length, 2);
    const recovered = reconstructed.find(s => s.sourceMeetingId === sourceBefore.id);
    assert.equal(recovered.recoveryStatus, 'complete'); assert.equal(recovered.transcripts.length, 1); assert.equal(recovered.notes.length, 1); assert.equal(recovered.todos.length, 1);
    assert.deepEqual(reconstructed.find(s => s.id === sourceBefore.id).transcripts, sourceBefore.transcripts);
    results.push({ name: 'local-recording-rebuilds-all-columns-without-overwriting-original', status: 'PASS' });
    await f.page.screenshot({ path: path.join(root, 'verified-recording-recovery.png'), fullPage: true });
    await f.page.getByRole('button', { name: '關閉錄音重建', exact: true }).click();
    await f.page.screenshot({ path: path.join(root, 'verified-desktop.png'), fullPage: true });
    await f.context.close();

    const g = await pageFor('degraded');
    await g.page.getByRole('button', { name: '開始即時收音', exact: true }).click();
    await g.page.waitForFunction(() => JSON.parse(localStorage.getItem('pulsenote_live_sessions_v1'))[0].transcripts.length === 1);
    await g.page.waitForTimeout(400);
    assert.equal(await g.page.evaluate(() => JSON.parse(localStorage.getItem('pulsenote_live_sessions_v1'))[0].transcripts.length), 1);
    assert.equal(g.stats.audio, 0); assert.equal(g.stats.lastText, '備援辨識測試發言');
    await g.page.getByRole('button', { name: '停止即時收音', exact: true }).click();
    await g.page.getByRole('button', { name: '開始即時收音', exact: true }).click();
    await g.page.waitForFunction(() => window.__recognitionStarts === 2);
    await g.page.getByRole('button', { name: '停止即時收音', exact: true }).click();
    results.push({ name: 'degraded-browser-fallback-no-duplicate-final-and-restart', status: 'PASS' });
    await g.context.close();

    const denied = await pageFor('connected', { denyMic: true });
    await denied.page.getByRole('button', { name: '開始即時收音', exact: true }).click();
    await denied.page.getByText(/瀏覽器尚未授予麥克風權限/).waitFor();
    assert.equal(denied.stats.sockets, 0);
    assert.ok(await denied.page.getByRole('button', { name: '開始即時收音', exact: true }).isEnabled());
    results.push({ name: 'mic-denied-no-false-recording-or-false-connection', status: 'PASS' });
    await denied.context.close();

    const retry = await pageFor('connected'); let audioRequests = 0; let structureRequests = 0;
    await retry.page.route('**/api/meeting/transcribe-file?**', async route => {
      audioRequests++;
      await route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'transcript', text: '先保留錄音逐字稿，之後重試整理。' },
        { type: 'error', stage: 'structuring', message: '合成整理失敗' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
    await retry.page.route('**/api/meeting/structure-transcript', async route => {
      structureRequests++; assert.equal(route.request().postDataJSON().transcript, '先保留錄音逐字稿，之後重試整理。');
      await route.fulfill({ json: { success: true, data: recoveryData } });
    });
    await retry.page.getByRole('button', { name: '錄音重建', exact: true }).click();
    await retry.page.locator('#recovery-audio-file').setInputFiles(tone);
    await retry.page.getByRole('button', { name: '從錄音重建', exact: true }).click();
    await retry.page.getByRole('alert').filter({ hasText: '合成整理失敗' }).waitFor();
    const partial = await retry.page.evaluate(() => JSON.parse(localStorage.getItem('pulsenote_live_sessions_v1')).find(s => s.recoveryStatus === 'transcript_only'));
    assert.ok(partial); assert.equal(partial.transcripts.length, 1); assert.equal(partial.notes.length, 0);
    await retry.page.getByRole('button', { name: '關閉錄音重建', exact: true }).click();
    await retry.page.reload();
    // The current recovered meeting remains selectable after reload; reopen it from history.
    await retry.page.getByRole('button', { name: '會議列表', exact: true }).click();
    await retry.page.getByText(partial.title, { exact: true }).last().click();
    await retry.page.getByRole('button', { name: '錄音重建', exact: true }).click();
    await retry.page.getByRole('button', { name: '只重試整理', exact: true }).click();
    await retry.page.getByText('已另存重建結果：逐字稿、會議紀錄、心智圖與待辦事項。', { exact: true }).waitFor();
    assert.equal(audioRequests, 1); assert.equal(structureRequests, 1);
    results.push({ name: 'uploaded-file-structure-failure-keeps-transcript-and-retries-after-reload-without-audio-upload', status: 'PASS' });
    await retry.context.close();

    const failedHistory = await pageFor('connected', { hydrationFailure: true });
    await failedHistory.page.waitForTimeout(1800); assert.equal(failedHistory.stats.syncs.length, 0);
    results.push({ name: 'failed-history-load-never-overwrites-server-data', status: 'PASS' });
    await failedHistory.context.close();

    const remote = { id: 'synthetic-server-history', title: '合成伺服器歷史', transcripts: [], notes: [], todos: [], mindMapNodes: [], durationSeconds: 0, createdAt: '2026-10-27', updatedAt: '2026-10-27' };
    const history = await pageFor('connected', { remoteSessions: [remote], viewport: { width: 390, height: 844 } });
    await history.page.waitForFunction(() => JSON.parse(localStorage.getItem('pulsenote_live_sessions_v1')).some(s => s.id === 'synthetic-server-history'));
    await history.page.waitForTimeout(1800); assert.ok(history.stats.syncs[0].sessions.some(s => s.id === remote.id));
    await history.page.screenshot({ path: path.join(root, 'verified-mobile.png'), fullPage: true });
    results.push({ name: 'server-history-preserved-and-mobile-renders', status: 'PASS' });
    await history.context.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(root, 'ui-results.json'), JSON.stringify({ results, pageErrors: errors, provider: 'mock', microphone: 'Chromium synthetic WAV', liveGoogleTest: 'NOT_RUN' }, null, 2));
    console.log(JSON.stringify({ results, errors }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
