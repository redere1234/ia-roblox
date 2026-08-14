# Guía de despliegue — RBX-AI Studio v4 (100% gratis, uso personal)

Este proyecto ya está listo para subirse a GitHub y desplegarse gratis. El servidor usa **`process.env.PORT`** (Railway lo inyecta solo), `railway.toml` ya está configurado y no hay nada más que tocar. El plan de desarrollo del juego es personal y privado.

## Opción A — Railway (recomendada)

Railway es la opción más cómoda: subes el repo a GitHub, Railway hace el despliegue automático y te da una URL `https://algo.up.railway.app` con HTTPS gratis.

**Paso 1 — Sube el repo a GitHub.**Crea un repo (público o privado, da igual, es tu herramienta personal ) y sube los archivos:

```bash
cd "IA programacion roblox studio"
git init
git add -A
git commit -m "RBX-AI Studio v4"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

**Paso 2 — Crea el servicio en Railway.**

1. Ve a [railway.com](https://railway.com) e inicia sesión con GitHub (plan gratuito, 500 horas/mes).

1. **New Project → Deploy from GitHub repo** → elige tu repo.

1. Railway detecta Node.js solo, construye con `npm install` y arranca con `node server.js` (definido en `railway.toml`).

**Paso 3 — Añade la variable de entorno.**

En el servicio → **Variables**:

| Variable | Valor |
| --- | --- |
| `OPENROUTER_API_KEY` | Tu clave de [https://openrouter.ai/keys](https://openrouter.ai/keys) (gratis, 50 req/día ) |
| `PUBLIC_URL` *(opcional)* | La URL que Railway te dio: `https://tu-proyecto.up.railway.app` |

**Paso 4 — Conecta el plugin de Roblox Studio.**

1. Abre la URL de Railway en tu navegador.

1. En Studio, abre el plugin conector y pega la URL de Railway como servidor (en lugar de `http://localhost:3000` ).

1. El plugin hace polling a `https://.../plugin/poll` — funciona igual que en local.

**Limitación del plan gratuito:** Railway duerme el servicio tras 15 min sin tráfico y usa 500 h/mes. Para una herramienta personal no es problema: cuando el plugin detecte que no hay respuesta, te pedirá recargar; el chat sigue conectado y puedes pedirle a Railway que despierte el servicio entrando a la URL. Si quieres cero esperas sin pagar, usa la Opción B o el truco de abajo.

