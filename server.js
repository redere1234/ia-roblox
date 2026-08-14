// ════════════════════════════════════════════════════════════════
//  RBX-AI Studio Server — v4 PRO (OpenRouter Edition)
//  Mejoras v4:
//  - Streaming real token a token vía SSE
//  - Conversaciones múltiples y persistentes en disco (./data)
//  - Subida de archivos .lua/.luau/.txt/.rbxlx (la IA los analiza)
//  - Syntax guard, web search, activity log, undo, stats
// ════════════════════════════════════════════════════════════════

const express        = require("express");
const cors           = require("cors");
const path           = require("path");
const fs             = require("fs");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

// Servir index.html y estáticos desde el directorio raíz
const PUBLIC_DIR = __dirname;
app.use(express.static(PUBLIC_DIR));

// ─── Persistencia en disco ────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function safeReadJSON(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch (_) { return fallback; }
}

function safeWriteJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(filePath + ".tmp", filePath);
  } catch (err) {
    console.error("[Persist] Error guardando", filePath, err.message);
  }
}

// ─── OpenRouter Config ────────────────────────────────────────

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OR_API_KEY      = process.env.OPENROUTER_API_KEY;

// ─── Railway / Producción ─────────────────────────────────────
// En Railway la URL pública se define con la variable PUBLIC_URL
// (opcional; se auto-detecta si está definida). El plugin la usa
// para hacer polling sin que tengas que escribir la URL a mano.
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PLUGIN_TIMEOUT_MS = parseInt(process.env.PLUGIN_TIMEOUT_MS || "15000", 10);

const FREE_MODEL_CANDIDATES = [
  "openrouter/free",                        // router oficial OR — elige el mejor gratis
  "qwen/qwen3-coder:free",                  // #1 coding 2026, 256K ctx
  "meta-llama/llama-3.3-70b-instruct:free", // estable, 131K ctx
  "deepseek/deepseek-chat-v3-0324:free",    // bueno en código
  "google/gemma-3-27b-it:free",             // backup Google
];

let ACTIVE_MODEL  = "openrouter/free";
let modelResolved = false;

async function pickBestFreeModel() {
  ACTIVE_MODEL  = "openrouter/free";
  modelResolved = true;
  console.log("\n  ✅ Usando openrouter/free (router oficial — elige el mejor modelo gratis en tiempo real)\n");
}

// ─── Chat con streaming ───────────────────────────────────────
// Devuelve un ReadableStream que va llegando token a token
async function orChatStream({ messages, tools, system, max_tokens = 8192 }) {
  const OR_HEADERS = {
    "Authorization": `Bearer ${OR_API_KEY}`,
    "Content-Type":  "application/json",
    "HTTP-Referer":  "https://rbx-ai-studio.local",
    "X-Title":       "RBX-AI Studio",
  };

  const body = {
    model     : ACTIVE_MODEL,
    max_tokens,
    stream    : true,
    messages: system
      ? [{ role: "system", content: system }, ...messages]
      : messages,
  };
  if (tools?.length) {
    body.tools       = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method : "POST",
    headers: OR_HEADERS,
    body   : JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // 429 de cuenta (límite diario gratuito)
    if (res.status === 429) {
      throw new Error(
        "⚠ Límite diario de OpenRouter alcanzado (50 req/día gratuitas).\n" +
        "Opciones:\n" +
        "  1. Espera hasta medianoche UTC (reset automático)\n" +
        "  2. Agrega $10 créditos en https://openrouter.ai/settings/billing"
      );
    }
    throw new Error(`OpenRouter error ${res.status}: ${errText.slice(0, 200)}`);
  }

  return res.body; // ReadableStream — SSE de OpenRouter
}

