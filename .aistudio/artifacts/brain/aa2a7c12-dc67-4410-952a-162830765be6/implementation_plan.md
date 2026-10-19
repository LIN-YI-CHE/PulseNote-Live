# PulseNote Live — Gemini 3.8 Live 即時會議紀錄、心智圖與待辦工作台

打造一款串接 `gemini-3.8-live` 模型的即時語音會議工作台，能在收聽會議語音的同時，透過工具呼叫（Function Calling）與即時語音轉錄，同步生成結構化會議紀錄、互動式心智圖節點與可執行的待辦事項清單。

## User Review & Critical Decisions

> [!IMPORTANT]
> 以下為根據您在第一階段確認的偏好所制定的核心產品決策，請檢視是否符合預期：

- **純聽寫與整理模式（不播放 AI 語音）**：透過 `gemini-3.8-live` 的即時音訊串流（16kHz PCM 輸入）與輸入語音轉錄（`inputAudioTranscription`），將系統指令設定為「專注傾聽與結構化萃取」，利用 Live API 的即時工具呼叫（Tool Calling）持續更新會議摘要、心智圖節點與待辦事項，並在前端攔截或靜音模型語音輸出，避免干擾會議進行。
- **三欄式即時工作台（1440px+ 桌面高密度佈局）**：同一畫面並排呈現「即時逐字稿與重點摘要」、「互動式 SVG 心智圖畫布（支援拖曳、縮放、節點新增/編輯）」與「結構化待辦事項清單」，並搭配可收合的歷史會議側邊欄。
- **本地端多場會議保存與多元匯出**：自動將每場會議的逐字稿、摘要、心智圖結構與待辦事項保存於瀏覽器 `localStorage`，支援隨時切換歷史會議、一鍵匯出完整 Markdown 報告，以及將心智圖匯出為高解析度 PNG / SVG 圖片。
- **內建測試音訊模擬器（方便即時驗證）**：除了麥克風真實收音外，提供「模擬會議語音注入 / 快速測試腳本」按鈕，讓您在單人測試環境下也能一鍵體驗 `gemini-3.8-live` 邊聽邊畫心智圖與抓待辦事項的即時動態效果。

---

## 1. Overview & Core Concept

- **What It Does**：提供零延遲感的多工會議紀錄體驗。當使用者開啟麥克風收音時，音訊透過後端 WebSocket 即時串流至 `gemini-3.8-live`；模型一邊輸出即時逐字稿，一邊自動觸發結構化工具更新畫面上的「章節式會議筆記」、「階層式心智圖」與「含負責人與優先級的待辦事項」。
- **Target Audience / Persona**：需要在會議、腦力激盪、專案同步或訪談中即時整理脈絡的產品經理、工程師與團隊主管，或想實測 `gemini-3.8-live` 即時多工推理與工具呼叫能力的開發者。
- **Key Value**：省去會後花費數小時重聽錄音與手繪心智圖的時間，在會議結束的瞬間即完成結構化紀要、視覺化脈絡圖與行動清單。

---

## 2. User Experience & Visual Design

### Key User Flows
1. **啟動或選擇會議**：進入工作台後，預設載入當前會議工作區（或可從左側收合抽屜切換歷史會議、建立新會議）。
2. **即時收音與動態更新**：點擊頂部主行動按鈕「開始即時收音」，麥克風啟動並顯示即時音訊波形與計時器。隨著對話進行：
   - **左欄（會議紀錄）**：下半部滾動顯示即時語音轉錄逐字稿（附帶時間戳記），上半部動態歸納章節式核心結論與決策重點。
   - **中欄（互動心智圖）**：自動從會議主題延伸出主幹與子節點，新生成的節點具備平滑展開動畫；使用者可自由拖曳畫布、縮放比例、點擊節點修改文字或手動新增分支。
   - **右欄（待辦事項）**：自動捕捉對話中提及的行動項目（Action Items），標註建議負責人與優先順序；支援勾選完成、篩選狀態、手動新增與行內編輯。
3. **單人快速測試流程**：若不便直接對麥克風長篇說話，可點擊工作列上的「發送測試會議語音片段」，系統將透過串流通道注入模擬的產品會議語音/文本脈絡，即時觸發 `gemini-3.8-live` 生成筆記、心智圖與待辦。
4. **匯出與歸檔**：會議結束後點擊匯出選單，可下載包含完整紀錄與待辦清單的 `.md` 檔案，或將當前心智圖畫布下載為 `.png` / `.svg` 圖檔。

