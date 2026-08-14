--[[
  RBX-AI Studio — Plugin Bridge para Roblox Studio
  =================================================
  Puente entre tu servidor (local, Railway o Colab) y Roblox Studio.

  Qué hace:
    1. POLL  — Hace GET /plugin/poll cada ~0.5s y ejecuta los comandos que le
       manda el servidor (listar, leer, escribir, crear y borrar scripts, grep,
       errores del Output, info del lugar).
    2. INDEX — Envía al servidor el árbol completo de scripts del lugar al
       conectar y después de cada edición.
    3. PLAYTEST — Cuando el servidor pide playtest_verify, lanza Play Solo,
       captura los errores de runtime y los logs del Output, y los reporta.

  Instalación (2 formas):
    A) Local: pega este código en un plugin de Studio (Plugins → Advanced →
       New Plugin) y pulsa "Run". Aparece la ventana "RBX-AI Bridge" donde
       pegas la URL de tu servidor.
    B) Desde tu servidor: abre http://localhost:3000/plugin/download y descarga
       el .rbxmx (requiere tener este archivo servido).

  Nota: Studio te pedirá permiso para peticiones HTTP y edición de scripts al
  primer uso — acepta ambos, son necesarios.
]]

local HttpService    = game:GetService("HttpService")
local ChangeHistory  = game:GetService("ChangeHistoryService")
local LogService     = game:GetService("LogService")
local ScriptContext  = game:GetService("ScriptContext")
local RunService     = game:GetService("RunService")
local StudioService  = game:GetService("StudioService")
local TestService    = game:GetService("TestService")
local CoreGui        = game:GetService("CoreGui")
local Players        = game:GetService("Players")

-- ═══════════════════════════════════════════════════════════════
--  CONFIGURACIÓN
-- ═══════════════════════════════════════════════════════════════

local DEFAULT_URL = "http://localhost:3000"   -- cambia o pégala en la ventana
local POLL_INTERVAL  = 0.5                    -- segundos entre peticiones
local MAX_BODY_LOG   = 200                    -- últimas líneas del Output
local PLAYTEST_MAX_ERRORS = 50                -- tope de errores en el reporte

-- ═══════════════════════════════════════════════════════════════
--  ESTADO
-- ═══════════════════════════════════════════════════════════════

local serverUrl = DEFAULT_URL
local connected = false
local pollRunning = false
local runtimeErrors   = {}     -- errores de ScriptContext.Error
local outputLog       = {}     -- líneas del Output (MessageOut)
local playtestActive  = false  -- ¿hay un playtest en curso?

-- ── Captura de errores ────────────────────────────────────────
ScriptContext.Error:Connect(function(message, trace)
  table.insert(runtimeErrors, {
    message = message,
    trace   = (trace or ""):sub(1, 4000),
    time    = tick(),
  })
  if #runtimeErrors > 200 then
    table.remove(runtimeErrors, 1)
  end
end)

LogService.MessageOut:Connect(function(message, messageType)
  if messageType == Enum.MessageType.MessageError
    or messageType == Enum.MessageType.MessageWarning
    or messageType == Enum.MessageType.MessageOutput then
    table.insert(outputLog, { msg = message, type = tostring(messageType), time = tick() })
    if #outputLog > MAX_BODY_LOG then
      table.remove(outputLog, 1)
    end
  end
end)

-- ── HTTP helpers ──────────────────────────────────────────────
local function httpGet(url)
  local ok, res = pcall(function()
    return HttpService:GetAsync(url, false, { ["User-Agent"] = "RBX-AI-Plugin" })
  end)
  return ok, res
end

local function httpPost(url, body)
  local ok, res = pcall(function()
    return HttpService:PostAsync(url, HttpService:JSONEncode(body), Enum.HttpContentType.ApplicationJson, false, "RBX-AI-Plugin")
  end)
  return ok, res
end

local function notify(kind, msg)
  local payload = { type = kind, message = msg, place = game.PlaceId }
  httpPost(serverUrl .. "/plugin/event", payload)
end

