# Guía de puesta en marcha — Male Style AI

Pasos para dejar el bot funcionando con credenciales reales. Nada se despliega solo: el despliegue lo hace una
persona (ver `docs/RAILWAY.md`).

## 1. Variables de entorno

| Variable | Obligatoria | Qué poner |
| --- | --- | --- |
| `DATABASE_URL` | sí | Postgres 18 **con pgvector** (`pgvector/pgvector:pg18`) |
| `ENCRYPTION_KEY` | sí | `openssl rand -base64 32`. Guardarla aparte: si se pierde hay que volver a vincular WhatsApp |
| `OPENAI_API_KEY` | sí | Clave de un proyecto de OpenAI con límite de gasto. Nunca en el repo: variable del servidor |
| `OPENAI_MODEL` | no | `gpt-5-mini` (por defecto). También se cambia desde Configuración → IA |
| `OPENAI_EMBEDDING_MODEL` | no | `text-embedding-3-small`. No cambiarlo después de importar chats |
| `OPENAI_MAX_OUTPUT_TOKENS` / `OPENAI_TIMEOUT_MS` | no | `800` / `30000` |
| `WHATSAPP_ENABLED` | no | `true` en producción; `false` para probar sin WhatsApp |
| `PUBLIC_URL`, `PORT`, `TRUST_PROXY` | no | URL pública; `TRUST_PROXY=true` solo detrás de un proxy |
| `MEDIA_DIR` | no | Carpeta persistente de fotos y videos (`/data/media` en Docker) |
| `MEDIA_MAX_IMAGE_MB` / `MEDIA_MAX_VIDEO_MB` / `IMPORT_MAX_MB` | no | `10` / `16` / `200` |

Control de costos: en Configuración → IA se definen el presupuesto diario de tokens y el máximo de respuestas por
hora por conversación; cada corrida queda en Auditoría → IA (tokens, latencia, herramientas usadas, errores).

## 2. Primer arranque

```bash
pnpm install && pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm --filter @bot/server cli user:create --email duena@ejemplo.com --name "Nombre" --role admin
pnpm dev     # o en producción: docker compose --profile prod up -d --build
```

## 3. Verificar OpenAI (antes de conectar WhatsApp)

Con una base de **prueba** distinta de la real:

```bash
docker exec botiamaca-postgres-1 psql -U bot -d postgres -c "CREATE DATABASE bot_smoke"
SMOKE_DATABASE_URL=postgresql://bot:bot_local_password@localhost:5433/bot_smoke \
OPENAI_API_KEY=sk-... pnpm --filter @bot/server smoke:openai
```

Recorre importar un chat → anonimizar → extraer con OpenAI → aprobar → recuperar con embeddings → responder →
no inventar un precio sin cargar → frenar la IA cuando toma la dueña → derivar ante un error de la API. Termina con
`N/N pasos OK`; si algo falla, muestra el paso y el error.

## 4. Cargar el negocio

1. Configuración: datos del negocio (envíos, pagos, horarios, mayorista), personalidad, saludo y mensajes.
2. Catálogo: productos, categorías, variantes; precio y stock solo si se conocen. Servicios: Glitter Bar y Shimmer Walls.
3. Fotos y videos: subir y activar; tutoriales.
4. Conocimiento: importar chats exportados de WhatsApp (TXT o ZIP), revisar y aprobar lo propuesto.

## 5. Conectar WhatsApp

1. Usar primero un **número de prueba**, no el del negocio.
2. Panel → WhatsApp → escanear el QR desde WhatsApp → Dispositivos vinculados.
3. Escribir desde otro teléfono y revisar en la Bandeja la respuesta; probar "Tomar" y "Devolver a la IA".
4. Recién después vincular el número real.

**Riesgos de Baileys** (librería no oficial que emula WhatsApp Web): WhatsApp puede cerrar la sesión o bloquear el
número si detecta uso automatizado o muchos mensajes a desconocidos; los cambios de WhatsApp pueden romperla hasta
que se actualice la librería; se necesita una sola instancia del servidor. El bot solo responde a quien escribe
primero y limita respuestas por hora. Si la sesión se cierra, el panel muestra el estado y hay que volver a escanear.
La alternativa estable es la API oficial de WhatsApp Business (requiere cuenta de Meta y plantillas aprobadas).

## 6. Backups

`DATABASE_URL=... MEDIA_DIR=/data/media ./scripts/backup.sh /ruta/backups` — guarda la base (pg_dump) y las fotos.
Programarlo a diario (cron) y copiar el resultado fuera del servidor. Restaurar: ver el encabezado del script.
