# Estado del proyecto y cómo continuar

Bot vendedor para WhatsApp, reutilizable como plantilla. Primer cliente: Male Style
(Río Cuarto, Córdoba). Todo lo específico del negocio va en configuración (base de datos /
variables), no en el código.

Restricciones fijas:
- Proyecto independiente: no tiene relación con el CRM de Render Byte.
- No se hostea en el Railway de la empresa. Hosting a definir; el proyecto queda listo para Docker.
- Precios, stock y variantes salen solo de la API oficial de Tiendanube (nunca scraping).
- La IA nunca inventa precios, stock, mínimos mayoristas, envíos ni condiciones: si falta el dato, lo dice y ofrece una persona.
- El bloqueo de respuestas automáticas cuando atiende una persona lo hace el backend, no el prompt.

## Stack

- pnpm workspaces, Node 22, TypeScript (ESM).
- `apps/server`: Fastify 5 + Prisma 6 + PostgreSQL 18. Un solo proceso (Baileys exige una única instancia).
- `apps/panel`: Next.js con export estático, servido por el mismo servidor (1 contenedor + Postgres).
- WhatsApp: Baileys `7.0.0-rc14` (no oficial), credenciales cifradas AES-256-GCM en la tabla `wa_auth_keys`.
- IA: OpenAI Responses API con function calling (herramientas separadas, no un prompt gigante).
- Sin Redis ni pg-boss: la cola durable es `messages.ai_handled_at` (pendientes se recuperan al reiniciar).

## Correr localmente

```bash
cp .env.example .env            # completar ENCRYPTION_KEY con: openssl rand -base64 32
pnpm install
pnpm db:up                      # Postgres en Docker, puerto 5433
pnpm db:migrate
```

Con `WHATSAPP_ENABLED=false` el servidor arranca sin conectar WhatsApp.

## Hecho (sin compilar ni probar todavía)

- Esquema Prisma completo + migración inicial (`apps/server/prisma`).
- `src/core`: env (zod), cifrado, normalización de texto, bus de eventos, auditoría, logger, settings.
- `src/whatsapp`: transporte, auth state en Postgres cifrado, mapeo de mensajes, gateway con QR y reconexión con backoff, deduplicación por id externo.
- `src/conversations`: ingreso de mensajes (dedupe, LID/PN, detección de "quiero hablar con una persona"),
  máquina de estados de derivación (`AI_ACTIVE`, `HUMAN_REQUESTED`, `HUMAN_ACTIVE`, `AI_PAUSED`, `RESOLVED`),
  guardia de respuestas (interruptor general, estado, límite por hora, presupuesto de tokens),
  worker de respuestas (debounce, una conversación a la vez, re-chequeo antes de enviar, recuperación al arrancar),
  envío y registro de mensajes. Si una persona responde desde el teléfono, la conversación pasa a `HUMAN_ACTIVE`.
- `src/catalog`: cliente Tiendanube (paginado, 429/5xx), sincronización completa e individual, búsqueda, detalle, stock y precio por tipo de comprador (mayorista solo si hay lista `wholesale` cargada).
- `src/sales`: carrito y pedido "a revisar" (no cobra).
- `src/events`: leads de Glitter Bar / Shimmer Walls con campos faltantes, seguimientos.

## Pendiente (en este orden)

1. `src/ai`: prompt base + orquestador Responses API (loop de tool calls, máx. ~5 vueltas, timeout) + herramientas:
   `search_products`, `get_product_details`, `check_stock`, `get_price`, `get_business_info`, `get_service_info`,
   `set_buyer_type`, `update_customer_profile`, `add_to_cart`, `view_cart`, `remove_from_cart`, `submit_order`,
   `save_event_lead`, `schedule_followup`, `request_human`. Registrar cada corrida en `ai_runs`.
   Memoria por cliente: `contacts.memory_summary` + últimos N mensajes.
2. Webhook Tiendanube (`x-linkedstore-hmac-sha256` = HMAC-SHA256 hex del body crudo con el app secret; deduplicar en `webhook_events`; siempre re-consultar el producto a la API porque pueden llegar duplicados o desordenados).
3. `src/main.ts` + rutas Fastify: login con sesión en cookie (argon2), roles, API del panel, SSE para la bandeja, estado/QR de WhatsApp, interruptor de IA, `cli.ts` (crear usuario), seed (roles, `ai_settings` id=1, claves de negocio vacías).
4. Panel Next.js: login, bandeja en vivo, conversación (tomar / devolver a IA / pausar / resolver / responder), contactos, catálogo y sync, pedidos, leads, seguimientos, configuración del negocio y de la IA, WhatsApp (QR), auditoría.
5. Tests (vitest) de los escenarios de la especificación: precio, stock, mayorista sin precio cargado, recomendaciones, envíos sin dato, Glitter Bar, Shimmer Walls, pedido de persona, persona respondiendo desde el teléfono, reconexión, mensajes duplicados, falla de OpenAI, falla de Tiendanube, cliente que vuelve.
6. `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` en verde. Dockerfile.

## Credenciales que van a hacer falta (no commitear)

- `OPENAI_API_KEY`
- `TIENDANUBE_STORE_ID` (Male Style: 3924560), `TIENDANUBE_ACCESS_TOKEN`, `TIENDANUBE_APP_SECRET` (app de Tiendanube con permiso de lectura de productos)
- Un número de WhatsApp para vincular por QR.

## Datos del negocio a confirmar con Male Style

Medios de pago, envíos y zonas, condiciones mayoristas (el sitio muestra "+ $40.000 compra mayorista", sin confirmar),
lista de precios mayorista, detalle y condiciones de Glitter Bar y Shimmer Walls, horarios de atención humana.
