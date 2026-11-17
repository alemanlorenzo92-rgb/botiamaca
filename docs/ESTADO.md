# Estado del proyecto y cómo continuar

Vendedora virtual por WhatsApp para **Male Style** (Río Cuarto, Córdoba): glitter, maquillaje artístico y
servicios para eventos (Glitter Bar y Shimmer Walls). La opera **una sola persona, la dueña**: no hay vendedores
ni ayudantes. Todo lo del negocio se carga desde el panel (base de datos), no en el código.

Restricciones fijas:
- Proyecto independiente: no tiene relación con el CRM de Render Byte.
- **No se usa Tiendanube.** El catálogo (productos, precios, stock, servicios) es propio y lo administra la dueña en el panel.
- La IA nunca inventa precios, stock, mínimos mayoristas, envíos, horarios, medios de pago ni condiciones: si el dato no está cargado, lo dice y ofrece a la dueña.
- El bloqueo de respuestas automáticas cuando atiende la dueña lo hace el backend, no el prompt.
- Los pedidos quedan "a revisar": el bot no cobra ni confirma pagos.
- No se entrena ni ajusta ningún modelo: el aprendizaje es conocimiento revisado por la dueña + recuperación (RAG).
- El despliegue (Railway u otro) lo hace una persona siguiendo `docs/RAILWAY.md`; nada se despliega automáticamente.

## Stack

- pnpm workspaces, Node 22, TypeScript (ESM).
- `apps/server`: Fastify 5 + Prisma 6 + PostgreSQL 18 con **pgvector** (imagen `pgvector/pgvector:pg18`). Un solo proceso (Baileys exige una única instancia).
- `apps/panel`: Next.js con export estático, servido por el mismo servidor (1 contenedor + Postgres).
- WhatsApp: Baileys `7.0.0-rc14` (no oficial), credenciales cifradas AES-256-GCM en `wa_auth_keys`. Envía texto, fotos y videos.
- IA: OpenAI Responses API con herramientas; embeddings `text-embedding-3-small` (1536 dimensiones).
- Colas durables en Postgres: respuestas (`messages.ai_handled_at`) y trabajos de fondo (`jobs`, `FOR UPDATE SKIP LOCKED`).
- Archivos (fotos/videos) en disco local (`MEDIA_DIR`), detrás de la interfaz `MediaStorage` (se puede cambiar por S3 sin tocar el resto).

## Correr localmente

```bash
cp .env.example .env            # completar ENCRYPTION_KEY con: openssl rand -base64 32
pnpm install
pnpm db:up                      # Postgres + pgvector en Docker, puerto 5433
pnpm db:migrate
pnpm db:seed                    # rol admin, ai_settings, listas de precio, Glitter Bar y Shimmer Walls vacíos
pnpm --filter @bot/server cli user:create --email duena@ejemplo.com --name "Nombre" --role admin
pnpm dev                        # API en :3000 y panel en :3001 (http://localhost:3001)
```

- Con `WHATSAPP_ENABLED=false` arranca sin WhatsApp. Sin `OPENAI_API_KEY` la IA no responde ni extrae conocimiento
  (la búsqueda de conocimiento usa un embedder local de palabras, de menor calidad).
- Si venías de la imagen `postgres:18`, el volumen sirve igual; si Prisma se queja de "collation version", correr
  `ALTER DATABASE <base> REFRESH COLLATION VERSION;` en `template1`, `postgres`, `bot` y `bot_test`.
- Tests: `pnpm test` (necesita el Postgres de `pnpm db:up`; usa la base `bot_test`, o `TEST_DATABASE_URL`).
- Producción con Docker: `docker compose --profile prod up -d --build` (aplica migraciones al arrancar).

## Cómo funciona

**Catálogo propio** (`src/catalog`, panel → Catálogo): productos con descripción, características, uso,
recomendaciones, preguntas frecuentes, etiquetas, categorías y variantes. Precio minorista, mayorista y stock son
opcionales por variante: vacío = "sin dato cargado" y la IA lo dice así. Cambiar un precio cierra el anterior
(`valid_to`), queda el historial. Servicios (`service_info`): descripción, condiciones y preguntas frecuentes de
Glitter Bar y Shimmer Walls; sin descripción la IA informa que no hay datos y registra el pedido de presupuesto.