// ─── Chat sin streaming (para tool loop) ──────────────────────
async function orChat({ messages, tools, system, max_tokens = 8192 }) {
  const body = {
    model     : ACTIVE_MODEL,
    max_tokens,
    messages: system
      ? [{ role: "system", content: system }, ...messages]
      : messages,
  };
  if (tools?.length) {
    body.tools       = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method : "POST",
    headers: {
      "Authorization": `Bearer ${OR_API_KEY}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  "https://rbx-ai-studio.local",
      "X-Title":       "RBX-AI Studio",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (res.status === 429) {
      throw new Error(
        "⚠ Límite diario de OpenRouter alcanzado (50 req/día gratuitas).\n" +
        "Espera hasta medianoche UTC o agrega créditos en https://openrouter.ai/settings/billing"
      );
    }
    throw new Error(`OpenRouter error ${res.status}`);
  }

  const data   = await res.json();
  const choice = data.choices?.[0];
  const msg    = choice?.message;
  if (!msg) throw new Error("Respuesta vacía de OpenRouter");

  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      content.push({
        type : "tool_use",
        id   : tc.id,
        name : tc.function.name,
        input: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch (_) { return {}; } })(),
      });
    }
  }

  return {
    stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    content,
  };
}

// ─── Estado global ────────────────────────────────────────────

let pluginLastPing       = 0;
let pendingPluginCommand = null;
let scriptsIndexed       = 0;
let sessionStart         = Date.now();
const jobs               = new Map();
const activityLog        = [];

// ─── Gestión de conversaciones (múltiples, persistentes) ─────
// conversations: { [id]: { id, title, createdAt, updatedAt, messages: [...], tokenCount } }
let conversations = safeReadJSON(path.join(DATA_DIR, "conversations.json"), {});

function saveConversations() {
  safeWriteJSON(path.join(DATA_DIR, "conversations.json"), conversations);
}

function getCurrentConversationId() {
  return (typeof globalThis.__currentChatId === "string" && conversations[globalThis.__currentChatId])
    ? globalThis.__currentChatId
    : null;
}

function setCurrentConversationId(id) {
  globalThis.__currentChatId = id;
  safeWriteJSON(path.join(DATA_DIR, "current-chat.json"), { id });
}

// Cargar el chat activo de la última sesión
const savedCurrent = safeReadJSON(path.join(DATA_DIR, "current-chat.json"), { id: null });
if (savedCurrent.id && conversations[savedCurrent.id]) {
  globalThis.__currentChatId = savedCurrent.id;
}

// Normalizar historial interno al formato de bloque (robusto ante null)
// Formato interno: [{role:"user", content:"..."}] y [{role:"assistant", content:[{type,text},{type,tool_use}]}]
function getActiveMessages() {
  const id = getCurrentConversationId();
  return id ? (conversations[id]?.messages || []) : [];
}

function setActiveMessages(messages) {
  const id = getCurrentConversationId();
  if (!id) return;
  const conv = conversations[id];
  if (!conv) return;
  conv.messages    = messages.slice(-60); // máximo 60 mensajes
  conv.updatedAt   = Date.now();
  conv.tokenCount  = conv.messages.reduce((acc, m) => {
    const text = typeof m.content === "string" ? m.content : "";
    const blocks = Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("") : "";
    return acc + Math.ceil((text.length + blocks.length) / 4);
  }, 0);
  conversations[id] = conv;
  saveConversations();
}

// ═══ API: conversaciones ═══

app.get("/chats", (req, res) => {
  const list = Object.values(conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(c => ({
      id        : c.id,
      title     : c.title,
      createdAt : c.createdAt,
      updatedAt : c.updatedAt,
      active    : c.id === getCurrentConversationId(),
    }));
  res.json({ chats: list, current: getCurrentConversationId() });
});

app.post("/chats", (req, res) => {
  const id = randomUUID();
  const title = (req.body?.title || "Nueva conversación").slice(0, 80);
  conversations[id] = {
    id, title,
    createdAt : Date.now(),
    updatedAt : Date.now(),
    messages  : [],
    tokenCount: 0,
  };
  setCurrentConversationId(id);
  res.json({ id, title });
});

app.delete("/chats/:id", (req, res) => {
  const { id } = req.params;
  if (!conversations[id]) return res.status(404).json({ error: "Chat no encontrado" });
  delete conversations[id];
  saveConversations();
  if (getCurrentConversationId() === id) {
    const next = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setCurrentConversationId(next ? next.id : null);
  }
  res.json({ ok: true });
});

app.post("/chats/:id/activate", (req, res) => {
  const { id } = req.params;
  if (!conversations[id]) return res.status(404).json({ error: "Chat no encontrado" });
  setCurrentConversationId(id);
  // Devolver el historial visual completo
  const msgs = conversations[id].messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => {
      if (m.role === "assistant") {
        const blocks = Array.isArray(m.content) ? m.content : [];
        return {
          role   : "assistant",
          content: blocks.filter(b => b && b.type === "text").map(b => b.text).join("\n"),
        };
      }
      return { role: "user", content: m.content };
    });
  res.json({ ok: true, messages: msgs });
});

app.post("/chat/reset", (req, res) => {
  const id = randomUUID();
  conversations[id] = {
    id,
    title   : "Nueva conversación",
    createdAt : Date.now(),
    updatedAt : Date.now(),
    messages  : [],
    tokenCount: 0,
  };
  setCurrentConversationId(id);
  scriptsIndexed      = 0;
  sessionStart        = Date.now();
  activityLog.length  = 0;
  console.log("[Chat] Sesión reiniciada →", id.slice(0, 8));
  res.json({ ok: true, chat_id: id });
});

// ═══ Archivos adjuntos ═══
const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE   = 2 * 1024 * 1024; // 2 MB
const ALLOWED_EXT     = new Set([".lua", ".luau", ".txt", ".md", ".rbxlx", ".json", ".rbxm"]);

app.post("/files/upload", (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: "No se enviaron archivos" });
  if (files.length > MAX_ATTACHMENTS) return res.status(400).json({ error: `Máximo ${MAX_ATTACHMENTS} archivos` });

  const summaries = [];
  for (const f of files) {
    const name = String(f.name || "archivo").slice(0, 100);
    const ext  = path.extname(name).toLowerCase();
    const content = String(f.content || "");

    if (!ALLOWED_EXT.has(ext)) {
      summaries.push({ name, error: `Extensión no soportada (${ext}). Usa .lua, .luau, .txt, .md, .json, .rbxlx` });
      continue;
    }
    if (content.length > MAX_FILE_SIZE) {
      summaries.push({ name, error: "Archivo demasiado grande (máx 2 MB)" });
      continue;
    }
    summaries.push({
      name,
      ext,
      chars  : content.length,
      preview: content.slice(0, 3000),
    });
  }
  res.json({ files: summaries });
});

// ─── Plugin Bridge ────────────────────────────────────────────

app.get("/plugin/poll", (req, res) => {
  pluginLastPing = Date.now();
  if (pendingPluginCommand) {
    const { id, command, data } = pendingPluginCommand;
    res.json({ id, command, data: data || {} });
  } else {
    res.json({ command: null });
  }
});

app.post("/plugin/result", (req, res) => {
  const { id, result, error } = req.body;
  if (pendingPluginCommand && pendingPluginCommand.id === id) {
    clearTimeout(pendingPluginCommand._timer);
    error
      ? pendingPluginCommand.reject(new Error(error))
      : pendingPluginCommand.resolve(result);
    pendingPluginCommand = null;
  }
  res.json({ ok: true });
});

app.get("/plugin/status", (req, res) => {
  res.json({ connected: Date.now() - pluginLastPing < 3000 });
});

function execPlugin(command, data) {
  return new Promise((resolve, reject) => {
    const id     = randomUUID();
    const _timer = setTimeout(() => {
      if (pendingPluginCommand?.id === id) {
        pendingPluginCommand = null;
        reject(new Error(`Plugin timeout en "${command}". ¿Está Roblox Studio abierto y conectado?`));
      }
    }, PLUGIN_TIMEOUT_MS);
    pendingPluginCommand = { id, command, data, resolve, reject, _timer };
  });
}

// ─── Session & Activity endpoints ─────────────────────────────

app.get("/session/stats", (req, res) => {
  const id = getCurrentConversationId();
  const conv = id ? conversations[id] : null;
  res.json({
    scriptsIndexed,
    activityCount : activityLog.length,
    sessionSeconds: Math.floor((Date.now() - sessionStart) / 1000),
    connected     : Date.now() - pluginLastPing < 3000,
    model         : ACTIVE_MODEL,
    modelReady    : modelResolved,
    currentChat   : conv ? { id: conv.id, title: conv.title, tokenCount: conv.tokenCount, msgCount: conv.messages.length } : null,
  });
});

app.get("/activity", (req, res) => {
  res.json({ log: activityLog.slice(-60) });
});

app.post("/activity/:id/undo", async (req, res) => {
  const entry = activityLog.find(a => a.id === req.params.id);
  if (!entry?.canUndo || !entry.undoData)
    return res.status(400).json({ error: "No se puede deshacer esta acción" });
  if (entry.undone)
    return res.status(400).json({ error: "Ya fue deshecho" });
  try {
    await execPlugin("write_script", {
      path  : entry.undoData.path,
      source: entry.undoData.originalSource,
    });
    entry.undone = true;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Syntax guard (pre-flight Lua check) ──────────────────────
function luaSyntaxGuard(source) {
  const errors = [];
  const lines  = source.split("\n");

  let depth = 0;
  const openers = /\b(function|do|if|for|while|repeat)\b/g;
  const closers = /\bend\b/g;

  for (const line of lines) {
    const stripped = line.replace(/--.*$/, "");
    depth += (stripped.match(openers) || []).length;
    depth -= (stripped.match(closers) || []).length;
  }
  if (depth > 0) errors.push(`⚠ Faltan ${depth} 'end' — bloque sin cerrar`);
  if (depth < 0) errors.push(`⚠ ${Math.abs(depth)} 'end' de más`);

  const deprecated = [
    ["wait(", "task.wait("],
    ["spawn(", "task.spawn("],
    ["delay(", "task.delay("],
    ["game.Players", "game:GetService('Players')"],
    ["game.Workspace", "game:GetService('Workspace')"],
    [":FindFirstChild(", ":WaitForChild( (considera timeout)"],
  ];
  for (const [bad, good] of deprecated) {
    if (source.includes(bad))
      errors.push(`⚠ API obsoleta: '${bad}' → usa '${good}'`);
  }

  return errors;
}

// ─── Web search via OpenRouter ────────────────────────────────
async function webSearchForDocs(query) {
  const res = await orChat({
    max_tokens: 512,
    messages: [{
      role   : "user",
      content: `Search the web for: ${query}\nReturn a concise summary of the most relevant results.`,
    }],
    system: "You are a research assistant. Search the web and return a brief, factual summary.",
  });
  return res.content.find(b => b.type === "text")?.text || "Sin resultados";
}

// ─── Playtest en vivo ─────────────────────────────────────────
// Estado del playtest en curso (llenado por POST /plugin/playtest/*)
let activePlaytest = null;

app.get("/plugin/playtest/status", (req, res) => {
  res.json({ active: !!activePlaytest });
});

// El plugin confirma que el playtest arrancó (o reporta error)
app.post("/plugin/playtest/start-result", (req, res) => {
  const { playtestId, ready, error } = req.body;
  if (activePlaytest && activePlaytest.playtestId === playtestId) {
    clearTimeout(activePlaytest._timer);
    if (error) {
      const rej = activePlaytest.reject;
      activePlaytest = null;
      rej(new Error(error));
    }
  }
  res.json({ ok: true });
});

// El plugin devuelve el reporte final del playtest (errores, output, eventos)
app.post("/plugin/playtest/report", (req, res) => {
  const { playtestId, report } = req.body;
  if (activePlaytest && activePlaytest.playtestId === playtestId) {
    clearTimeout(activePlaytest._timer);
    activePlaytest.finish({ success: true, report: report || {} });
    activePlaytest = null;
  }
  res.json({ ok: true });
});

function runPlaytest({ goal, actions, duration }) {
  return new Promise((resolve, reject) => {
    const playtestId = randomUUID();
    const durSec = Math.min(90, Math.max(5, Math.floor(duration || 20)));
    const _timer = setTimeout(() => {
      if (activePlaytest?.playtestId === playtestId) {
        activePlaytest = null;
        reject(new Error(`Playtest timeout (${durSec}s). ¿Está Roblox Studio abierto?`));
      }
    }, (durSec + 60) * 1000);
    activePlaytest = { playtestId, goal, actions, duration: durSec, reject, _timer, finish: resolve };
    // El servidor pide al plugin lanzar el playtest (lo recoge en su próximo poll)
    execPlugin("playtest_verify", { playtestId, goal, actions, duration: durSec })
      .then(() => {
        // El plugin aceptó el comando; el resultado llega por /plugin/playtest/report
      })
      .catch(err => {
        clearTimeout(_timer);
        if (activePlaytest?.playtestId === playtestId) {
          activePlaytest = null;
          reject(err);
        }
      });
  });
}

// ─── Tools ────────────────────────────────────────────────────

function toORTools(tools) {
  return tools.map(t => ({
    type    : "function",
    function: {
      name       : t.name,
      description: t.description,
      parameters : t.input_schema,
    },
  }));
}

const TOOLS = [
  {
    name: "list_scripts",
    description: "Lista todos los scripts del lugar Roblox (Script, LocalScript, ModuleScript). Úsalo al inicio para indexar el codebase.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filtrar por substring del path (ej: 'ServerScriptService')" },
      },
      required: [],
    },
  },
  {
    name: "read_script",
    description: "Lee el código fuente completo de un script. SIEMPRE léelo antes de modificarlo.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta completa (ej: 'ServerScriptService/Main')" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_script",
    description: "Escribe/reemplaza el source de un script existente. Aplica syntax guard automático antes de enviar. Requiere haber leído antes.",
    input_schema: {
      type: "object",
      properties: {
        path  : { type: "string", description: "Ruta del script a modificar" },
        source: { type: "string", description: "Código fuente nuevo completo" },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "create_script",
    description: "Crea un script nuevo en la ruta indicada.",
    input_schema: {
      type: "object",
      properties: {
        path       : { type: "string" },
        script_type: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"] },
        source     : { type: "string" },
      },
      required: ["path", "script_type", "source"],
    },
  },
  {
    name: "get_place_info",
    description: "Obtiene la estructura del lugar: servicios y sus hijos directos.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_in_scripts",
    description: "Grep en todos los scripts: busca un texto/patrón y devuelve qué scripts lo contienen y en qué línea.",
    input_schema: {
      type: "object",
      properties: {
        pattern       : { type: "string", description: "Texto a buscar" },
        case_sensitive: { type: "boolean", description: "Case-sensitive (default: false)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "delete_script",
    description: "Elimina (destruye) un script del lugar.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta completa del script a eliminar" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_errors",
    description: "Obtiene errores de runtime capturados desde el Output de Roblox Studio.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_roblox_docs",
    description: "Busca en la documentación oficial de Roblox y DevForum para APIs actualizadas. Úsalo cuando no estés seguro de una API o su versión actual 2026.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Término o pregunta a buscar (ej: 'CollectionService GetTagged 2026')" },
      },
      required: ["query"],
    },
  },
];

const OR_TOOLS = toORTools(TOOLS);

const SYSTEM_PROMPT = `Eres un agente experto de Roblox Studio (2026) con acceso directo al proyecto abierto del desarrollador.
Ejecutas en OpenRouter usando ${ACTIVE_MODEL}.

## Herramientas disponibles
- **list_scripts** — Indexa todos los scripts del lugar
- **read_script** — Lee un script (OBLIGATORIO antes de escribirlo)
- **write_script** — Reemplaza source (pasa syntax guard automático)
- **create_script** — Crea un script nuevo
- **get_place_info** — Estructura del lugar (servicios e hijos)
- **search_in_scripts** — Grep en todo el codebase
- **delete_script** — Elimina un script
- **get_errors** — Captura errores del Output/runtime
- **search_roblox_docs** — Busca docs actualizadas + DevForum en vivo

## Archivos adjuntos
El usuario puede adjuntar archivos de código (.lua, .luau, .txt, .md, .json, .rbxlx). Cuando lo haga:
1. Analiza el contenido antes de responder
2. Si son scripts, úsalos como contexto directo (no hace falta list_scripts para ese código)
3. Si el usuario pide modificar un archivo adjunto, devuelve el código completo modificado en un bloque \`\`\`lua

## Flujo de trabajo obligatorio
1. **INDEXA** con list_scripts si no sabes qué hay en el proyecto
2. **BUSCA DOCS** con search_roblox_docs si la API es nueva o dudosa
3. **GREP** con search_in_scripts para localizar referencias antes de editar
4. **LEE** con read_script antes de cualquier write_script
5. **ESCRIBE** con cirugía: preserva whitespace, comentarios y estructura
6. **CAPTURA ERRORES** con get_errors si el dev reporta bugs en runtime
7. **VERIFICA EN VIVO** con playtest_verify tras cambiar lógica de gameplay (máx 2 iteraciones de corrección)
8. **EXPLICA** qué debe probar el dev después de cada cambio

## Equipo de especialistas internos
Para tareas complejas actúa como un equipo:
- 🔍 **Codebase Scout** — Navega e indexa, traza dependencias
- 🐛 **Bug Analyst** — Traza cadenas de error client↔server↔module
- ✍️ **Script Writer** — Escribe código limpio, comentado y performante
- 🔒 **Security Guard** — Valida que no haya exploits o server trust issues
- 📖 **Doc Researcher** — Consulta APIs actualizadas antes de escribir

## Mejores prácticas Luau / Roblox 2026
- \`task.wait()\` no \`wait()\` — \`task.spawn()\` no \`spawn()\` — \`task.delay()\` no \`delay()\`
- \`game:GetService("X")\` no \`game.X\`
- \`:WaitForChild("Name", timeout)\` con timeout explícito
- DataStore siempre con \`pcall\` — nunca confíes en el cliente
- RemoteEvents para client↔server — valida todo del lado servidor
- Eventos sobre loops: usa \`Changed\`, \`ChildAdded\`, \`Heartbeat\` apropiado
- Anota tipos cuando ayude: \`local count: number = 0\`
- Nunca uses APIs deprecadas

## Estilo de respuesta
- Conciso y directo — usa markdown
- Bloques de código siempre con \`\`\`lua
- Después de editar: "✓ [path] editado · Testea: [qué exactamente]"
- Si hay errores del Output, analízalos primero antes de proponer soluciones`;

// ─── Job system (SSE streaming token a token) ─────────────────

function emitToJob(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  const data = JSON.stringify(event);
  job.events.push(data);
  job.listeners.forEach(fn => fn(data));
}

// Parsear el SSE de OpenRouter token a token y emitir eventos al frontend
async function streamResponseToJob(jobId, readableStream, { onText, onDone, onError }) {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    const reader = readableStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // último fragmento incompleto

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") { onDone(); return; }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) onText(delta.content);
        } catch (_) { /* fragmento no válido, ignorar */ }
      }
    }
    onDone();
  } catch (err) {
    onError(err);
  }
}