-- ═══════════════════════════════════════════════════════════════
--  HERRAMIENTAS (las ejecuta el plugin por mandato del servidor)
-- ═══════════════════════════════════════════════════════════════

local tools = {}

-- ── get_place_info: estructura del lugar ──────────────────────
tools.get_place_info = function()
  local tree = {}
  local services = game:GetChildren()
  for _, svc in ipairs(services) do
    local children = {}
    for _, child in ipairs(svc:GetChildren()) do
      if child:IsA("Script") or child:IsA("LocalScript") or child:IsA("ModuleScript")
        or child:IsA("RemoteEvent") or child:IsA("RemoteFunction")
        or child:IsA("Folder") or child:IsA("Model") or child:IsA("BindableEvent") then
        table.insert(children, {
          name = child.Name,
          class = child.ClassName,
          parent = svc.Name,
        })
      end
    end
    if #children > 0 then
      table.insert(tree, { service = svc.Name, children = children })
    end
  end
  return { ok = true, services = tree }
end

-- ── list_scripts: índice completo del codebase ────────────────
tools.list_scripts = function(input)
  local filter = (input and input.filter) or ""
  local result = { scripts = {}, count = 0 }
  for _, svc in ipairs(game:GetChildren()) do
    local function walk(parent, path)
      for _, child in ipairs(parent:GetChildren()) do
        if child:IsA("Script") or child:IsA("LocalScript") or child:IsA("ModuleScript") then
          local p = path .. "/" .. child.Name
          if filter == "" or p:lower():find(filter:lower(), 1, true) then
            result.count = result.count + 1
            table.insert(result.scripts, {
              path = p,
              type = child.ClassName,
              lines = #(child.Source or ""):gsub("\n", "\n"),
              size = #(child.Source or ""),
              disabled = not child.Enabled,
            })
          end
        elseif child:IsA("Folder") or child:IsA("Model") then
          walk(child, path .. "/" .. child.Name)
        end
      end
    end
    walk(svc, svc.Name)
  end
  return result
end

-- ── read_script: fuente completa ──────────────────────────────
tools.read_script = function(input)
  local inst = game:FindFirstChild(input.path, true)
  if not inst or not inst:IsA("BaseScript") then
    return { ok = false, error = "Script no encontrado: " .. tostring(input.path) }
  end
  return { ok = true, path = input.path, source = inst.Source, lines = select(2, inst.Source:gsub("\n", "")) + 1 }
end

-- ── write_script: reescribe un script existente ───────────────
tools.write_script = function(input)
  local inst = game:FindFirstChild(input.path, true)
  if not inst or not inst:IsA("BaseScript") then
    return { ok = false, error = "Script no encontrado: " .. tostring(input.path) }
  end
  local before = inst.Source
  ChangeHistory:SetWaypoint("RBX-AI: antes de edit")
  inst.Source = input.source
  inst.Enabled = true
  return { ok = true, path = input.path, changed = before ~= input.source }
end

-- ── create_script: script nuevo ───────────────────────────────
tools.create_script = function(input)
  local pathParts = {}
  for part in (input.path .. ""):gmatch("[^/]+") do
    table.insert(pathParts, part)
  end

  -- Localizar o crear el padre (carpetas intermedias)
  local parent = game
  local name = table.remove(pathParts)
  for _, part in ipairs(pathParts) do
    local folder = parent:FindFirstChild(part)
    if not folder or not (folder:IsA("Folder") or folder:IsA("Model")) then
      folder = Instance.new("Folder")
      folder.Name = part
      folder.Parent = parent
    end
    parent = folder
  end

  local existing = parent:FindFirstChild(name)
  if existing and existing:IsA("BaseScript") then
    existing.Source = input.source
    existing.Enabled = true
    return { ok = true, path = input.path, action = "updated" }
  elseif existing then
    return { ok = false, error = "Ya existe un objeto no-script con ese nombre: " .. input.path }
  end

  local script = Instance.new(input.script_type or "Script")
  script.Name = name
  script.Source = input.source
  script.Parent = parent
  ChangeHistory:SetWaypoint("RBX-AI: create " .. input.path)
  return { ok = true, path = input.path, action = "created" }
end

