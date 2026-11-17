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
- Tests: `pnpm test` (45 tests; necesita el Postgres de `pnpm db:up`; usa la base `bot_test`, o `TEST_DATABASE_URL`).
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
   teléfonos, emails, CBU/alias, documentos, usuarios (@…), direcciones (calle y número, piso/depto, barrio, código
   postal) y nombres de terceros en contextos típicos ("mi hija Sofía", "de parte de Laura", "Hola Marta") se
   reemplazan antes de guardar y de mandar nada a OpenAI (`src/knowledge/anonymize.ts`). Es por reglas: un nombre
   suelto sin contexto puede pasar; por eso además el prompt de extracción descarta datos personales.
3. Idempotente: el mismo archivo no se importa dos veces y los mensajes repetidos entre exports solapados se saltean.
   **Exports solapados y borrado:** si se importan dos exports del mismo chat con partes en común, la parte común queda
   guardada solo en la primera importación. Si después se borra esa primera, la segunda pierde ese tramo. Para
   corregirlo: borrar las importaciones de ese chat y volver a importar solo el export más completo (el más reciente).
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

## Integrado en `main`

- PR #1 (bot vendedor, IA con herramientas, servidor, panel, tests, Docker) y PR #2 (catálogo propio, biblioteca
  multimedia, aprendizaje de chats con RAG) están mergeados.
- Después: toma de la dueña y envío de la IA bloquean la misma fila (`SELECT … FOR UPDATE`), así que no pueden responder
  las dos a la vez; se quitó el rol de vendedor (una sola administradora); 2 reintentos ante errores de OpenAI;
  `pnpm --filter @bot/server smoke:openai` (prueba real de punta a punta); `scripts/backup.sh`.

## Funciona (verificado con tests contra Postgres real, OpenAI y WhatsApp simulados)

- Bandeja, derivación, guardia de respuestas (interruptor general, estado, límite por hora, presupuesto de tokens),
  seguimientos, pedidos a revisar, leads de eventos, auditoría y trazabilidad de la IA (`ai_runs`), SSE.
- Catálogo propio, servicios, biblioteca multimedia, tutoriales y envío de medios.
- Importación de chats, anonimización, deduplicación, extracción, duplicados, contradicciones, revisión y RAG.
- Mensajes entrantes repetidos se descartan por `externalId`; reconexión de WhatsApp con espera creciente; respuestas
  pendientes se retoman al reconectar.

## Aprender del historial al vincular WhatsApp

Al vincular un número, WhatsApp le manda al bot el historial reciente (`syncFullHistory: true` corta la conexión con error 428 antes del QR en esta versión de Baileys). Para chats más viejos, exportarlos desde el celular e importarlos en Conocimiento. El bot no le responde a nadie de
ese historial: toma los chats de a dos con al menos 4 mensajes de texto en los que respondió la dueña (hasta 5000
mensajes por chat, sin contactos silenciados), los anonimiza igual que un export y los manda a extraer conocimiento.
El conocimiento queda pendiente hasta que la dueña lo aprueba. Volver a vincular no duplica mensajes.

## Verificado con OpenAI real

`smoke:openai` pasó 10/10 con una API key real, sobre una base de prueba: importar y anonimizar un chat, extraer
conocimiento, aprobarlo, recuperarlo con embeddings reales, responder con un dato cargado en el panel (mínimo
mayorista), no inventar un precio sin cargar, registrar tokens y latencia en `ai_runs`, frenar la IA cuando toma la
dueña y derivar ante un error de la API. Una respuesta típica consumió unos 9.000 tokens de entrada y 300 de salida, y
tardó unos 8 segundos.

## Verificado con WhatsApp real (número de prueba)

Con el bot corriendo localmente y un número de prueba vinculado por QR: saludo, consulta de precio sin catálogo
cargado (no inventa), Shimmer Wall sin precio (deriva a la dueña), pedido de hablar con la dueña, tomar la
conversación desde el panel, responder, devolverla a la IA y que la dueña escriba desde el celular (la IA se corre).

En esa prueba el bot les respondió a contactos personales del celular. Por eso cada contacto tiene ahora el interruptor
"El bot no le responde nunca" (Contactos y Bandeja), que se controla en el backend (`ReplyGuard`).

## Falta probar (necesita credenciales)

- **WhatsApp real:** envío de fotos y videos de la biblioteca, reconexión tras un corte y el número de Male Style.

## Límites conocidos

- El parser cubre exports de Android e iOS en español e inglés con fecha día/mes.
- Audios entrantes: no se transcriben (la IA ve "[Envió un audio]").
- Baileys no es oficial: ver riesgos en `docs/GUIA_PUESTA_EN_MARCHA.md`.

## Próximos pasos (externos)

1. Cargar `OPENAI_API_KEY` y correr `smoke:openai`.
2. Vincular un número de WhatsApp de prueba y después el real.
3. Cargar catálogo, servicios y datos del negocio; importar chats reales y aprobar el conocimiento.
4. Desplegar siguiendo `docs/RAILWAY.md` (con volumen para `MEDIA_DIR`) y programar `scripts/backup.sh`.

## Credenciales que van a hacer falta (no commitear)

- `OPENAI_API_KEY`
- `ENCRYPTION_KEY` (generada con `openssl rand -base64 32`; si se pierde, hay que volver a vincular WhatsApp).
- Un número de WhatsApp para vincular por QR.
