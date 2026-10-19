import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
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
    "即時新增或更新心智圖（Mind Map）的節點結構。必須嚴格維持清晰精煉的三層階層結構：Level 1 為唯一中心根節點（id='root', parentId='NONE'）；Level 2 為 3~6 個主要討論主軸（category='topic', parentId='root'）；Level 3 為具體關鍵決策或執行行動（category='decision' 或 'action', parentId 為對應的 Level 2 節點 ID）。嚴格禁止為每一句口語零散細節盲目建立第四、五層微型葉節點！細部說明請填寫在 notes 屬性中，並對同一議題進行語義聚合更新，保持心智圖高可讀性與宏觀架構。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      nodes: {
        type: Type.ARRAY,
        description: "要新增或更新的心智圖節點陣列（最多 3 層深度）",
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.STRING,
              description: "節點唯一 ID（例如 'root', 'node-topic-1', 'node-decision-1'）",
            },
            parentId: {
              type: Type.STRING,
              description:
                "父節點 ID。中心根節點請填寫 'NONE'，討論主軸請填寫 'root'，三級決策/行動請填寫對應的主軸 ID。切勿超過三層深度！",
            },
            label: {
              type: Type.STRING,
              description: "節點顯示名稱（簡潔有力，10~20字內，繁體中文）",
            },
            category: {
              type: Type.STRING,
              description:
                "節點類型：'root' | 'topic' | 'decision' | 'action'",
            },
            notes: {
              type: Type.STRING,
              description: "該節點的細部說明或背景補充（避免拆成過多碎節點，細節請填在此處）",
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
2. 呼叫 syncMindMapNodes：建構並擴展階層式心智圖節點。
   【心智圖嚴格規範】：
   - 保持精簡、宏觀且富有架構的三層結構（Level 1 核心主題 -> Level 2 討論主軸 3~6 個 -> Level 3 關鍵決策與行動方向 2~4 個）。
   - 嚴格禁止把每句口語瑣碎枝節都拆成第四、五層碎小節點！細部說明請置於 notes 屬性。
   - 對同一議題的多個發言進行「語義聚合」，更新現有主軸節點或在其下增補決策，保持圖表整齊易讀。
3. 呼叫 syncTodoItems：擷取對話中提到的具體行動項目、待辦事項、負責人與期限。

重要原則：
- 一旦聽到或收到任何有意義的會議討論內容，請立即且主動呼叫上述工具來更新畫面！
- 所有輸出的文字內容請一律使用「繁體中文（台灣習慣用語）」。
- 使用者選擇了「純聽寫與整理模式（不播放 AI 語音）」，在完成工具呼叫後，你的語音/文字回應請保持極度簡短（例如僅回覆「已同步」即可），把重心放在精準且豐富的工具呼叫參數上。`;

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
              activeLiveSession = session;
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
                    activeLiveSession.sendToolResponse({
                      functionResponses,
                    });
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

        if (!activeLiveSession || isClosed) return;

        // Stream 16kHz PCM audio chunk from browser microphone
        if (parsed.type === "audio" && parsed.audio) {
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
            text: `【最新會議發言】${parsed.speaker ? `${parsed.speaker}：` : ""}${parsed.text}\n請根據目前的會議發言，立即呼叫 syncMeetingNotes、syncMindMapNodes（最多3層）與 syncTodoItems 工具來同步更新會議紀錄、心智圖節點與待辦事項。`,
          });
        }

        // Force structure synchronization prompt during live audio streaming
        if (parsed.type === "nudge_sync") {
          activeLiveSession.sendRealtimeInput({
            text: `請根據剛剛聽到的語音內容與上下文，立即呼叫 syncMeetingNotes、syncMindMapNodes（保持3層內架構）與 syncTodoItems 更新畫面上的會議重點、心智圖與待辦事項。`,
          });
        }
      } catch (parseErr) {
        console.error("Invalid WebSocket message from client:", parseErr);
      }
    });

    clientWs.on("close", () => {
      isClosed = true;
      clearInterval(pingInterval);
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