-- ── delete_script: destruir un script ─────────────────────────
tools.delete_script = function(input)
  local inst = game:FindFirstChild(input.path, true)
  if not inst or not inst:IsA("BaseScript") then
    return { ok = false, error = "Script no encontrado: " .. tostring(input.path) }
  end
  ChangeHistory:SetWaypoint("RBX-AI: antes de borrar")
  inst:Destroy()
  return { ok = true, path = input.path }
end

-- ── search_in_scripts: grep en todo el codebase ───────────────
tools.search_in_scripts = function(input)
  local pattern = input.pattern or ""
  local caseSensitive = input.case_sensitive == true
  local matches = {}
  local function walk(parent, path)
    for _, child in ipairs(parent:GetChildren()) do
      if child:IsA("BaseScript") then
        local p = path .. "/" .. child.Name
        local source = caseSensitive and child.Source or child.Source:lower()
        local find = caseSensitive and pattern or pattern:lower()
        for lineNo, line in ipairs(source:split("\n")) do
          if line:find(find, 1, true) then
            table.insert(matches, {
              path = p,
              line = lineNo,
              text = line:sub(1, 180),
            })
          end
        end
      elseif child:IsA("Folder") or child:IsA("Model") then
        walk(child, path .. "/" .. child.Name)
      end
    end
  end
  for _, svc in ipairs(game:GetChildren()) do
    walk(svc, svc.Name)
  end
  return { ok = true, pattern = pattern, total = #matches, matches = matches }
end

-- ── get_errors: snapshot de errores capturados ────────────────
tools.get_errors = function()
  local errors = {}
  for _, e in ipairs(runtimeErrors) do
    table.insert(errors, { message = e.message, trace = e.trace })
    if #errors >= PLAYTEST_MAX_ERRORS then break end
  end
  local output = {}
  local start = math.max(1, #outputLog - 80)
  for i = start, #outputLog do
    table.insert(output, outputLog[i])
  end
  return { ok = true, runtimeErrors = errors, outputLog = output }
end

-- ── index: enviar el árbol completo al servidor ───────────────
tools._index_all = function()
  local info  = tools.get_place_info()
  local list  = tools.list_scripts({})
  local errors = tools.get_errors()
  httpPost(serverUrl .. "/plugin/result", {
    id = nil,
    result = {
      indexed = true,
      placeInfo = info.services,
      scripts = list.scripts,
      count = list.count,
      errors = errors.runtimeErrors,
      output = errors.outputLog,
      time = os.date("!%Y-%m-%dT%H:%M:%SZ"),
    },
  })
end

-- ═══════════════════════════════════════════════════════════════
--  PLAYTEST EN VIVO
-- ═══════════════════════════════════════════════════════════════

local function runPlaytest(data)
  if playtestActive then return end
  playtestActive = true
  runtimeErrors = {}
  outputLog = {}

  local playtestId = data.playtestId
  local duration = math.min(90, math.max(5, tonumber(data.duration) or 20))

  local function finish(report)
    playtestActive = false
    httpPost(serverUrl .. "/plugin/playtest/report", {
      playtestId = playtestId,
      report = report,
    })
  end

  local function collectReport()
    local errs = {}
    for _, e in ipairs(runtimeErrors) do
      table.insert(errs, { message = e.message, trace = e.trace })
      if #errs >= PLAYTEST_MAX_ERRORS then break end
    end
    local out = {}
    local start = math.max(1, #outputLog - 120)
    for i = start, #outputLog do
      table.insert(out, outputLog[i])
    end
    finish({
      goal = data.goal,
      duration = duration,
      runtimeErrors = errs,
      errorCount = #errs,
      outputLog = out,
      note = "Playtest ejecutado en Play Solo · errores y Output capturados en tiempo real",
    })
  end

  -- 1) Avisar al servidor de que arranca
  httpPost(serverUrl .. "/plugin/playtest/start-result", {
    playtestId = playtestId,
    ready = true,
  })

  -- 2) Lanzar Play Solo con acceso a test local: durante `duration` segundos
  --    se ejecuta el juego como en Playtest y los errores/logs se capturan arriba.
  local ok, err = pcall(function()
    TestService:ExecuteWithLocalTestAccess(function()
      task.wait(duration)
    end)
  end)

  -- 3) Reportar (aunque haya fallado el pcall, los errores ya están capturados)
  task.delay(0.1, function()
    collectReport()
  end)