### Visual Identity & Theme
- **Aesthetic Direction**：精準、高資訊密度的現代企業級 SaaS 工作台（Executive Productivity Workspace），採用單層扁平表面與 1px 細緻分隔線（Single-Elevation Depth），杜絕雜亂的卡片套疊與裝飾性膠囊標籤（Zero-Pill Discipline）。
- **Color Palette & Mood（60-30-10 原則）**：
  - **60% 主畫布背景**：清爽冷調淺灰白（`#F8FAFC`）與純白工作面板（`#FFFFFF`），確保長時間閱讀與心智圖檢視的高對比清晰度。
  - **30% 結構表面與邊框**：細緻岩灰邊框（`#E2E8F0`）、次要資訊底色（`#F1F5F9`）與沉穩深石板灰文字（`#0F172A` 主文字、`#475569` 次要文字）。
  - **10% 焦點強調色**：專業靛藍（`#2563EB`）用於主要行動與心智圖核心節點；語義狀態色嚴格搭配文字標示——翡翠綠（`#16A34A`）代表即時連線收音中、琥珀橘（`#D97706`）代表高優先待辦、緋紅（`#DC2626`）代表緊急事項或連線異常。
- **Typography & Hierarchy（2+1 字體規範）**：
  - **標題與導覽（Display）**：`Plus Jakarta Sans`（SemiBold/Bold），提供俐落現代的結構感。
  - **內文與筆記（Body）**：`Public Sans`（Regular/Medium），在 13px–15px 密集排版下具備極佳易讀性。
  - **時間戳記與數據指標（Monospace）**：`JetBrains Mono` 搭配 `tabular-nums` 等寬數字對齊，用於會議計時器、逐字稿時間戳記與節點統計，防止數字跳動造成版面位移。
- **Component Styling & Layout**：
  - **頂部導覽列（Top Bar Contract）**：嚴格遵循單列三區設計——左側為單行品牌字標与當前會議路徑、中間為檢視與歷史切換導覽連結、右側為單一核心收音控制按鈕。
  - **三欄式主工作區**：桌面版（1440px 基準）採用 `30% 會議紀錄 | 45% 互動心智圖畫布 | 25% 待辦事項` 的全高分割視窗，欄與欄之間以 1px 結構線分隔，無多餘外距浪費。
  - **中繼資料呈現**：所有時間戳記、負責人、優先級與分類皆以乾淨無框文字搭配 `·` 分隔符呈現（如 `王小明 · 高優先 · 14:02`），不使用花俏膠囊標籤。
- **Interactive Feedback & Motion**：
  - 心智圖節點新增與待辦事項浮現採用 $\le 200\text{ms}$ 的 `transform` 與 `opacity` 過渡動畫。
  - 頂部連線指示僅在 WebSocket 實際建立且串流音訊時顯示即時狀態與音量反應。

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1：使用 `gemini-3.8-live` 搭配 Function Calling 實現「純聽寫與結構化整理」**
  - *Chosen Approach*：後端透過 `@google/genai` 的 `ai.live.connect({ model: "gemini-3.8-live" })` 建立雙向串流，開啟 `inputAudioTranscription: {}` 取得即時使用者語音轉文字，同時向模型註冊三個結構化工具（`updateMeetingNotes`、`updateMindMap`、`upsertTodoItems`）。系統指令要求模型在聽到新段落或結論時立即呼叫工具更新畫面結構，並保持語音輸出簡短且前端預設靜音（不播放模型音訊串流）。
  - *Why*：`gemini-3.8-live` 原生要求 `responseModalities: [Modality.AUDIO]`，透過「後端工具呼叫 + 前端靜音音訊並提取轉錄與工具參數」的組合，既能完整發揮 `gemini-3.8-live` 對即時語音語氣與脈絡的原生理解力，又能完美符合您「不播放 AI 語音、僅即時更新畫面資訊」的需求。
  - *Alternatives Considered*：若改用傳統分段錄音上傳再呼叫文字模型，會有明顯的段落延遲且無法測試 `gemini-3.8-live` 的即時串流特性。
- **Decision 2：原生互動式 SVG 貝茲曲線心智圖引擎**
  - *Chosen Approach*：打造輕量且高客製化的 React + SVG 互動式心智圖畫布，內建自動樹狀階層排版演算法、滑鼠拖曳平移（Pan）、滾輪與按鈕縮放（Zoom）、節點展開/收合、雙擊行內編輯文字，以及直接將 SVG 轉換為高解析度 PNG / SVG 下載。
  - *Why*：相比引入龐大的第三方圖表庫，原生 SVG 引擎能確保在 AI 頻繁串流更新節點時維持 60fps 流暢動畫，且能 100% 精準控制匯出圖片的字體與樣式。