async function runJob(jobId, userMessage, { attachments = [] } = {}) {
  try {
    emitToJob(jobId, { type: "thinking" });

    // 1. Construir contenido del mensaje de usuario (texto + adjuntos)
    const activeMsgs = getActiveMessages();

    // Convertir historial interno → formato OpenRouter
    const orHistory = activeMsgs.map(m => {
      if (m.role === "assistant") {
        const blocks = Array.isArray(m.content) ? m.content : [];
        const content = blocks
          .filter(b => b && b.type === "text")
          .map(b => b.text)
          .join("\n");
        const tool_calls = blocks
          .filter(b => b && b.type === "tool_use")
          .map(b => ({
            id      : b.id,
            type    : "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        if (!content && !tool_calls.length) return null;
        return { role: "assistant", content: content || undefined, tool_calls: tool_calls.length ? tool_calls : undefined };
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        // Bloques de tool_result
        const tool_results = m.content
          .filter(b => b && b.type === "tool_result")
          .map(b => ({
            role        : "tool",
            tool_call_id: b.tool_use_id,
            content     : b.content,
          }));
        if (!tool_results.length) return null;
        return tool_results; // will be flattened
      }
      return m;
    }).flat().filter(Boolean);

    // Mensaje de usuario: texto + contexto de archivos adjuntos
    let userContent = userMessage;
    if (attachments.length) {
      const filesCtx = attachments
        .filter(f => !f.error)
        .map(f => `--- Archivo adjunto: ${f.name} (${f.ext || ""}, ${f.chars} caracteres) ---\n${f.preview || ""}`)
        .join("\n\n");
      userContent = `${userMessage}\n\n${filesCtx}\n--- Fin de archivos adjuntos ---`;
      const errList = attachments.filter(f => f.error).map(f => `• ${f.name}: ${f.error}`).join("\n");
      if (errList) {
        emitToJob(jobId, { type: "file_error", files: errList });
      }
    }

    let currentMessages = [...orHistory, { role: "user", content: userContent }];
    let response;

    // 2. Tool loop (sin streaming: las respuestas de herramientas deben ser completas)
    while (true) {
      response = await orChat({
        messages  : currentMessages,
        tools     : OR_TOOLS,
        system    : SYSTEM_PROMPT,
        max_tokens: 8192,
      });

      if (response.stop_reason !== "tool_use") break;

      const toolUses    = response.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUses) {
        const startTime = Date.now();

        emitToJob(jobId, {
          type : "tool_start",
          name : toolUse.name,
          input: toolUse.input,
          id   : toolUse.id,
        });

        let result;
        let success        = true;
        let originalSource = null;
        let syntaxWarnings = [];

        if (toolUse.name === "write_script" && toolUse.input?.path) {
          try {
            const orig = await execPlugin("read_script", { path: toolUse.input.path });
            originalSource = orig?.source ?? null;
          } catch (_) { /* skip */ }
        }

        if ((toolUse.name === "write_script" || toolUse.name === "create_script") && toolUse.input?.source) {
          syntaxWarnings = luaSyntaxGuard(toolUse.input.source);
          if (syntaxWarnings.length) {
            emitToJob(jobId, { type: "syntax_warn", warnings: syntaxWarnings });
          }
        }

        try {
          if (toolUse.name === "search_roblox_docs") {
            result = { summary: await webSearchForDocs(toolUse.input.query) };
          } else if (toolUse.name === "playtest_verify") {
            result = await runPlaytest(toolUse.input);
          } else {
            result = await execPlugin(toolUse.name, toolUse.input);
          }
          console.log(`  ✓ ${toolUse.name}`);

          if (toolUse.name === "list_scripts" && result?.count !== undefined) {
            scriptsIndexed = result.count;
          }

          const actEntry = {
            id        : randomUUID(),
            toolName  : toolUse.name,
            input     : toolUse.input,
            result,
            timestamp : Date.now(),
            duration  : Date.now() - startTime,
            canUndo   : toolUse.name === "write_script" && originalSource !== null,
            undoData  : toolUse.name === "write_script"
              ? { path: toolUse.input.path, originalSource }
              : null,
            undone        : false,
            syntaxWarnings,
          };
          activityLog.push(actEntry);
          emitToJob(jobId, { type: "activity", entry: actEntry });

        } catch (err) {
          result  = { error: err.message };
          success = false;
          console.log(`  ✗ ${toolUse.name}: ${err.message}`);
        }

        emitToJob(jobId, {
          type          : "tool_end",
          name          : toolUse.name,
          result,
          success,
          id            : toolUse.id,
          duration      : Date.now() - startTime,
          syntaxWarnings,
          originalSource: toolUse.name === "write_script" ? originalSource : undefined,
          newSource     : toolUse.name === "write_script" ? toolUse.input?.source : undefined,
        });

        toolResults.push({
          type       : "tool_result",
          tool_use_id: toolUse.id,
          content    : JSON.stringify(result),
        });
      }

      // Asistente + tool results en formato interno + OpenRouter
      const assistantMsgInternal = {
        role      : "assistant",
        content   : (() => {
          const out = [];
          const textBlock = response.content.find(b => b.type === "text");
          if (textBlock) out.push({ type: "text", text: textBlock.text });
          for (const b of response.content.filter(b => b.type === "tool_use")) {
            out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
          }
          return out;
        })(),
      };

      const assistantMsgOR = {
        role      : "assistant",
        content   : response.content.find(b => b.type === "text")?.text || null,
        tool_calls: response.content
          .filter(b => b.type === "tool_use")
          .map(b => ({
            id      : b.id,
            type    : "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
      };

      const toolResultMsg = {
        role   : "user",
        content: [
          ...toolResults.map(tr => ({ type: "tool_result", tool_use_id: tr.tool_use_id, content: tr.content })),
        ],
      };

      // Guardar en el historial interno (persistente)
      const newActiveMsgs = [...activeMsgs, assistantMsgInternal, toolResultMsg];
      setActiveMessages(newActiveMsgs);

      currentMessages = [
        ...currentMessages,
        assistantMsgOR,
        ...toolResults.map(tr => ({
          role        : "tool",
          tool_call_id: tr.tool_use_id,
          content     : tr.content,
        })),
      ];
    }

    // 3. Streaming token a token de la respuesta final
    const textChunks = [];
    const streamRes = await orChatStream({
      messages  : currentMessages,
      tools     : OR_TOOLS,
      system    : SYSTEM_PROMPT,
      max_tokens: 8192,
    });

    await new Promise((resolve, reject) => {
      streamResponseToJob(jobId, streamRes, {
        onText  : chunk => { textChunks.push(chunk); emitToJob(jobId, { type: "text", content: chunk, partial: true }); },
        onDone  : () => {
          const fullText = textChunks.join("");
          emitToJob(jobId, { type: "text", content: fullText, partial: false });
          resolve();
        },
        onError : err => {
          // Si el streaming falla, intentar respuesta completa de respaldo
          orChat({ messages: currentMessages, tools: OR_TOOLS, system: SYSTEM_PROMPT })
            .then(resp => {
              const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
              emitToJob(jobId, { type: "text", content: text, partial: false });
              resolve();
            })
            .catch(reject);
        },
      });
    });

    // Guardar la respuesta del asistente en el historial
    const finalText = textChunks.join("");
    const finalActiveMsgs = getActiveMessages();
    finalActiveMsgs.push({ role: "assistant", content: [{ type: "text", text: finalText || "✓" }] });
    setActiveMessages(finalActiveMsgs);

    // Título automático en el primer turno
    const conv = getCurrentConversationId();
    if (conv && conversations[conv].title === "Nueva conversación") {
      const title = userMessage.slice(0, 40);
      conversations[conv].title = title + (userMessage.length > 40 ? "…" : "");
      saveConversations();
    }

    emitToJob(jobId, { type: "done" });
    const job = jobs.get(jobId);
    if (job) job.status = "done";

  } catch (err) {
    console.error("[Job Error]", err.message);
    emitToJob(jobId, { type: "error", message: err.message });
    const job = jobs.get(jobId);
    if (job) job.status = "error";
  }

  // Limpiar job de la memoria tras 10 minutos
  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
}

// ─── Chat endpoints ───────────────────────────────────────────

app.post("/chat", (req, res) => {
  const { message, attachments } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Mensaje requerido" });

  // Auto-crear chat si no hay uno activo
  if (!getCurrentConversationId()) {
    const id = randomUUID();
    conversations[id] = {
      id,
      title   : "Nueva conversación",
      createdAt : Date.now(),
      updatedAt : Date.now(),
      messages  : [],
      tokenCount: 0,
    };
    setCurrentConversationId(id);
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: "running", events: [], listeners: [] });
  console.log(`\n[Chat] "${message.slice(0, 70)}${message.length > 70 ? "..." : ""}"`);
  runJob(jobId, message.trim(), { attachments: attachments || [] });
  res.json({ job_id: jobId, chat_id: getCurrentConversationId() });
});

app.get("/chat/stream/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (!job) {
    res.write("data: " + JSON.stringify({ type: "error", message: "Job no encontrado" }) + "\n\n");
    return res.end();
  }

  job.events.forEach(data => res.write("data: " + data + "\n\n"));
  if (job.status === "done" || job.status === "error") return res.end();

  const listener = data => {
    res.write("data: " + data + "\n\n");
    const ev = JSON.parse(data);
    if (ev.type === "done" || ev.type === "error") res.end();
  };

  job.listeners.push(listener);
  req.on("close", () => {
    if (job.listeners) job.listeners = job.listeners.filter(l => l !== listener);
  });
});

app.get("/model", (req, res) => {
  res.json({ model: ACTIVE_MODEL, ready: modelResolved, candidates: FREE_MODEL_CANDIDATES });
});

// ─── Start ─────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

async function start() {
  if (!OR_API_KEY) {
    console.error("\n  ✗ Falta OPENROUTER_API_KEY en tu entorno\n  Obtén una gratis en: https://openrouter.ai/keys\n");
    process.exit(1);
  }

  await pickBestFreeModel();

  // Auto-crear chat por defecto si no hay ninguno
  if (!Object.keys(conversations).length) {
    const id = randomUUID();
    conversations[id] = {
      id,
      title   : "Nueva conversación",
      createdAt : Date.now(),
      updatedAt : Date.now(),
      messages  : [],
      tokenCount: 0,
    };
    setCurrentConversationId(id);
  }

  app.listen(PORT, () => {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║  🤖  RBX-AI Studio  v4 PRO (OpenRouter)  ║");
    console.log(`║  Modelo  → ${ACTIVE_MODEL.padEnd(30)}║`);
    console.log(`║  Chat    → http://localhost:${PORT}           ║`);
    console.log(`║  Plugin  → http://localhost:${PORT}/plugin    ║`);
    console.log(`║  Datos   → ${DATA_DIR.padEnd(33)}║`);
    console.log("╚══════════════════════════════════════════╝\n");
  });
}

start();
