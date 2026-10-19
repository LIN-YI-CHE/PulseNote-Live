import { MeetingSession } from '../types/meeting';

export interface SimulatedDialogueTurn {
  speaker: string;
  text: string;
}

export const SIMULATED_MEETING_SCRIPT: SimulatedDialogueTurn[] = [
  {
    speaker: '產品總監 陳雅婷',
    text: '各位好，今天我們聚焦在 Q4 智慧客服語音平台的改版計畫。核心目標是導入 Gemini 3.8 Live 模型，將端到端語音回應延遲壓低到 500 毫秒以內，並且在十一月中旬前完成企業客戶封測。請架構組的林建宏先在本週五前產出雙向 WebSocket 音訊閘道器的壓力測試報告。',
  },
  {
    speaker: '首席架構師 林建宏',
    text: '收到。目前音訊串流統一採用 16kHz PCM 格式上傳，為了確保高併發穩定度，我們決定在 Cloud Run 前端加上自動擴展策略，單一節點上限設為 200 條即時連線。另外，我需要後端工程師張哲維在 10 月 25 日前完成 Tool Calling 訂單查詢 API 的重構與逾時保護機制。',
  },
  {
    speaker: '設計主管 許庭瑜',
    text: '在前端介面部分，企業客服人員反映希望通話時不要跳出彈窗干擾，所以我們決議採用三欄式工作台：左側即時顯示語音逐字稿與客戶情緒摘要，中間動態展開問題診斷心智圖，右側則是自動勾稽的售後工單待辦。我會在下週二前交付新版 Figma 互動原型。',
  },
  {
    speaker: '資安顧問 吳柏翰',
    text: '補充一點合規要求：所有通話錄音與即時轉錄文字在存入資料庫前，必須先經過敏感個資遮罩（PII Masking），把信用卡號與身分證字號自動替換掉。這部分請資安小組在下週三前完成自動化過濾規則的驗證。',
  },
];

export const INITIAL_MEETING_SESSIONS: MeetingSession[] = [
  {
    id: 'session-default-1',
    title: 'Q4 產品研發與 Gemini 3.8 Live 導入同步會議',
    createdAt: '2026-10-18 14:00',
    updatedAt: '2026-10-18 14:12',
    durationSeconds: 185,
    transcripts: [
      {
        id: 'tr-1',
        speaker: '產品總監 陳雅婷',
        text: '今天我們主要確認 Q4 產品路線圖，特別是即時語音會議工作台的核心架構與上線時程。',
        timestamp: '14:01:12',
        isFinal: true,
      },
      {
        id: 'tr-2',
        speaker: '首席架構師 林建宏',
        text: '我們已經完成 Gemini 3.8 Live 的雙向音訊串流驗證，使用 16kHz PCM 搭配 Function Calling 可以同步更新心智圖與待辦事項，且不會播放多餘語音干擾會議。',
        timestamp: '14:02:45',
        isFinal: true,
      },
    ],
    notes: [
      {
        id: 'topic-1',
        topic: '01. 核心架構與即時語音技術選型',
        summary:
          '確立採用 Gemini 3.8 Live 模型作為即時聽寫與結構化引擎，透過 16kHz PCM 音訊串流與 Function Calling 同步輸出會議摘要、心智圖與行動清單。',
        keyDecisions: [
          '預設採用「純聽寫與整理模式」，前端靜音 AI 語音輸出以避免干擾會議進行',
          '心智圖與待辦事項透過 Live Session 工具呼叫即時增量更新',
        ],
        updatedAt: '14:02:50',
      },
    ],
    mindMapNodes: [
      {
        id: 'root',
        parentId: null,
        label: 'Q4 語音工作台計畫',
        category: 'root',
        notes: '核心目標：零延遲即時會議紀錄、心智圖與待辦同步',
      },
      {
        id: 'node-arch',
        parentId: 'root',
        label: 'Gemini 3.8 Live 架構',
        category: 'topic',
      },
      {
        id: 'node-arch-1',
        parentId: 'node-arch',
        label: '16kHz PCM 即時串流',
        category: 'detail',
      },
      {
        id: 'node-arch-2',
        parentId: 'node-arch',
        label: 'Function Calling 結構化同步',
        category: 'decision',
      },
      {
        id: 'node-ui',
        parentId: 'root',
        label: '三欄式高密度工作區',
        category: 'topic',
      },
      {
        id: 'node-ui-1',
        parentId: 'node-ui',
        label: '即時逐字稿與章節摘要',
        category: 'detail',
      },
      {
        id: 'node-ui-2',
        parentId: 'node-ui',
        label: '互動式 SVG 心智圖畫布',
        category: 'decision',
      },
      {
        id: 'node-action',
        parentId: 'root',
        label: '近期關鍵交付項目',
        category: 'action',
      },
    ],
    todos: [
      {
        id: 'todo-1',
        task: '完成雙向 WebSocket 音訊串流閘道器壓力測試報告',
        assignee: '林建宏',
        priority: 'high',
        dueDate: '本週五',
        completed: false,
        createdAt: '14:02:10',
      },
      {
        id: 'todo-2',
        task: '實作心智圖高解析度 PNG 與 Markdown 會議報告匯出功能',
        assignee: '前端團隊',
        priority: 'medium',
        dueDate: '10/25',
        completed: true,
        createdAt: '14:03:00',
      },
    ],
  },
];
