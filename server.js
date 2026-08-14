// ════════════════════════════════════════════════════════════════
//  RBX-AI Studio Server — v3 (OpenRouter Edition)
//  Auto-selects best free coding model from OpenRouter
//  Features: web_search, syntax guard, diff, undo, activity log,
//            session stats, subagents, Pisces parity
// ════════════════════════════════════════════════════════════════

const express        = require("express");
const cors           = require("cors");
const path           = require("path");
const fs             = require("fs");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

// Serve static files from the root directory (index.html lives next to server.js)
const PUBLIC_DIR = __dirname;
app.use(express.static(PUBLIC_DIR));

// Explicit fallback: serve index.html for GET /
app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>RBX-AI Studio v3</title></head><body style="font-family:sans-serif;padding:2rem;background:#06090f;color:#c8d6e8">
<h1>RBX-AI Studio v3</h1>
<p>El servidor está corriendo pero <code>index.html</code> no se encontró en el directorio raíz.</p>
<p>Asegúrate de que <code>index.html</code> esté en la raíz de tu repositorio junto a <code>server.js</code>.</p>
<p>API status: <a href="/plugin/status" style="color:#38bdf8">/plugin/status</a></p>
</body></html>`);
  }
});

// ─── OpenRouter Config ────────────────────────────────────────

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OR_API_KEY      = process.env.OPENROUTER_API_KEY;

// Ordered list of best free coding models (priority order).
// Server auto-picks the first one that responds OK on startup.
// All have :free suffix = $0 cost on OpenRouter.
const FREE_MODEL_CANDIDATES = [
  "qwen/qwen3-coder:free",                        // #1 coding 2026, 256K ctx
  "deepseek/deepseek-r1-0528:free",               // razonamiento top, gratis
  "meta-llama/llama-3.3-70b-instruct:free",       // estable, 131K ctx
  "deepseek/deepseek-chat-v3-0324:free",          // muy bueno en código
  "google/gemma-3-27b-it:free",                   // backup Google
  "mistralai/mistral-nemo:free",                  // ligero y rápido
];

let ACTIVE_MODEL    = FREE_MODEL_CANDIDATES[0]; // filled on startup
let modelResolved   = false;

async function pickBestFreeModel() {
  console.log("\n  🔍 Detectando mejor modelo gratuito en OpenRouter...");
  const headers = {
    "Authorization": `Bearer ${OR_API_KEY}`,
    "Content-Type":  "application/json",
    "HTTP-Referer":  "https://rbx-ai-studio.local",
    "X-Title":       "RBX-AI Studio",
  };

  // First, fetch live free models from OR API and filter by coding
  try {
    const res  = await fetch(`${OPENROUTER_BASE}/models`, { headers });
    const data = await res.json();
    if (data?.data) {
      const free = data.data
        .filter(m => m.pricing?.prompt === "0" && m.pricing?.completion === "0")
        .map(m => m.id);
      console.log(`  ✓ OR reporta ${free.length} modelos gratuitos en vivo`);

      // Re-order candidates keeping only those confirmed free right now
      const confirmed = FREE_MODEL_CANDIDATES.filter(c => free.includes(c));
      if (confirmed.length > 0) {
        FREE_MODEL_CANDIDATES.splice(0, FREE_MODEL_CANDIDATES.length, ...confirmed);
        console.log(`  ✓ Confirmados: ${confirmed.join(", ")}`);
      }
    }
  } catch (e) {
    console.log("  ⚠ No se pudo consultar lista de modelos, usando lista fija");
  }

  // Probe each candidate with a tiny request
  for (const modelId of FREE_MODEL_CANDIDATES) {
    try {
      const probe = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (probe.ok) {
        ACTIVE_MODEL  = modelId;
        modelResolved = true;
        console.log(`  ✅ Modelo seleccionado: ${ACTIVE_MODEL}\n`);
        return;
      }
    } catch (_) { /* try next */ }
  }
  console.log(`  ⚠ Ningún modelo respondió, usando ${ACTIVE_MODEL} de todos modos\n`);
  modelResolved = true;
}

// OpenRouter chat completion — con fallback automático si el modelo activo da 429
async function orChat({ messages, tools, system, max_tokens = 8192 }) {
  // Lista base segura nunca null
  const base = (Array.isArray(FREE_MODEL_CANDIDATES) && FREE_MODEL_CANDIDATES.length > 0)
    ? FREE_MODEL_CANDIDATES
    : ["meta-llama/llama-3.3-70b-instruct:free", "google/gemma-3-27b-it:free", "mistralai/mistral-nemo:free"];

  const activeIdx  = base.indexOf(ACTIVE_MODEL);
  const candidates = activeIdx >= 0
    ? [ACTIVE_MODEL, ...base.filter((_, i) => i !== activeIdx)]
    : [ACTIVE_MODEL, ...base].filter(Boolean);

  const OR_HEADERS = {
    "Authorization": `Bearer ${OR_API_KEY}`,
    "Content-Type":  "application/json",
    "HTTP-Referer":  "https://rbx-ai-studio.local",
    "X-Title":       "RBX-AI Studio",
  };

  let lastError;

  for (const modelId of candidates) {
    const body = {
      model: modelId,
      max_tokens,
      messages: system
        ? [{ role: "system", content: system }, ...messages]
        : messages,
    };
    if (tools?.length) {
      body.tools       = tools;
      body.tool_choice = "auto";
    }

    let res;
    try {
      res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: OR_HEADERS,
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      lastError = new Error(`Error de red: ${netErr.message}`);
      continue;
    }

    if (res.status === 429) {
      let errJson = {};
      try { errJson = await res.json(); } catch (_) {}
      const limitSource = errJson?.error?.metadata?.limit_source || "";

      // Límite de cuenta (no de upstream) — no tiene caso probar más modelos
      if (limitSource.includes("openrouter_free_tier")) {
        throw new Error(
          "⚠ Límite diario de OpenRouter alcanzado (50 req/día gratuitas).\n" +
          "Opciones:\n" +
          "  1. Espera hasta medianoche UTC (reset automático)\n" +
          "  2. Agrega $10 créditos en https://openrouter.ai/settings/billing\n" +
          "  3. Cambia a Gemini API (1500 req/día gratis)"
        );
      }

      // 429 upstream → prueba siguiente modelo
      console.log(`  ⚠ 429 upstream en ${modelId} — probando siguiente...`);
      lastError = new Error(`429 en ${modelId}`);
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      lastError = new Error(`OpenRouter error ${res.status}: ${err}`);
      continue;
    }

    const data   = await res.json();
    const choice = data.choices?.[0];
    const msg    = choice?.message;
    if (!msg) { lastError = new Error("Respuesta vacía de OpenRouter"); continue; }

    if (modelId !== ACTIVE_MODEL) {
      console.log(`  ✅ Fallback exitoso → usando ${modelId}`);
      ACTIVE_MODEL = modelId;
    }

    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        content.push({
          type : "tool_use",
          id   : tc.id,
          name : tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
    }

    return {
      stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
      content,
    };
  }

  throw lastError || new Error("Todos los modelos de OpenRouter fallaron. Intenta más tarde.");
}

// ─── Estado global ────────────────────────────────────────────

let pluginLastPing       = 0;
let pendingPluginCommand = null;
let conversationHistory  = [];
let scriptsIndexed       = 0;
let sessionStart         = Date.now();
const jobs               = new Map();
const activityLog        = [];

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
    }, 15000);
    pendingPluginCommand = { id, command, data, resolve, reject, _timer };
  });
}

// ─── Session & Activity endpoints ─────────────────────────────

app.get("/session/stats", (req, res) => {
  res.json({
    scriptsIndexed,
    activityCount : activityLog.length,
    sessionSeconds: Math.floor((Date.now() - sessionStart) / 1000),
    connected     : Date.now() - pluginLastPing < 3000,
    model         : ACTIVE_MODEL,
    modelReady    : modelResolved,
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
// Catches unbalanced blocks, missing 'end', obvious API typos
function luaSyntaxGuard(source) {
  const errors = [];
  const lines  = source.split("\n");

  // Balance check: function/do/if/for/while vs end
  let depth = 0;
  const openers = /\b(function|do|if|for|while|repeat)\b/g;
  const closers = /\bend\b/g;

  for (const line of lines) {
    const stripped = line.replace(/--.*$/, ""); // strip comments
    depth += (stripped.match(openers) || []).length;
    depth -= (stripped.match(closers) || []).length;
  }
  if (depth > 0) errors.push(`⚠ Faltan ${depth} 'end' — bloque sin cerrar`);
  if (depth < 0) errors.push(`⚠ ${Math.abs(depth)} 'end' de más`);

  // Deprecated API check
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

// ─── Web search via OpenRouter web tool ───────────────────────
async function webSearchForDocs(query) {
  // Uses OR's built-in web search capability via the model
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

// ─── Tools ────────────────────────────────────────────────────

// Convert Anthropic-style tools to OpenRouter/OpenAI format
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

## Flujo de trabajo obligatorio
1. **INDEXA** con list_scripts si no sabes qué hay en el proyecto
2. **BUSCA DOCS** con search_roblox_docs si la API es nueva o dudosa
3. **GREP** con search_in_scripts para localizar referencias antes de editar
4. **LEE** con read_script antes de cualquier write_script
5. **ESCRIBE** con cirugía: preserva whitespace, comentarios y estructura
6. **CAPTURA ERRORES** con get_errors si el dev reporta bugs en runtime
7. **EXPLICA** qué debe probar el dev después de cada cambio

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

// ─── Job system (SSE streaming) ───────────────────────────────

function emitToJob(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  const data = JSON.stringify(event);
  job.events.push(data);
  job.listeners.forEach(fn => fn(data));
}

async function runJob(jobId, userMessage) {
  try {
    emitToJob(jobId, { type: "thinking" });

    // Convert stored history to OR format
    const orHistory = conversationHistory.map(m => {
      if (m.role === "assistant") {
        // Re-assemble OR assistant message
        const content = m.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n");
        const tool_calls = m.content
          .filter(b => b.type === "tool_use")
          .map(b => ({
            id      : b.id,
            type    : "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        return { role: "assistant", content: content || null, tool_calls: tool_calls.length ? tool_calls : undefined };
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        // Tool results
        const tool_results = m.content
          .filter(b => b.type === "tool_result")
          .map(b => ({
            role       : "tool",
            tool_call_id: b.tool_use_id,
            content    : b.content,
          }));
        return tool_results; // will be flattened
      }
      return m;
    }).flat();

    let currentMessages = [...orHistory, { role: "user", content: userMessage }];
    let response;

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

        // Capture original for undo
        if (toolUse.name === "write_script" && toolUse.input?.path) {
          try {
            const orig = await execPlugin("read_script", { path: toolUse.input.path });
            originalSource = orig?.source ?? null;
          } catch (_) { /* skip */ }
        }

        // Run syntax guard before writing
        if ((toolUse.name === "write_script" || toolUse.name === "create_script") && toolUse.input?.source) {
          syntaxWarnings = luaSyntaxGuard(toolUse.input.source);
          if (syntaxWarnings.length) {
            emitToJob(jobId, { type: "syntax_warn", warnings: syntaxWarnings });
          }
        }

        try {
          if (toolUse.name === "search_roblox_docs") {
            // Internal web search — no plugin needed
            result = { summary: await webSearchForDocs(toolUse.input.query) };
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

      // Add assistant + tool results in OR format
      const assistantMsg = {
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

      currentMessages = [
        ...currentMessages,
        assistantMsg,
        ...toolResults.map(tr => ({
          role        : "tool",
          tool_call_id: tr.tool_use_id,
          content     : tr.content,
        })),
      ];
    }

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    // Store history (keep last 20 turns)
    conversationHistory = currentMessages.slice(-40);

    emitToJob(jobId, { type: "text", content: text });
    emitToJob(jobId, { type: "done" });
    const job = jobs.get(jobId);
    if (job) job.status = "done";

  } catch (err) {
    console.error("[Job Error]", err.message);
    emitToJob(jobId, { type: "error", message: err.message });
    const job = jobs.get(jobId);
    if (job) job.status = "error";
  }

  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
}

// ─── Chat endpoints ────────────────────────────────────────────

app.post("/chat", (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Mensaje requerido" });

  const jobId = randomUUID();
  jobs.set(jobId, { status: "running", events: [], listeners: [] });
  console.log(`\n[Chat] "${message.slice(0, 70)}${message.length > 70 ? "..." : ""}"`);
  runJob(jobId, message.trim());
  res.json({ job_id: jobId });
});

app.get("/chat/stream/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  res.setHeader("Content-Type",     "text/event-stream");
  res.setHeader("Cache-Control",    "no-cache");
  res.setHeader("Connection",       "keep-alive");
  res.setHeader("X-Accel-Buffering","no");

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

app.post("/chat/reset", (req, res) => {
  conversationHistory = [];
  scriptsIndexed      = 0;
  sessionStart        = Date.now();
  activityLog.length  = 0;
  console.log("[Chat] Sesión reiniciada");
  res.json({ ok: true });
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

  app.listen(PORT, () => {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║  🤖  RBX-AI Studio  v3 (OpenRouter)      ║");
    console.log(`║  Modelo  → ${ACTIVE_MODEL.padEnd(31)}║`);
    console.log(`║  Chat    → http://localhost:${PORT}           ║`);
    console.log(`║  Plugin  → http://localhost:${PORT}/plugin    ║`);
    console.log("╚══════════════════════════════════════════╝\n");
  });
}

start();
