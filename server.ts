import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { attachLiveSession } from "./server/liveSession";
import { recoverRecording, structureTranscript } from "./server/recovery";
import { compactMindMap } from "./src/utils/mindMap";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import {
  GoogleGenAI,
  Type,
  FunctionDeclaration,
} from "@google/genai";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-transcribe";

function getGenAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("Missing GEMINI_API_KEY in environment variables.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Tool declarations for Gemini 3.8 Live to continuously structure meeting content
const syncMeetingNotesDeclaration: FunctionDeclaration = {
  name: "syncMeetingNotes",
  description:
    "即時新增或更新會議紀錄的重點章節摘要與關鍵決策。當聽到新的討論主題、結論或重要資訊時立即呼叫。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sections: {
        type: Type.ARRAY,
        description: "會議章節摘要清單",
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.STRING,
              description: "章節唯一識別碼（例如 topic-1, topic-2）",
            },
            topic: {
              type: Type.STRING,
              description: "討論主題標題（繁體中文）",
            },
            summary: {
              type: Type.STRING,
              description: "該主題的精煉重點摘要（繁體中文）",
            },
            keyDecisions: {
              type: Type.ARRAY,
              description: "該主題下達成的具體決策或關鍵數據",
              items: { type: Type.STRING },
            },
          },
          required: ["id", "topic", "summary", "keyDecisions"],
        },
      },
    },
    required: ["sections"],
  },
};

// Refined to enforce strict 3-tier mind map architecture and avoid microscopic fragmented branches
const syncMindMapNodesDeclaration: FunctionDeclaration = {
  name: "syncMindMapNodes",
  description:
    "即時新增或更新心智圖（Mind Map）的節點結構。必須嚴格遵循【3~4個核心主幹收斂原則】：中心根節點（id='root', parentId='NONE'）下方，第一階討論主軸（category='topic', parentId='root'）嚴格限制最多 3 至 4 個主題支柱！絕對禁止在第一階散落過多分支！同一面向或同件事的討論，必須歸類在對應主題柱底下作為 Level 2 子節點，或作為具體關鍵決策與行動（Level 3, category='decision' | 'action'）。請自動對同類議題進行語義收斂與合併，消除多餘分叉，嚴格維持精煉易讀的三層架構。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      nodes: {
        type: Type.ARRAY,
        description:
          "要新增或更新的心智圖節點陣列（中心根節點 + 最多 3~4 個一級主題柱 + 柱下的二級子節點與三級決策，最多 3 層深度）",
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.STRING,
              description: "節點唯一 ID（例如 'root', 'pillar-1', 'sub-1'）",
            },
            parentId: {
              type: Type.STRING,
              description:
                "父節點 ID。根節點填寫 'NONE'；第一階核心支柱（最多3~4個）填寫 'root'；其餘子議題與決策請填寫所屬支柱的 ID，切勿直接掛在 root 底下！",
            },
            label: {
              type: Type.STRING,
              description: "節點顯示名稱（精煉有力，12字以內，繁體中文）",
            },
            category: {
              type: Type.STRING,
              description:
                "節點類型：'root' | 'topic' | 'decision' | 'action'",
            },
            notes: {
              type: Type.STRING,
              description: "該節點的細部說明或補充（避免拆成過多碎節點，細節請填在此處）",
            },
          },
          required: ["id", "parentId", "label", "category"],
        },
      },
    },
    required: ["nodes"],
  },
};

const syncTodoItemsDeclaration: FunctionDeclaration = {
  name: "syncTodoItems",
  description:
    "即時新增或更新會議中產生的待辦事項（Action Items / To-Dos），包含任務內容、負責人與優先級。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      todos: {
        type: Type.ARRAY,
        description: "待辦事項清單",
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.STRING,
              description: "待辦事項唯一 ID（例如 'todo-1', 'todo-2'）",
            },
            task: {
              type: Type.STRING,
              description: "具體可執行的待辦任務描述（繁體中文）",
            },
            assignee: {
              type: Type.STRING,
              description: "負責人姓名或職稱（若未明確提及可填寫 '待指派' 或部門名稱）",
            },
            priority: {
              type: Type.STRING,
              description: "優先級：'high' | 'medium' | 'low'",
            },
            dueDate: {
              type: Type.STRING,
              description: "預計完成時間或期限（例如 '本週五', '10/25'，選填）",
            },
          },
          required: ["id", "task", "assignee", "priority"],
        },
      },
    },
    required: ["todos"],
  },
};

