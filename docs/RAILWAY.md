# Guía de despliegue en Railway (manual)

Esta guía es para que una persona haga el despliegue. Nada en el repositorio despliega solo.

## 1. Servicios

1. **PostgreSQL con pgvector**: crear un servicio desde la imagen Docker `pgvector/pgvector:pg18`
   (el Postgres estándar de Railway puede no traer la extensión `vector`). Agregarle un volumen en
   `/var/lib/postgresql` y definir `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
2. **App**: servicio desde este repositorio; Railway detecta el `Dockerfile` de la raíz.
   - Volumen persistente montado en `/data` (fotos y videos). Sin volumen, se pierden en cada deploy.
   - Una sola réplica: Baileys no admite dos procesos con la misma sesión de WhatsApp.

## 2. Variables de la App

| Variable | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | la que asigna Railway (`${{PORT}}`) |
| `TRUST_PROXY` | `true` (Railway está detrás de un proxy) |
| `PUBLIC_URL` | URL pública del servicio (`https://…up.railway.app` o dominio propio) |
| `DATABASE_URL` | `postgresql://USUARIO:CLAVE@HOST_INTERNO:5432/BASE` del servicio de Postgres |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` — guardarla aparte: sin ella hay que volver a vincular WhatsApp |
| `WHATSAPP_ENABLED` | `true` |
| `OPENAI_API_KEY` | clave de OpenAI |
| `OPENAI_MODEL` | `gpt-5-mini` (u otro) |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` (no cambiar después de importar chats: cambia la dimensión/espacio de los vectores) |
| `MEDIA_DIR` | `/data/media` |
| `MEDIA_MAX_IMAGE_MB` / `MEDIA_MAX_VIDEO_MB` | `10` / `16` (WhatsApp limita videos a 16 MB) |
| `IMPORT_MAX_MB` | `200` |

## 3. Primer arranque

1. El contenedor aplica las migraciones al iniciar (`prisma migrate deploy`), incluida `CREATE EXTENSION vector`.
2. Desde la consola del servicio (Railway → App → Shell):
   ```bash
   cd apps/server && node dist/cli.js seed
   node dist/cli.js user:create --email duena@ejemplo.com --name "Nombre" --role admin
   ```
3. Entrar a `PUBLIC_URL`, iniciar sesión, ir a **WhatsApp** y escanear el QR con el teléfono del negocio.
4. Verificar `GET /health` → `{"ok":true,"whatsapp":"CONNECTED"}`.

## 4. Antes de dar de alta

- Cargar catálogo, servicios, datos del negocio y la configuración de IA desde el panel.
- Importar chats reales y aprobar el conocimiento.
- Probar con un número propio: consulta de producto, pedido de fotos, mayorista, evento y "quiero hablar con una persona".

## 5. Respaldo

- Postgres: backups del volumen o `pg_dump` periódico.
- Fotos/videos: copiar el volumen `/data/media`.