end

-- ═══════════════════════════════════════════════════════════════
--  BUCLE DE POLLING (el corazón del puente)
-- ═══════════════════════════════════════════════════════════════

local sleepStreak = 0   -- peticiones seguidas que fallan (servidor dormido)

local function pollOnce()
  local ok, body = httpGet(serverUrl .. "/plugin/poll")
  if not ok or not body then
    sleepStreak = sleepStreak + 1
    -- Si estábamos conectados y lleva 20+ s sin respuesta, marcar offline
    if connected and sleepStreak > 40 then
      connected = false
      setStatus("servidor inaccesible (¿dormido?)", false)
      notify("plugin_offline", "Plugin desconectado del servidor")
      sleepStreak = 0
    end
    return
  end
  sleepStreak = 0

  local ok2, data = pcall(HttpService.JSONDecode, HttpService, body)
  if not ok2 or not data then return end

  if not connected then
    connected = true
    notify("plugin_online", "Plugin conectado desde Studio")
    tools._index_all()   -- mandar el índice del lugar al conectar
  end

  if not data.command then return end   -- nada que hacer, volver a esperar

  local commandId = data.id
  local cmd  = data.command
  local args = data.data or {}

  local handler = tools[cmd]
  local result, errorMsg

  if cmd == "playtest_verify" then
    -- playtest es asíncrono: no devolver resultado por la vía normal
    task.spawn(runPlaytest, args)
    httpPost(serverUrl .. "/plugin/result", { id = commandId, result = { accepted = true, note = "Playtest iniciado" } })
    return
  elseif handler then
    local r, e = pcall(handler, args)
    if r then result = e
    else errorMsg = "Error interno del plugin: " .. tostring(e) end
  else
    errorMsg = "Comando desconocido: " .. tostring(cmd)
  end

  if errorMsg then
    httpPost(serverUrl .. "/plugin/result", { id = commandId, error = errorMsg })
  else
    httpPost(serverUrl .. "/plugin/result", { id = commandId, result = result })
  end
end

local function pollLoop()
  while pollRunning do
    local ok, e = pcall(pollOnce)
    if not ok and not tostring(e):find("refused", 1, true) then
      warn("[RBX-AI] poll error:", e)
    end
    task.wait(POLL_INTERVAL)
  end
end

-- ═══════════════════════════════════════════════════════════════
--  INTERFAZ (ventana "RBX-AI Bridge")
-- ═══════════════════════════════════════════════════════════════

local toolbar = plugin:CreateToolbar("RBX-AI Studio")
local button  = toolbar:CreateButton("RBX-AI Bridge", "Conecta con tu servidor de IA", "rbxasset://textures/ui/GuiImagePlaceholder.png")

local gui = plugin:CreateDockWidgetPluginGui("RBXAI_Bridge", DockWidgetPluginGuiInfo.new(
  Enum.InitialDockState.Right,   -- panel derecho
  false,                         -- no visible al inicio
  true,                          -- sí al cargar
  300, 380,                      -- tamaño inicial
  260, 320                       -- tamaño mínimo
))
gui.Title = "RBX-AI Studio — Bridge"

local frame = Instance.new("Frame")
frame.Size = UDim2.new(1, -16, 1, -16)
frame.Position = UDim2.new(0, 8, 0, 8)
frame.BackgroundColor3 = Color3.fromRGB(30, 32, 40)
frame.BorderSizePixel = 0
frame.Parent = gui

local layout = Instance.new("UIListLayout", frame)
layout.Padding = UDim.new(0, 8)
local pad = Instance.new("UIPadding", frame)
pad.PaddingTop = UDim.new(0, 10)
pad.PaddingLeft = UDim.new(0, 10)
pad.PaddingRight = UDim.new(0, 10)