**Fotos, videos y tutoriales** (`src/media`, panel → Fotos y videos): se valida el contenido real del archivo
(JPG, PNG, WEBP, MP4, 3GP) y el tamaño; se deduplica por SHA-256; se asocia a producto, categoría o servicio. La IA
solo envía archivos activos (`search_media` → `send_image`/`send_video`, máximo 3 por respuesta), vuelve a chequear
que la conversación siga con la IA y que WhatsApp esté conectado, reintenta una vez y registra el envío fallido.

**Aprendizaje de chats** (`src/knowledge`, panel → Conocimiento):
1. La dueña exporta un chat desde WhatsApp (TXT o ZIP con adjuntos) y lo sube. Baileys no trae el historial
   completo de forma confiable, por eso se usa el export.
2. Vista previa: elige cuál participante es ella y confirma el permiso. Los nombres pasan a "Dueña"/"Cliente N";
   teléfonos, emails, CBU/alias y documentos se reemplazan antes de guardar.
3. Idempotente: el mismo archivo no se importa dos veces y los mensajes repetidos entre exports solapados se saltean.
   Los medios del chat entran **desactivados** a la biblioteca hasta que la dueña los revise.
4. Un trabajo de fondo manda el chat por partes a OpenAI, que propone conocimiento (tono, preguntas frecuentes,
   productos, servicios, políticas, objeciones, proceso de venta), con fragmento de origen, confianza y marca de
   "dato que puede cambiar". Lo repetido suma fuentes y confianza; lo que contradice algo existente queda "En conflicto";
   lo rechazado no se vuelve a proponer. También se guardan intercambios cliente → dueña como ejemplos de tono.
5. Todo entra "Para revisar". La dueña aprueba, edita (queda versión y el texto anterior), rechaza o desactiva.
   Aprobar algo en conflicto desactiva la versión anterior. Borrar una importación borra sus mensajes, medios y
   el conocimiento que solo salía de ella.
6. En cada respuesta se buscan con pgvector solo los conocimientos aprobados y los ejemplos más parecidos a lo que
   preguntó el cliente; en `ai_runs.tool_calls` queda registrado (`rag`) qué se usó.

**Atención de la dueña**: estados `AI_ACTIVE`, `HUMAN_REQUESTED`, `HUMAN_ACTIVE`, `AI_PAUSED`, `RESOLVED`. Mientras
atiende ella, el backend no deja salir respuestas automáticas (ni fotos).

**Panel**: Inicio (pendientes y alertas), Bandeja, Contactos, Catálogo, Fotos y videos, Conocimiento, Pedidos,
Eventos, Seguimientos, Configuración, WhatsApp y Auditoría. En celular el menú se abre con ☰.

## Hecho

- Bandeja, derivación, guardia de respuestas, seguimientos, pedidos a revisar, leads de eventos, auditoría, SSE.
- Catálogo propio, servicios, biblioteca multimedia, tutoriales y envío de medios por WhatsApp.
- Importación de chats, extracción de conocimiento, duplicados, conflictos, revisión y RAG con pgvector.
- Tests (`apps/server/test`): escenarios de venta, casos de borde, API del panel, biblioteca, envío de medios
  (reintento, archivo faltante, tipo incorrecto, conversación tomada, WhatsApp caído, límite), catálogo sin precio/stock,
  parser Android/iOS, anonimización, importación TXT/ZIP, exports solapados, extracción, conflictos, aprobación,
  trazabilidad y error de OpenAI.

## Límites conocidos (no verificados con servicios reales)

- No se probó con OpenAI real (las pruebas usan un modelo simulado) ni con un WhatsApp real vinculado:
  el envío de fotos/videos por Baileys está implementado pero no se verificó contra WhatsApp.
- El parser cubre los formatos de export de Android e iOS en español e inglés con fecha día/mes; otros formatos
  regionales pueden necesitar ajustes.
- Audios entrantes: no se transcriben (la IA ve "[Envió un audio]").
- El rol "Vendedor/a" sigue existiendo en el código (permisos), pero no se usa: la operación es solo de la dueña.

## Pendiente

1. Cargar `OPENAI_API_KEY` y probar con un número de WhatsApp de prueba.
2. Cargar catálogo, servicios y datos del negocio desde el panel; importar chats reales y revisar lo aprendido.
3. Desplegar siguiendo `docs/RAILWAY.md` (con volumen persistente para `MEDIA_DIR`).

## Credenciales que van a hacer falta (no commitear)

- `OPENAI_API_KEY`
- `ENCRYPTION_KEY` (generada con `openssl rand -base64 32`; si se pierde, hay que volver a vincular WhatsApp).
- Un número de WhatsApp para vincular por QR.