- **Decision 3：本地多場會議持久化與雙向編輯同步**
  - *Chosen Approach*：所有會議狀態即時同步至瀏覽器 `localStorage`，支援建立多場會議、重新命名、刪除與切換；當使用者手動編輯畫布上的心智圖節點或待辦事項時，亦會透過 WebSocket 同步上下文給 Live Session，避免 AI 後續覆蓋使用者的手動修改。

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Browser Client (React 19)                           │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ Top Navigation Bar: Brand Wordmark  |  Workspace Nav  |  Live Mic Control  │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────┬─────────────────────────────────┬───────────────────┐  │
│  │  Column 1: Notes     │  Column 2: Interactive Mind Map │ Column 3: To-Dos  │  │
│  │  • Structured Digest │  • Pan / Zoom SVG Canvas        │ • Filter Tabs     │  │
│  │  • Key Decisions     │  • Auto-Layout Tree Nodes       │ • Action List     │  │
│  │  • Live Transcript   │  • Inline Node Add / Edit       │ • Quick Add Form  │  │
│  │    Stream (16kHz)    │  • Export PNG / SVG             │ • Owner & Priority│  │
│  └──────────▲───────────┴────────────────▲────────────────┴─────────▲─────────┘  │
│             │                            │                          │            │
│  ┌──────────┴────────────────────────────┴──────────────────────────┴─────────┐  │
│  │         Meeting Store (React State + LocalStorage Persistence)             │  │
│  │   Audio Capture (16kHz PCM)  |  Simulated Audio Injector  |  MD Exporter   │  │
│  └───────────────────────────────────────▲────────────────────────────────────┘  │
└──────────────────────────────────────────┼───────────────────────────────────────┘
                                           │ WebSocket (/ws/live)
                                           │ • Upstream: PCM16 Audio / Context Sync
                                           │ • Downstream: Transcripts & Tool Calls
┌──────────────────────────────────────────▼───────────────────────────────────────┐
│                         Express + WebSocket Server (Node.js)                     │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                     @google/genai Live Session Bridge                      │  │
│  │  • Model: "gemini-3.8-live"                                                │  │
│  │  • Config: responseModalities: [AUDIO], inputAudioTranscription: {}        │  │
│  │  • Tools: syncMeetingNotes, syncMindMapNodes, syncTodoItems                │  │
│  └───────────────────────────────────────▲────────────────────────────────────┘  │
└──────────────────────────────────────────┼───────────────────────────────────────┘
                                           │ Bi-directional Live Stream
                                           ▼
                              ┌─────────────────────────┐
                              │  Google Gemini Live API │
                              │   (gemini-3.8-live)     │
                              └─────────────────────────┘
```

### Data Model & State
- **MeetingSession（會議紀錄實體）**：
  - `id`、`title`、`createdAt`、`updatedAt`、`durationSeconds`
  - `transcripts`：`Array<{ id, speaker, text, timestamp }>`（即時語音轉錄段落）
  - `notes`：`Array<{ id, topic, summary, keyDecisions: string[], updatedAt }>`（結構化章節會議摘要）
  - `mindMap`：`{ rootId, nodes: Array<{ id, parentId, label, category, notes?, collapsed? }> }`（階層式心智圖節點）
  - `todos`：`Array<{ id, task, assignee, priority: 'high' | 'medium' | 'low', dueDate?, completed: boolean }>`（待辦事項清單）

### Interactive Component & State Mapping
- **麥克風即時串流控制器**：點擊「開始即時收音」時，透過 `AudioContext({ sampleRate: 16000 })` 擷取麥克風音訊並轉為 16-bit Little-Endian PCM Base64 封包，經由 `/ws/live` 傳送至後端 `session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } })`。
- **模擬會議語音注入器**：點擊「載入範例會議片段」時，透過 WebSocket 傳送預設或自訂的會議對話脈絡至 `gemini-3.8-live`，立即觸發模型執行工具呼叫，方便在無麥克風環境下驗證三欄即時連動。
- **Live Tool Call 自動同步器**：當 `gemini-3.8-live` 在 `onmessage` 回傳 `toolCall`（包含 `syncMeetingNotes`、`syncMindMapNodes`、`syncTodoItems`）時，後端立即將結構化資料推播至前端更新畫面，並自動呼叫 `session.sendToolResponse` 回應成功狀態，讓模型持續傾聽後續對話。
- **心智圖畫布互動處理器**：支援滑鼠拖曳平移畫布、縮放比例控制（50%–200%）、一鍵自動置中對齊、點擊節點編輯標題、新增子節點與刪除節點，並提供「匯出 PNG」與「匯出 SVG」功能。
- **待辦事項與筆記編輯器**：支援「全部 / 待處理 / 已完成」分段篩選、點擊勾選完成狀態、手動新增待辦項目、編輯會議摘要段落，以及一鍵匯出結構化 Markdown 會議報告。
