import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Type,
  FunctionDeclaration,
} from "@google/genai";

dotenv.config();

const PORT = 3000;

function getGenAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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

const SYSTEM_INSTRUCTION = `你是一個專業的「即時會議紀錄、心智圖與待辦事項結構化助手」，運作於 Gemini 3.8 Live 即時模式。
你的任務是邊聽會議語音或對話輸入，邊透過工具呼叫（Function Calling）即時更新畫面上的三個區域：
1. 呼叫 syncMeetingNotes：整理結構化會議摘要與關鍵決策。
   【會議紀錄收斂與去碎片化原則（極重要）】：
   - 全局章節嚴格維持在 3 至 5 個核心大議題，避免產生碎裂且重複的微小章節。
   - 【禁止在主題名稱前冠上 01. 02. 等數字編號】：請直接使用清晰的純文字主題名稱（例如「核心架構與選型」、「使用者體驗回饋」）。
   - 當發言延續既有主題時，請「更新」該主題的 summary 與 keyDecisions，切勿為每一句對話都開設新章節！
   - 決策必須條列清晰具體（keyDecisions 陣列），摘要高度提煉並消除口語贅詞。
2. 呼叫 syncMindMapNodes：建構並擴展階層式心智圖節點。
   【心智圖防發散與收斂鐵律（極重要）】：
   - 【第一階核心主幹（parentId='root'）嚴格限制最多 3 至 4 個主題柱】（例如：1.技術架構、2.功能體驗、3.專案進度、4.資安規範）。
   - 絕對禁止在 root 底下開出 5 個以上的第一階散亂分支！
   - 同一件事情或同一面向的討論，【必須收斂歸入現有的 3~4 個主題柱底下做為第二階（Level 2）子節點】，絕對不允許在第一階反覆開設新主幹！
   - 當討論擴展時，優先「收斂聚合」：若已有相近主題，將新討論作為既有節點的子決策（Level 3）或更新其 notes，嚴格避免心智圖橫向爆炸！
3. 呼叫 syncTodoItems：擷取對話中提到的具體行動項目、待辦事項、負責人與期限。
   - 【嚴禁捏造虛構人名】：負責人（assignee）必須完全依據會議中實際發言或指派的真實身分或職稱；若對話未指定明確人員，請務必填寫「待指派」或團隊組別（如「架構組」、「前端團隊」），絕對禁止自行捏造假人名！

重要原則：
- 【高頻主動同步】：請勿長時間靜默！每聽到一段發言或決策，請主動且持續呼叫工具來更新紀錄、心智圖與待辦，確保畫面隨時動態刷新！
- 【語音/文字修正與校正指令】：若發言者說出修正指令（例如：『更正一下，是XX不是YY』、『把負責人改成技術組』、『把心智圖的架構改為...』），請立即呼叫對應工具精準替換！
- 所有輸出的文字內容請一律使用「繁體中文（台灣習慣用語）」。
- 使用者選擇了「純聽寫與整理模式（不播放 AI 語音）」，工具呼叫後語音回應請保持極度簡短（例如僅回覆「已同步」即可）。`;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      model: "gemini-3.8-live",
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // Session persistence endpoints (syncing client sessions to server storage)
  const SESSIONS_FILE = path.join(process.cwd(), "data", "saved_sessions.json");

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
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), "utf-8");
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
既有摘要數量：${existingNotes?.length || 0}
既有心智圖節點數量：${existingMindMap?.length || 0}
既有待辦數量：${existingTodos?.length || 0}

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
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const responseText = response.text || "{}";
      const parsed = JSON.parse(responseText.trim());
      res.json({
        success: true,
        data: parsed,
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
        model: "gemini-3.8-flash",
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
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json({
        success: true,
        summary: parsed.summary || "心智圖已收斂聚合為核心支柱！",
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : mindMapNodes,
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
        model: "gemini-3.8-flash",
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

  // REST API: Transcribe uploaded audio file using gemini-3.5-transcribe and extract structured meeting data
  app.post("/api/meeting/transcribe-file", async (req, res) => {
    try {
      const { base64Audio, mimeType, meetingTitle } = req.body;
      if (!base64Audio) {
        return res.status(400).json({ error: "Missing base64Audio" });
      }

      const ai = getGenAIClient();

      // Step 1: Transcribe audio
      const audioPart = {
        inlineData: {
          mimeType: mimeType || "audio/mp3",
          data: base64Audio,
        },
      };

      const transcribeRes = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            audioPart,
            { text: "請將這段會議錄音逐字並精確地轉錄為繁體中文逐字稿，區分發言段落與時間序。" },
          ],
        },
      });

      const transcriptText = transcribeRes.text || "";

      // Step 2: Structure transcript into notes, mindmap, todos
      const structurePrompt = `以下是一段完整會議錄音的轉錄文字，請將其整理為結構化會議紀錄、三層精煉心智圖與待辦清單：

【會議主題】：${meetingTitle || "會議錄音轉錄"}
【錄音轉錄文字】：
${transcriptText}

請以 JSON 格式回應，包含 sections, mindMapNodes (最多3層), todos：
{
  "transcript": "${transcriptText.slice(0, 500)}...",
  "sections": [...],
  "mindMapNodes": [...],
  "todos": [...]
}`;

      const structureRes = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: structurePrompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(structureRes.text || "{}");
      res.json({
        success: true,
        transcript: transcriptText,
        data: parsed,
      });
    } catch (err: any) {
      console.error("Error in /api/meeting/transcribe-file:", err);
      res.status(500).json({
        error: err?.message || "Failed to transcribe audio file",
      });
    }
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

  wss.on("connection", async (clientWs: WebSocket) => {
    let activeLiveSession: any = null;
    let isClosed = false;
    let sessionRolloverCount = 0;
    let lastAudioTime = 0;
    let lastToolCallTime = Date.now();
    let autoSyncTimer: NodeJS.Timeout | null = null;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    // Keepalive ping interval every 15 seconds to prevent Cloud Run / proxy timeouts
    const pingInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        sendToClient({ type: "ping", time: Date.now() });
      }
    }, 15000);

    // Watchdog: If audio is streaming but no tool call happened in 20s, auto-catalyze
    autoSyncTimer = setInterval(() => {
      if (isClosed || !activeLiveSession) return;
      const now = Date.now();
      if (now - lastAudioTime < 6000 && now - lastToolCallTime > 20000) {
        try {
          activeLiveSession.sendRealtimeInput({
            text: "【自動催化排程】：請根據剛剛聽到的會議發言，立即呼叫 syncMeetingNotes、syncMindMapNodes（最多3~4個一級柱，同類事項收斂）與 syncTodoItems 同步更新畫面！",
          });
          lastToolCallTime = now;
        } catch (e) {
          console.warn("Failed to auto-nudge live session:", e);
        }
      }
    }, 10000);

    // Function to connect or roll-over Gemini 3.8 Live session
    const connectGeminiLiveSession = async (contextSummary?: string) => {
      try {
        const ai = getGenAIClient();
        const rolloverInstruction = contextSummary
          ? `${SYSTEM_INSTRUCTION}\n\n【延續前段會議上下文摘要】：\n${contextSummary}`
          : SYSTEM_INSTRUCTION;

        const session = await ai.live.connect({
          model: "gemini-3.8-live",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
            },
            systemInstruction: rolloverInstruction,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [
              {
                functionDeclarations: [
                  syncMeetingNotesDeclaration,
                  syncMindMapNodesDeclaration,
                  syncTodoItemsDeclaration,
                ],
              },
            ],
          },
          callbacks: {
            onopen: () => {
              sendToClient({
                type: "session_status",
                status: "connected",
                model: "gemini-3.8-live",
                rolloverCount: sessionRolloverCount,
              });
            },
            onmessage: (message: LiveServerMessage) => {
              try {
                // 1. Handle input audio transcription (user's live speech)
                const inputText =
                  (message.serverContent as any)?.inputTranscription?.text;
                if (inputText) {
                  sendToClient({
                    type: "input_transcription",
                    text: inputText,
                    timestamp: new Date().toLocaleTimeString("zh-TW", {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    }),
                  });
                }

                // 2. Handle model turn complete
                if (message.serverContent?.turnComplete) {
                  sendToClient({
                    type: "turn_complete",
                  });
                }

                // 3. Handle model audio output (kept silent per user preference)
                const audioData =
                  message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                if (audioData) {
                  sendToClient({
                    type: "model_audio",
                    audio: audioData,
                  });
                }

                // 4. Handle Tool Calls (Meeting Notes, Mind Map, To-Dos)
                const toolCall = (message as any).toolCall;
                if (toolCall?.functionCalls && Array.isArray(toolCall.functionCalls)) {
                  const functionResponses: any[] = [];

                  for (const call of toolCall.functionCalls) {
                    lastToolCallTime = Date.now();
                    sendToClient({
                      type: "tool_call",
                      toolName: call.name,
                      args: call.args,
                      callId: call.id,
                      timestamp: new Date().toLocaleTimeString("zh-TW", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      }),
                    });

                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: { result: "ok", synced: true },
                    });
                  }

                  // Acknowledge tool execution back to Gemini 3.8 Live session
                  if (activeLiveSession && functionResponses.length > 0) {
                    try {
                      activeLiveSession.sendToolResponse({
                        functionResponses,
                      });
                    } catch (toolRespErr) {
                      console.warn("Error sending tool response:", toolRespErr);
                    }
                  }
                }
              } catch (innerErr: any) {
                console.error("Error processing LiveServerMessage:", innerErr);
              }
            },
            onerror: (err: any) => {
              console.error("Gemini 3.8 Live session error:", err);
              // If client is still connected, attempt seamless rollover reconnect
              if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
                sessionRolloverCount++;
                sendToClient({
                  type: "session_rollover",
                  message: "Gemini 3.8 Live 連線自動無縫重連中...",
                });
                setTimeout(() => {
                  if (!isClosed) connectGeminiLiveSession();
                }, 1000);
              }
            },
            onclose: () => {
              // If session closed by remote (e.g. 7-10 min session duration ceiling reached) but client is still actively recording
              if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
                sessionRolloverCount++;
                sendToClient({
                  type: "session_rollover",
                  message: "超過單次通話上限，已為您自動平滑延續 Session...",
                });
                setTimeout(() => {
                  if (!isClosed) connectGeminiLiveSession();
                }, 500);
              } else if (!isClosed) {
                sendToClient({
                  type: "session_status",
                  status: "disconnected",
                });
              }
            },
          },
        });

        activeLiveSession = session;
      } catch (err: any) {
        console.error("Failed to initialize Gemini 3.8 Live session:", err);
        sendToClient({
          type: "error",
          message:
            err?.message ||
            "無法建立 Gemini 3.8 Live 連線，請檢查 Settings > Secrets 中的 GEMINI_API_KEY。",
        });
      }
    };

    // Initialize first Gemini 3.8 Live session
    await connectGeminiLiveSession();

    clientWs.on("message", (rawData) => {
      try {
        const parsed = JSON.parse(rawData.toString());

        // Heartbeat pong response
        if (parsed.type === "pong") {
          return;
        }

        // Manual live reconnect request
        if (parsed.type === "reconnect_live") {
          sendToClient({
            type: "session_rollover",
            message: "已收到強制重整連線要求，正在重新建立 Gemini 3.8 Live 通道...",
          });
          if (activeLiveSession) {
            try {
              activeLiveSession.close();
            } catch {
              // ignore
            }
          }
          connectGeminiLiveSession(parsed.contextSummary);
          return;
        }

        if (!activeLiveSession || isClosed) return;

        // Stream 16kHz PCM audio chunk from browser microphone
        if (parsed.type === "audio" && parsed.audio) {
          lastAudioTime = Date.now();
          activeLiveSession.sendRealtimeInput({
            audio: {
              data: parsed.audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        }

        // Inject text or manual speech directly into Gemini 3.8 Live session
        if (parsed.type === "text_input" && parsed.text) {
          activeLiveSession.sendRealtimeInput({
            text: `【最新會議發言】${parsed.speaker ? `${parsed.speaker}：` : ""}${parsed.text}\n請根據目前的會議發言，立即呼叫 syncMeetingNotes、syncMindMapNodes（最多3~4個一級柱，同類事項收斂）與 syncTodoItems 工具來同步更新會議紀錄、心智圖節點與待辦事項。`,
          });
        }

        // Force structure synchronization prompt during live audio streaming
        if (parsed.type === "nudge_sync") {
          lastToolCallTime = 0; // reset so it can respond immediately
          activeLiveSession.sendRealtimeInput({
            text: `【手動催化同步】：請根據剛剛聽到的全部發言與語意上下文，立即呼叫 syncMeetingNotes、syncMindMapNodes（保持3~4個核心主題柱架構）與 syncTodoItems 更新畫面上的會議重點、心智圖與待辦事項。`,
          });
        }
      } catch (parseErr) {
        console.error("Invalid WebSocket message from client:", parseErr);
      }
    });

    clientWs.on("close", () => {
      isClosed = true;
      clearInterval(pingInterval);
      if (autoSyncTimer) {
        clearInterval(autoSyncTimer);
      }
      if (activeLiveSession) {
        try {
          activeLiveSession.close();
        } catch {
          // ignore
        }
      }
    });
  });

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

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`PulseNote Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