const SYSTEM_INSTRUCTION = `你是繁體中文即時會議紀錄助手。只根據實際收到的會議語音或文字，透過三個工具更新畫面。
1. syncMeetingNotes：聚合同一議題並沿用既有 ID，最多 5 個章節；主題不足時不要湊數。摘要寫事實，keyDecisions 只列出已明確達成的決議，未達成時留空。
2. syncMindMapNodes：最多三層 root -> topic -> decision/action/detail。root 的 parentId='NONE'，最多 4 個主題，每個主題最多 5 個子節點。相近內容優先更新原節點，細節寫入 notes，避免每句發言新增分支。
3. syncTodoItems：只擷取明確可執行的任務。負責人、人名、期限須有發言來源，未指定負責人填待指派，未指定期限留空。沿用既有 ID，不要重複新增相同任務。
沒有實際發言或沒有新資訊時，不得自行產生範例、決議、任務、人名或日期。不得把提示詞中的例子當成會議內容。
每段重要發言後主動更新工具；使用者修正內容時更新原項目。保持主題名稱精簡，不加編號。
只聽寫與整理，AI 語音回覆保持簡短；使用者端不播放 AI 語音。`;

async function startServer() {
  const app = express();
  app.use('/api/meeting/transcribe-file', express.raw({ type: ['application/octet-stream', 'audio/*'], limit: '200mb' }));
  app.use(express.json({ limit: "50mb" }));

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      model: LIVE_MODEL,
      hasApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"),
      textModel: TEXT_MODEL,
    });
  });

  // Session persistence endpoints (syncing client sessions to server storage)
  const SESSIONS_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "saved_sessions.json");

  app.get("/api/sessions", (_req, res) => {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = fs.readFileSync(SESSIONS_FILE, "utf-8");
        return res.json({ success: true, sessions: JSON.parse(data) });
      }
      return res.json({ success: true, sessions: [] });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to read sessions" });
    }
  });

  app.post("/api/sessions/sync", (req, res) => {
    try {
      const { sessions } = req.body;
      if (!Array.isArray(sessions)) {
        return res.status(400).json({ error: "sessions must be an array" });
      }
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const temporaryFile = `${SESSIONS_FILE}.tmp`;
      if (fs.existsSync(SESSIONS_FILE)) fs.copyFileSync(SESSIONS_FILE, `${SESSIONS_FILE}.bak`);
      fs.writeFileSync(temporaryFile, JSON.stringify(sessions, null, 2), "utf-8");
      fs.renameSync(temporaryFile, SESSIONS_FILE);
      res.json({ success: true, count: sessions.length, savedAt: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to save sessions" });
    }
  });

  // REST API: Reconstruct / Catch-up meeting content using gemini-3.8-flash
  // Perfect for when the user wants to paste or speak recalled notes or full meeting transcripts
  app.post("/api/meeting/restructure", async (req, res) => {
    try {
      const { meetingTitle, textContext, existingNotes, existingMindMap, existingTodos } = req.body;
      if (!textContext || typeof textContext !== "string") {
        return res.status(400).json({ error: "Missing textContext" });
      }

      const ai = getGenAIClient();
      const prompt = `請根據以下提供的會議內容與速記筆記，以專業架構師與會議秘書的視角，重新整理並產出完整的結構化會議紀錄、三層精煉心智圖與待辦清單：

【會議主題】：${meetingTitle || "會議紀錄"}

【會議對話與內容速記】：
${textContext}

【既有筆記與心智圖參考（若有）】：
既有摘要：${JSON.stringify(existingNotes || [])}
既有心智圖：${JSON.stringify(existingMindMap || [])}
既有待辦：${JSON.stringify(existingTodos || [])}

請以 JSON 格式回應，必須嚴格符合以下結構：
{
  "sections": [
    {
      "id": "topic-1",
      "topic": "章節標題（繁體中文）",
      "summary": "段落精華重點（繁體中文）",
      "keyDecisions": ["關鍵決策 1", "關鍵決策 2"]
    }
  ],
  "mindMapNodes": [
    {
      "id": "root",
      "parentId": "NONE",
      "label": "會議核心主題",
      "category": "root",
      "notes": "宏觀概述"
    },
    {
      "id": "node-topic-1",
      "parentId": "root",
      "label": "討論主軸標題",
      "category": "topic",
      "notes": "補充說明"
    },
    {
      "id": "node-dec-1",
      "parentId": "node-topic-1",
      "label": "關鍵決策或執行項目",
      "category": "decision",
      "notes": "具體行動細節"
    }
  ],
  "todos": [
    {
      "id": "todo-1",
      "task": "具體待辦任務描述",
      "assignee": "負責人",
      "priority": "high" | "medium" | "low",
      "dueDate": "預計期限"
    }
  ]
}

重要規範：
1. mindMapNodes 必須嚴格維持 3 層深度（Level 1 root -> Level 2 topic -> Level 3 decision/action），不要產生第四層細碎節點！
2. 所有內容一律使用「繁體中文（台灣習慣用語）」。
3. 請回傳純 JSON，不要附加 markdown 代碼標籤。`;

      const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const responseText = response.text || "{}";
      const parsed = JSON.parse(responseText.trim());
      res.json({
        success: true,
        data: { ...parsed, ...(Array.isArray(parsed.mindMapNodes) ? { mindMapNodes: compactMindMap(parsed.mindMapNodes) } : {}) },
      });
    } catch (err: any) {
      console.error("Error in /api/meeting/restructure:", err);
      res.status(500).json({
        error: err?.message || "Failed to restructure meeting",
      });
    }
  });

  // REST API: Conversational correction endpoint
  app.post("/api/meeting/correct", async (req, res) => {
    try {
      const { instruction, session } = req.body;
      if (!instruction || !session) {
        return res.status(400).json({ error: "Missing instruction or session" });
      }

      const ai = getGenAIClient();
      const prompt = `你是一個專業的「會議紀錄精準校正助手」。
使用者發出了一道口語化的錯詞/內容修正指令：
【使用者的修正指令】：
"${instruction}"

【當前會議紀錄】：
- 主題：${session.title || ""}
- 章節重點：${JSON.stringify(session.notes || [])}
- 心智圖節點：${JSON.stringify(session.mindMapNodes || [])}
- 待辦事項：${JSON.stringify(session.todos || [])}
- 逐字稿末尾：${JSON.stringify((session.transcripts || []).slice(-10))}

請根據使用者的指示，智慧分析出需要被更正的「人名錯字、專有名詞、數字日期、工作內容或心智圖節點文字」，將所有欄位中匹配的錯誤內容進行替換修正，並回傳修正後的完整資料與簡要說明。

請以純 JSON 格式回應：
{
  "summary": "一句話簡短說明修正了什麼（例如：已將『林建宏』修正為『林建弘』，並更新心智圖與待辦負責人）",
  "notes": [...],
  "mindMapNodes": [...],
  "todos": [...],
  "transcripts": [...]
}

請確保 mindMapNodes 依然維持三層內簡明架構，不要產生零碎贅字。`;

      const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json({
        success: true,
        ...parsed,
      });
    } catch (err: any) {
      console.error("Error in /api/meeting/correct:", err);
      res.status(500).json({
        error: err?.message || "Correction failed",
      });
    }
  });

  // REST API: Mind Map Convergence & Semantic Clustering endpoint
  app.post("/api/meeting/converge-mindmap", async (req, res) => {
    try {
      const { meetingTitle, mindMapNodes, notes } = req.body;
      if (!Array.isArray(mindMapNodes) || mindMapNodes.length === 0) {
        return res.status(400).json({ error: "Missing mindMapNodes" });
      }

      const ai = getGenAIClient();
      const prompt = `你是一個專業的「心智圖智慧收斂與聚類降維專家」。
【會議主題】：${meetingTitle || "會議核心主題"}

【當前心智圖節點】：
${JSON.stringify(mindMapNodes, null, 2)}

【參考會議摘要】：
${JSON.stringify(notes || [], null, 2)}

【問題與核心任務】：
當前心智圖的第一階分支過多，且同一面向的事情被拆散在不同的一級分支。
請將上述所有節點進行「強力的智慧聚類收斂（Convergence & Pruning）」：

【嚴格收斂規範】：
1. 必須有且僅有一個根節點：{ "id": "root", "parentId": "NONE", "label": "${meetingTitle || "會議核心主題"}", "category": "root" }
2. 【第一階（直屬 root 的子節點）嚴格限制在 3 到 4 個核心主題柱】（例如：架構設計、核心體驗、落實規劃 等）！絕對禁止超過 4 個第一階分支！
3. 【聚合同一件事情】：將原本散落在第一階但語意相近或屬於同範疇的事項，合併或降級為這 3~4 個核心柱底下的 Level 2 子節點（parentId 指向該支柱 ID）！
4. 【消除重複與贅詞】：每個節點標題簡潔有力（12 字以內繁體中文），將細部說明收納在 notes 屬性中。
5. 【深度限制】：最多 3 層（root -> 3~4個核心主題柱 -> 關鍵決策與行動）。

請以純 JSON 格式回應，包含 nodes 陣列：
{
  "summary": "一句話說明收斂成果（例如：已將分散的分支聚合為 3 大核心支柱）",
  "nodes": [
    { "id": "root", "parentId": "NONE", "label": "會議核心主題", "category": "root" },
    { "id": "pillar-1", "parentId": "root", "label": "支柱名稱", "category": "topic", "notes": "..." },
    { "id": "sub-1-1", "parentId": "pillar-1", "label": "子議題或決策", "category": "decision", "notes": "..." }
  ]
}`;

      const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json({
        success: true,
        summary: parsed.summary || "心智圖已收斂聚合為核心支柱！",
        nodes: compactMindMap(Array.isArray(parsed.nodes) ? parsed.nodes : mindMapNodes),
      });
    } catch (err: any) {
      console.error("Error in /api/meeting/converge-mindmap:", err);
      res.status(500).json({
        error: err?.message || "Failed to converge mind map",
      });
    }
  });

  // REST API: Structured Notes Convergence & De-fragmentation endpoint
  app.post("/api/meeting/converge-notes", async (req, res) => {
    try {
      const { meetingTitle, notes, transcripts, mindMapNodes } = req.body;
      if (!Array.isArray(notes) || notes.length === 0) {
        return res.status(400).json({ error: "Missing notes" });
      }

      const ai = getGenAIClient();
      const prompt = `你是一個資深「企業會議紀要整理專家與架構師」，擅長將冗長、瑣碎、跳躍、重複的即時口語發言與零散速記，收斂為高品質、結構化、高度提煉的會議紀要。

【會議主題】：${meetingTitle || "會議核心主題"}

【當前累積的零散會議摘要段落】：
${JSON.stringify(notes, null, 2)}

【心智圖節點參考（對齊結構）】：
${JSON.stringify(mindMapNodes || [], null, 2)}

【近期逐字發言（語境參考）】：
${JSON.stringify(transcripts?.slice(-15) || [], null, 2)}

【核心任務：智慧收斂與結構整頓（Convergence & Consolidation）】：
目前會議記錄可能因為對話推進而產生了許多瑣碎片段、重複敘述或分散在多個段落的情形。
請對上述段落進行全面「語意聚類收斂與要點精煉」：

【收斂標準與原則】：
1. 【精煉議題數】：將原本零散的段落整合成 3 至 5 個核心大議題（例如：系統架構決策、跨部門協同進度、時程與資源評估、風險與合規對策）。不要開超過 5 個議題！
2. 【消除冗詞口語】：提煉最具商業與工程價值的精華事實，摘要精確有力（每章節 summary 80~160 字繁體中文）。
3. 【清晰條列關鍵決策】：每個議題提煉 2~4 項具體達成的共識、確認的規格或里程碑數據（keyDecisions）。
4. 【前後連貫對齊】：確保段落主題與心智圖核心支柱邏輯呼應。

請以純 JSON 格式回覆，包含 summary 與 sections 陣列：
{
  "summary": "一句話總結本次整頓成果（例如：已將零碎討論聚合為 3 大核心決策章節）",
  "sections": [
    {
      "id": "section-1",
      "topic": "核心議題標題（10字以內繁體中文）",
      "summary": "高精確度濃縮摘要...",
      "keyDecisions": [
        "確認事項或具體決策 A",
        "確認事項或具體決策 B"
      ]
    }
  ]
}`;

      const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json({
        success: true,
        summary: parsed.summary || "結構化會議紀錄已成功智慧收斂整頓！",
        sections: Array.isArray(parsed.sections) ? parsed.sections : notes,
      });
    } catch (err: any) {
      console.error("Error in /api/meeting/converge-notes:", err);
      res.status(500).json({
        error: err?.message || "Failed to converge notes",
      });
    }
  });

  const recoverySchema = {
    type: Type.OBJECT,
    properties: {
      sections: (syncMeetingNotesDeclaration.parameters as any).properties.sections,
      mindMapNodes: (syncMindMapNodesDeclaration.parameters as any).properties.nodes,
      todos: (syncTodoItemsDeclaration.parameters as any).properties.todos,
    },
    required: ['sections', 'mindMapNodes', 'todos'],
  };
  const recoveryOptions = {
    getAI: getGenAIClient, transcribeModel: TRANSCRIBE_MODEL, textModel: TEXT_MODEL, schema: recoverySchema,
  };

  app.post('/api/meeting/structure-transcript', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (typeof req.body.transcript !== 'string' || !req.body.transcript.trim()) return res.status(400).json({ error: '缺少逐字稿' });
      const data = await structureTranscript(req.body.transcript, req.body.meetingTitle || '錄音重建', { ...recoveryOptions, signal: controller.signal });
      res.json({ success: true, data });
    } catch (error: any) { res.status(502).json({ error: error?.message || '整理失敗，逐字稿仍保留在會議中' }); }
  });

  // Raw audio avoids base64 expansion for long recordings. NDJSON commits the
  // transcript before structuring, allowing a retry without retranscribing audio.
  app.post('/api/meeting/transcribe-file', async (req, res) => {
    const streaming = Buffer.isBuffer(req.body);
    const audio = streaming ? req.body : typeof req.body?.base64Audio === 'string' ? Buffer.from(req.body.base64Audio, 'base64') : null;
    const mimeType = String(streaming ? req.query.mimeType || req.headers['content-type'] : req.body?.mimeType || 'audio/mpeg').split(';')[0];
    const title = String(streaming ? req.query.meetingTitle || '錄音重建' : req.body?.meetingTitle || '錄音重建').slice(0, 300);
    if (!audio?.length) return res.status(400).json({ error: '請選取非空白的錄音檔' });
    if (!/^audio\/(mpeg|mp3|mp4|wav|x-wav|webm|ogg|flac|aac|aiff)$/.test(mimeType)) return res.status(400).json({ error: '不支援的錄音格式，請使用 WebM、MP3、M4A、WAV、OGG 或 FLAC' });
    if (streaming) { res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders(); }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const result = await recoverRecording(audio, mimeType, title, {
        ...recoveryOptions, signal: controller.signal,
        emit: event => { if (streaming && !res.destroyed) res.write(JSON.stringify(event) + '\n'); },
      });
      if (!streaming) return res.json({ success: !result.error, ...result });
    } catch (error: any) {
      if (!controller.signal.aborted) {
        const message = error?.message || '錄音重建失敗';
        if (streaming) res.write(JSON.stringify({ type: 'error', stage: 'transcribing', message }) + '\n');
        else return res.status(502).json({ error: message });
      }
    }
    if (!res.destroyed) res.end();
  });

  app.use((error: any, _req: any, res: any, next: any) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: '錄音檔超過 200 MB，請先壓縮或分段後再試' });
    next(error);
  });

  // Upgrade HTTP connection to WebSocket only for /ws/live
  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`
    ).pathname;

    if (pathname === "/ws/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", client => attachLiveSession(client, {
    getAI: getGenAIClient,
    model: LIVE_MODEL,
    textModel: TEXT_MODEL,
    instruction: SYSTEM_INSTRUCTION,
    declarations: [syncMeetingNotesDeclaration, syncMindMapNodesDeclaration, syncTodoItemsDeclaration],
  }));

  // Mount Vite middleware in development or serve static build in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, process.env.HOST || "0.0.0.0", () => {
    console.log(`PulseNote Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
