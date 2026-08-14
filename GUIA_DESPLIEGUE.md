# Guía de despliegue — RBX-AI Studio v4 (100% gratis, uso personal)

Este proyecto ya está listo para subirse a GitHub y desplegarse gratis. El servidor usa **`process.env.PORT`** (Railway lo inyecta solo), `railway.toml` ya está configurado y no hay nada más que tocar. El plan de desarrollo del juego es personal y privado.

## Opción A — Railway (recomendada)

Railway es la opción más cómoda: subes el repo a GitHub, Railway hace el despliegue automático y te da una URL `https://algo.up.railway.app` con HTTPS gratis.

**Paso 1 — Sube el repo a GitHub.**
Crea un repo (público o privado, da igual, es tu herramienta personal) y sube los archivos:

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
2. **New Project → Deploy from GitHub repo** → elige tu repo.
3. Railway detecta Node.js solo, construye con `npm install` y arranca con `node server.js` (definido en `railway.toml`).

**Paso 3 — Añade la variable de entorno.**

En el servicio → **Variables**:

| Variable | Valor |
|---|---|
| `OPENROUTER_API_KEY` | Tu clave de https://openrouter.ai/keys (gratis, 50 req/día) |
| `PUBLIC_URL` *(opcional)* | La URL que Railway te dio: `https://tu-proyecto.up.railway.app` |

**Paso 4 — Conecta el plugin de Roblox Studio.**

1. Abre la URL de Railway en tu navegador.
2. En Studio, abre el plugin conector y pega la URL de Railway como servidor (en lugar de `http://localhost:3000`).
3. El plugin hace polling a `https://.../plugin/poll` — funciona igual que en local.

**Limitación del plan gratuito:** Railway duerme el servicio tras 15 min sin tráfico y usa 500 h/mes. Para una herramienta personal no es problema: cuando el plugin detecte que no hay respuesta, te pedirá recargar; el chat sigue conectado y puedes pedirle a Railway que despierte el servicio entrando a la URL. Si quieres cero esperas sin pagar, usa la Opción B o el truco de abajo.

**Truco para mantenerlo despierto gratis:** crea un servicio gratuito de uptime en [cron-job.org](https://cron-job.org) que haga una petición a `https://tu-url.up.railway.app/plugin/status` cada 20 min. Eso mantiene el servicio activo dentro de las 500 h.

## Opción B — Google Colab (gratuito, sin dormir mientras la pestaña esté abierta)

Sí, **se puede montar el mismo servidor en Google Colab**. Ventajas: es totalmente gratis con tu cuenta de Google y no se duerme mientras mantengas la sesión activa. Desventajas: hay que re-arrancar manualmente cuando se cierra la sesión (duración máx ~12 h por sesión en plan gratuito) y la URL cambia cada vez.

He incluido un notebook listo: **`colab_server.ipynb`** en el repo. Cómo usarlo:

1. Sube el repo a GitHub.
2. Abre [colab.research.google.com](https://colab.research.google.com) → **File → Open notebook → GitHub** → pega la URL de tu repo y elige `colab_server.ipynb`.
3. Haz clic en **Connect** (arriba a la derecha) y luego en ▶ sobre la primera celda. La celda:
   - Clona/lee tus archivos
   - Te pide tu `OPENROUTER_API_KEY` (se guarda solo en la sesión, no en ningún lado)
   - Monta el servidor en el puerto 8080 y crea un **túnel Cloudflare gratis** (sin registro de ngrok)
   - Imprime la URL pública tipo `https://algo-trycloudflare.com`
4. Abre esa URL en tu navegador y conecta el plugin de Studio apuntando a esa URL con HTTPS.

**Flujo recomendado personal:** Colab cuando trabajas intensamente varias horas seguidas (0 coste, URL instantánea), Railway cuando quieres algo fijo que sobrevive a cierres del navegador (URL permanente, sin arrancar nada). Puedes usar ambos con el mismo plugin, solo cambia la URL del servidor.

## Cómo funciona el playtest en vivo (lo nuevo)

El servidor ya tiene el endpoint completo `playtest_verify` y la herramienta expuesta a la IA. El protocolo, que tu plugin debe implementar (igual que hace el plugin público de Pisces):

| Endpoint | Quién lo llama | Qué hace |
|---|---|---|
| `POST /chat` con tool `playtest_verify` | Servidor → plugin (vía `/plugin/poll`) | Pide lanzar Play Solo con un `goal`, `actions` y `duration` |
| `POST /plugin/playtest/start-result` | Plugin → servidor | Confirma que el playtest arrancó (o reporta error) |
| `POST /plugin/playtest/report` | Plugin → servidor | Devuelve `{playtestId, report}` con errores de runtime (`ScriptContext.Error`), logs del Output (`LogService.MessageOut`) y eventos observados |

Con eso la IA lanza el playtest, lee el reporte, corrige el bug y vuelve a probar (hasta 2-3 iteraciones), tal como hace Pisces. El lado del servidor ya está hecho y probado; solo falta añadir los 3 endpoints al plugin de Studio cuando quieras implementarlo.

## Checklist rápido

- [ ] Subir repo a GitHub
- [ ] Railway: crear servicio desde GitHub + variable `OPENROUTER_API_KEY`
- [ ] O Colab: abrir `colab_server.ipynb` y ejecutar
- [ ] Conectar el plugin de Studio a la URL pública
- [ ] Probar un mensaje personalizado → debe responder con streaming