local function label(text, parent, color, size)
  local l = Instance.new("TextLabel")
  l.Text = text
  l.Font = Enum.Font.Code
  l.TextSize = size or 13
  l.TextColor3 = color or Color3.fromRGB(220, 224, 232)
  l.BackgroundTransparency = 1
  l.Size = UDim2.new(1, 0, 0, 18)
  l.TextXAlignment = Enum.TextXAlignment.Left
  l.Parent = parent or frame
  return l
end

label("URL del servidor:", frame)

local urlBox = Instance.new("TextBox")
urlBox.Text = DEFAULT_URL
urlBox.Font = Enum.Font.Code
urlBox.TextSize = 13
urlBox.BackgroundColor3 = Color3.fromRGB(18, 20, 26)
urlBox.TextColor3 = Color3.fromRGB(230, 232, 240)
urlBox.PlaceholderText = "http://localhost:3000  ·  https://xxx.up.railway.app"
urlBox.Size = UDim2.new(1, 0, 0, 26)
urlBox.Parent = frame

local statusLabel = label("Estado: desconectado", frame, Color3.fromRGB(180, 184, 196))

local connectBtn = Instance.new("TextButton")
connectBtn.Text = "Conectar"
connectBtn.Font = Enum.Font.GothamBold
connectBtn.TextSize = 13
connectBtn.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
connectBtn.TextColor3 = Color3.new(1, 1, 1)
connectBtn.Size = UDim2.new(1, 0, 0, 30)
connectBtn.Parent = frame

local note = label("Pega la URL de tu servidor (local, Railway o Colab) y pulsa Conectar. Studio te pedirá permiso para HTTP y edición de scripts: acepta ambos.", frame, Color3.fromRGB(140, 146, 160), 11)
note.TextWrapped = true
note.TextYAlignment = Enum.TextYAlignment.Top
note.Size = UDim2.new(1, 0, 0, 70)

local function setStatus(text, good)
  statusLabel.Text = "Estado: " .. text
  statusLabel.TextColor3 = good and Color3.fromRGB(120, 220, 160) or Color3.fromRGB(230, 130, 130)
end

local function startPolling()
  if pollRunning then return end
  pollRunning = true
  task.spawn(pollLoop)
end

local function stopPolling()
  pollRunning = false
  connected = false
  setStatus("desconectado", false)
end

-- El servidor (Railway/Colab) puede tardar hasta 30 s en "despertar" si está dormido.
-- Al pulsar Conectar reintentamos el ping varias veces antes de rendirnos.
local function tryConnect(attempts)
  for i = 1, (attempts or 6) do
    if i > 1 then
      setStatus("despertando el servidor (" .. i .. "/6)…", false)
      task.wait(5)   -- dar tiempo a que el servidor despierte
    end
    local ok, body = httpGet(serverUrl .. "/plugin/poll")
    if ok and body then
      setStatus("conectado", true)
      connected = true
      notify("plugin_online", "Plugin conectado desde Studio")
      local ok2, data = pcall(HttpService.JSONDecode, HttpService, body)
      if ok2 and data and not data.command then
        tools._index_all()   -- mandar el índice del lugar al conectar
      end
      return true
    end
  end
  setStatus("no se puede alcanzar el servidor — pulsa de nuevo", false)
  connected = false
  return false
end

connectBtn.MouseButton1Click:Connect(function()
  local url = urlBox.Text:match("^%s*(.-)%s*$")
  if url == "" then
    setStatus("URL vacía", false)
    return
  end
  stopPolling()
  serverUrl = url:gsub("/+$", "")   -- quitar barras finales
  local attempts = url:find("railway.app", 1, true) or url:find("ngrok", 1, true) or url:find("trycloudflare", 1, true)
    and 6 or 2   -- servidores en la nube duermen: reintentar hasta 6 veces (~25 s)
  setStatus("conectando…", false)
  tryConnect(attempts)
end)

button.Click:Connect(function()
  gui.Enabled = not gui.Enabled
end)

-- Arrancar el polling por defecto (en local no hace daño: reintenta cada 0.5s)
startPolling()

print("[RBX-AI Bridge] Plugin cargado. Abre la ventana 'RBX-AI Bridge' para conectar con tu servidor.")
