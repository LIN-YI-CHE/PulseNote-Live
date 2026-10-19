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

const syncMindMapNodesDeclaration: FunctionDeclaration = {
  name: "syncMindMapNodes",
  description:
    "即時新增或更新心智圖（Mind Map）的節點結構。保持唯一根節點（parentId 為 null 或 'root'），並將討論主題、細節與決策作為子節點延伸。",
  parameters: {
    type: Type.OBJECT,
    properties: {
      nodes: {
        type: Type.ARRAY,
        description: "要新增或更新的心智圖節點陣列",
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.STRING,
              description: "節點唯一 ID（例如 'root', 'node-1', 'node-1-1'）",
            },
            parentId: {
              type: Type.STRING,
              description:
                "父節點 ID。若是中心根節點請填寫 'NONE'，其餘節點請填寫對應的父節點 ID（如 'root' 或上層節點 ID）",
            },
            label: {
              type: Type.STRING,
              description: "節點顯示名稱（簡短精煉，建議 12 字以內，繁體中文）",
            },
            category: {
              type: Type.STRING,
              description:
                "節點類型：'root' | 'topic' | 'decision' | 'action' | 'detail'",
            },
            notes: {
              type: Type.STRING,
              description: "節點補充說明（選填）",
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
2. 呼叫 syncMindMapNodes：建構並擴展階層式心智圖節點（確保有一個 id 為 'root'、parentId 為 'NONE' 的中心主題節點，並向下延伸 'topic'、'decision'、'action'、'detail' 子節點）。
3. 呼叫 syncTodoItems：擷取對話中提到的行動項目、待辦事項、負責人與期限。

重要原則：
- 一旦聽到或收到任何有意義的會議討論內容，請立即且主動呼叫上述工具（可同時呼叫多個工具）來更新畫面！
- 所有輸出的文字內容請一律使用「繁體中文（台灣習慣用語）」。
- 因為使用者選擇了「純聽寫與整理模式（不播放 AI 語音）」，在完成工具呼叫後，你的語音/文字回應請保持極度簡短（例如僅回覆「已更新」即可），把重心放在精準且豐富的工具呼叫參數上。`;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

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
    let sessionPromise: Promise<any> | null = null;
    let isClosed = false;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = getGenAIClient();

      sessionPromise = ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
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

              // 2. Handle model turn complete (mark transcript chunk boundaries)
              if (message.serverContent?.turnComplete) {
                sendToClient({
                  type: "turn_complete",
                });
              }

              // 3. Handle model audio output (kept silent by default in UI, but tracked per Live API rules)
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
                if (sessionPromise && functionResponses.length > 0) {
                  sessionPromise
                    .then((activeSession) => {
                      if (!isClosed && activeSession) {
                        activeSession.sendToolResponse({
                          functionResponses,
                        });
                      }
                    })
                    .catch((err) => {
                      console.error("Error sending tool response:", err);
                    });
                }
              }
            } catch (innerErr: any) {
              console.error("Error processing LiveServerMessage:", innerErr);
            }
          },
          onerror: (err: any) => {
            console.error("Gemini 3.8 Live session error:", err);
            sendToClient({
              type: "error",
              message:
                err?.message ||
                "Gemini 3.8 Live 連線發生異常，請確認 API Key 或網路狀態。",
            });
          },
          onclose: () => {
            if (!isClosed) {
              sendToClient({
                type: "session_status",
                status: "disconnected",
              });
            }
          },
        },
      });

      await sessionPromise;
    } catch (err: any) {
      console.error("Failed to initialize Gemini 3.8 Live session:", err);
      sendToClient({
        type: "error",
        message:
          err?.message ||
          "無法建立 Gemini 3.8 Live 連線，請檢查 Settings > Secrets 中的 GEMINI_API_KEY。",
      });
    }

    clientWs.on("message", (rawData) => {
      try {
        const parsed = JSON.parse(rawData.toString());

        if (!sessionPromise) return;

        sessionPromise
          .then((activeSession) => {
            if (isClosed || !activeSession) return;

            // Stream 16kHz PCM audio chunk from browser microphone
            if (parsed.type === "audio" && parsed.audio) {
              activeSession.sendRealtimeInput({
                audio: {
                  data: parsed.audio,
                  mimeType: "audio/pcm;rate=16000",
                },
              });
            }

            // Inject text or simulated meeting dialogue directly into Gemini 3.8 Live session
            if (parsed.type === "text_input" && parsed.text) {
              activeSession.sendRealtimeInput({
                text: `【最新會議發言】${parsed.speaker ? `${parsed.speaker}：` : ""}${parsed.text}\n請根據目前的會議發言，立即呼叫 syncMeetingNotes、syncMindMapNodes 與 syncTodoItems 工具來同步更新會議紀錄、心智圖節點與待辦事項。`,
              });
            }

            // Force structure synchronization prompt during live audio streaming
            if (parsed.type === "nudge_sync") {
              activeSession.sendRealtimeInput({
                text: `請根據剛剛聽到的語音內容與上下文，立即呼叫 syncMeetingNotes、syncMindMapNodes 與 syncTodoItems 更新畫面上的會議重點、心智圖與待辦事項。`,
              });
            }
          })
          .catch((err) => {
            console.error("Error forwarding input to Live session:", err);
          });
      } catch (parseErr) {
        console.error("Invalid WebSocket message from client:", parseErr);
      }
    });

    clientWs.on("close", () => {
      isClosed = true;
      if (sessionPromise) {
        sessionPromise
          .then((activeSession) => {
            try {
              activeSession?.close();
            } catch {
              // ignore close errors
            }
          })
          .catch(() => {});
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
