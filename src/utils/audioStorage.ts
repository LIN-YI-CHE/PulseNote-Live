export type RecordingInfo = { id: string; sessionId: string; mimeType: string; createdAt: string };
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('pulsenote_audio_v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
      recordings.createIndex('sessionId', 'sessionId');
      const chunks = db.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] });
      chunks.createIndex('recordingId', 'recordingId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}

// Each one-second chunk is committed independently so a refresh need not erase
// the entire recording. No audio is uploaded by this local storage module.
export async function saveAudioChunk(info: RecordingInfo, index: number, blob: Blob) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
    tx.objectStore('recordings').put(info);
    tx.objectStore('chunks').put({ recordingId: info.id, index, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('本機錄音儲存中斷'));
  });
}

export async function listRecordings(sessionId: string): Promise<RecordingInfo[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('recordings').objectStore('recordings').index('sessionId').getAll(sessionId);
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function readRecording(info: RecordingInfo): Promise<Blob> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('chunks').objectStore('chunks').index('recordingId').getAll(info.id);
    request.onsuccess = () => {
      const chunks = request.result.sort((a, b) => a.index - b.index);
      if (!chunks.length) return reject(new Error('找不到本機錄音內容，請選取已下載的錄音檔'));
      resolve(new Blob(chunks.map(chunk => chunk.blob), { type: info.mimeType }));
    };
    request.onerror = () => reject(request.error);
  });
}
