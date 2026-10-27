# PulseNote Live

即時會議逐字稿、結構化紀錄、心智圖與待辦工作台。沿用 React、Vite、Express 和 Google Gemini。

## 使用

在 Google AI Studio 更新此儲存庫後，使用原本後端注入的 `GEMINI_API_KEY`。本機使用 Node.js 22.12 以上：

```sh
npm ci
# 將 .env.example 複製為 .env，填入後端 GEMINI_API_KEY
npm run dev
```

開啟 `http://localhost:3000`。正式環境先執行 `npm run build`，再以 `NODE_ENV=production` 執行 `npm start`；金鑰只放在後端。

## 即時收音

1. 按「開始即時收音」，允許麥克風。
2. 音量代表收到的真實音訊；「AI 已連線」代表 Gemini 已完成連線。
3. 即時連線失敗會顯示錯誤，並嘗試瀏覽器備援辨識。AI 整理失敗時保留逐字稿，不產生範例或假摘要。
4. 按「停止即時收音」後可下載錄音備份。

錄音會每秒分段存入**目前瀏覽器、目前網站來源的 IndexedDB**，重新整理後可取回。這不是自動寫入「下載」資料夾；需要可攜的音檔時請按「錄音備份」下載。換網址、換瀏覽器、清除網站資料或結束無痕瀏覽會影響本機備份，因此重要會議請另行下載保存。

## 會後從錄音補救

1. 開啟對應會議，停止收音，按「錄音重建」。
2. 選擇本場保存在瀏覽器的錄音段落，或選取電腦上的 WebM、MP3、M4A、WAV、OGG、FLAC、AAC 錄音檔。
3. 按「從錄音重建」。檔案會送到 Google Gemini 轉錄並整理，**結果另存新會議，原會議保留**。
4. 逐字稿先存回本機；若後續整理失敗，按「只重試整理」，不用再上傳音檔或重跑轉錄。關閉或重新整理後，也可在「待整理」的重建會議中重試。

每檔最多 200 MB；超過約 14 MB 會使用 Gemini Files API 處理長錄音，工作結束後嘗試刪除雲端暫存。每段錄音可分別重建。重建會保留來源錄音名稱，Markdown 匯出也包含來源與完成狀態。

## 修正與限制

- 收音狀態先啟動，再啟動音量計、音訊處理與辨識；真實 PCM16 / 16 kHz 音訊接入 Live API。
- 一次只建立一條即時連線，辨識來源在 Live 與瀏覽器備援間切換，避免重複逐字稿。
- 移除會依固定領域規則虛構決議、負責人與待辦的程式。未有真實發言時禁止模型同步內容。
- 心智圖限制三層、最多四個主題，每個主題最多五個子節點；折疊細節保留在 notes，避免丟失來源內容。
- 載入伺服器歷史後才同步；讀取失敗時暫停覆寫。寫檔使用暫存後更名並保留一份 `.bak`。
- Gemini 回應仍需人工核對。網路或服務完全不可用時，本機錄音仍可保存，但 AI 轉錄、摘要與重建須待服務恢復。
- 這次保留既有工作台排版；窄螢幕版面未全面重新設計。

## 開發驗證

```sh
npm run lint
npm test
npm run build
```

目前包含 18 項後端與資料測試，使用隔離 WebSocket 與合成 AI 回應，涵蓋收音格式、連線狀態、斷線、缺少金鑰、來源不足、心智圖、錄音重建、長檔上傳清理與轉錄後重試。

瀏覽器驗收另外使用 Playwright 與合成 WAV，不傳送私人錄音；需先準備 Playwright 瀏覽器。先啟動隔離測試伺服器（測試時設 `DATA_DIR` 為空白測試資料夾、`PORT=3307`、`GEMINI_API_KEY` 為空），再執行：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

可設 `TEST_BASE_URL`、`TEST_OUTPUT_DIR`、`BROWSER_EXECUTABLE`、`PLAYWRIGHT_MODULE`。測試會攔截 AI 通道與會議同步 API，驗證 11 個瀏覽器情境；輸出寫入 `test-results/`。這些測試不代表已在真實 Gemini 帳號、實體麥克風或 Google AI Studio 上驗收。

參考：[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-guide)、[音訊轉錄](https://ai.google.dev/gemini-api/docs/audio)、[Files API](https://ai.google.dev/gemini-api/docs/files)。