**Truco para mantenerlo despierto gratis:** crea un servicio gratuito de uptime en [cron-job.org](https://cron-job.org) que haga una petición a `https://tu-url.up.railway.app/plugin/status` cada 20 min. Eso mantiene el servicio activo dentro de las 500 h.

## Opción B — Google Colab (gratuito, sin dormir mientras la pestaña esté abierta )

Sí, **se puede montar el mismo servidor en Google Colab**. Ventajas: es totalmente gratis con tu cuenta de Google y no se duerme mientras mantengas la sesión activa. Desventajas: hay que re-arrancar manualmente cuando se cierra la sesión (duración máx ~12 h por sesión en plan gratuito) y la URL cambia cada vez.

He incluido un notebook listo: **`colab_server.ipynb`** en el repo. Cómo usarlo:

1. Sube el repo a GitHub.

1. Abre [colab.research.google.com](https://colab.research.google.com) → **File → Open notebook → GitHub** → pega la URL de tu repo y elige `colab_server.ipynb`.

1. **Requisito único (la primera vez):** crea una cuenta gratis en [ngrok.com](https://dashboard.ngrok.com/signup) y copia tu authtoken de [esta página](https://dashboard.ngrok.com/get-started/your-authtoken) (botón "Your Authtoken").

1. Haz clic en **Connect** (arriba a la derecha) y luego en ▶ sobre la primera celda. La celda:
  - Te pide tu **authtoken de ngrok** (con `prompt`, solo vive en la sesión)
  - Clona/lee tus archivos
  - Te pide tu `OPENROUTER_API_KEY` (se guarda solo en la sesión, no en ningún lado)
  - Instala ngrok, registra el token, arranca el servidor en el puerto 8080 (escuchando en `0.0.0.0`) y crea el túnel público
  - Verifica con polling hasta que la URL responde 200 y te la imprime

1. **Abre la URL en una pestaña NUEVA del navegador** (no dentro de Colab) y pégala en la ventana **RBX-AI Bridge** del plugin en Roblox Studio. La URL es tipo `https://XXXX.ngrok-free.app` — sin pantallas intermedias.

**Ventajas de ngrok frente a los quick tunnels de Cloudflare:** URLs estables que no dan 502 por conflictos de IPv6/IPv4, sin página de "allow", log limpio que el notebook lee automáticamente, y el plan gratuito da 3 túneles simultáneos y 10 GB de tráfico al mes — más que de sobra para uso personal. Única pega: el aviso inicial de ngrok en el navegador se salta con un clic en "Click here to continue".

**Flujo recomendado personal:** Colab cuando trabajas intensamente varias horas seguidas (0 coste, URL instantánea ), Railway cuando quieres algo fijo que sobrevive a cierres del navegador (URL permanente, sin arrancar nada). Puedes usar ambos con el mismo plugin, solo cambia la URL del servidor.

## Cómo funciona el playtest en vivo (lo nuevo)

El servidor ya tiene el endpoint completo `playtest_verify` y la herramienta expuesta a la IA. El protocolo, que tu plugin debe implementar (igual que hace el plugin público de Pisces):

| Endpoint | Quién lo llama | Qué hace |
| --- | --- | --- |
| `POST /chat` con tool `playtest_verify` | Servidor → plugin (vía `/plugin/poll`) | Pide lanzar Play Solo con un `goal`, `actions` y `duration` |
| `POST /plugin/playtest/start-result` | Plugin → servidor | Confirma que el playtest arrancó (o reporta error) |
| `POST /plugin/playtest/report` | Plugin → servidor | Devuelve `{playtestId, report}` con errores de runtime (`ScriptContext.Error`), logs del Output (`LogService.MessageOut`) y eventos observados |

Con eso la IA lanza el playtest, lee el reporte, corrige el bug y vuelve a probar (hasta 2-3 iteraciones), tal como hace Pisces. El lado del servidor ya está hecho y probado; solo falta añadir los 3 endpoints al plugin de Studio cuando quieras implementarlo.

## El plugin de Roblox Studio (`rbxai_plugin.lua`) — incluido

Ya viene en el repo y está probado sintácticamente. Es el puente que conecta tu Studio con el servidor, cualquiera que sea (local, Railway o Colab): solo cambia la URL en la ventana del plugin.

**Cómo instalarlo (30 segundos):**

1. En Roblox Studio: **Plugins → Advanced → New Plugin**.
2. Borra el código de ejemplo y pega el contenido de `rbxai_plugin.lua`.
3. Pulsa **Run** (el plugin se guarda automáticamente en tu cuenta).
4. Aparece la ventana **RBX-AI Bridge** a la derecha: pega la URL de tu servidor y pulsa **Conectar**.
5. Studio te pedirá permiso para **peticiones HTTP** y **edición de scripts** → acepta ambos.

**Qué hace el plugin:**

| Función | Descripción |
|---|---|
| Polling | Consulta `/plugin/poll` cada 0.5s y ejecuta los comandos del servidor |
| Indexar | Al conectar, envía el árbol completo del lugar (servicios, scripts, remotes, carpetas) y tras cada edición |
| Scripts | `list_scripts`, `read_script`, `write_script`, `create_script`, `delete_script` |
| Grep | `search_in_scripts` — busca texto en todo el codebase con número de línea |
| Errores | Captura en vivo `ScriptContext.Error` y el Output de Studio (`get_errors`) |
| **Playtest** | `playtest_verify` — lanza Play Solo, espera la duración indicada, captura errores/runtime y reporta al servidor para que la IA corrija en bucle |
| Undo | Cada edición crea un waypoint de `ChangeHistoryService` — Ctrl+Z funciona en Studio |

**Seguridad (igual que Pisces):** no hay `loadstring`, no hay `require` remoto, no hay telemetría. Solo habla con la URL que tú configures. Al desconectar, el polling se detiene en menos de 1 segundo.

## Checklist rápido

- [ ] Subir repo a GitHub

- [ ] Railway: crear servicio desde GitHub + variable `OPENROUTER_API_KEY`

- [ ] O Colab: abrir `colab_server.ipynb` y ejecutar

- [ ] Instalar `rbxai_plugin.lua` en Studio (Plugins → Advanced → New Plugin)

- [ ] Conectar el plugin a la URL pública (local, Railway o Colab)

- [ ] Probar un mensaje personalizado → debe responder con streaming

- [ ] Probar playtest: pide "verifica en vivo que el sistema de coins funciona"

