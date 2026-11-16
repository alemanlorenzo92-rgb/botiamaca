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
pnpm db:seed                    # roles, ai_settings id=1, datos del negocio vacíos
pnpm --filter @bot/server cli user:create --email vos@ejemplo.com --name "Tu nombre" --role admin
pnpm dev                        # API en :3000 y panel en :3001 (http://localhost:3001)
```

Con `WHATSAPP_ENABLED=false` el servidor arranca sin conectar WhatsApp.

- Tests: `pnpm test` (necesita el Postgres de `pnpm db:up`; usa la base `bot_test`, o `TEST_DATABASE_URL`).
- Producción: `docker compose --profile prod up -d --build` (aplica migraciones al arrancar y sirve el panel en el mismo puerto).
  Después: `docker compose exec app sh -c "cd apps/server && node dist/cli.js seed"` y crear el usuario con `user:create`.

## Hecho

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

- `src/ai`: prompt base, orquestador Responses API (máx. 5 vueltas, timeout por llamada y total), 15 herramientas con validación zod, registro en `ai_runs`, memoria por cliente (`memory_summary` + últimos N mensajes).
- Webhook Tiendanube (`POST /webhooks/tiendanube`): firma HMAC sobre el body crudo, dedupe en `webhook_events`, re-consulta del producto, reproceso de pendientes al arrancar.
- `src/main.ts` + `src/http`: login con cookie y argon2, roles (`admin`, `agent`), API del panel, SSE (`/api/events`), WhatsApp/QR, interruptor de IA, `cli.ts` (`seed`, `user:create`).
- `apps/panel`: Next.js exportado estático (lo sirve Fastify en producción). Bandeja en vivo, contactos, catálogo, pedidos, eventos, seguimientos, configuración (negocio, IA, usuarios), WhatsApp y auditoría.
- Tests vitest (`apps/server/test`) de todos los escenarios de la especificación + API del panel. Dockerfile.

## Pendiente

1. Cargar credenciales reales (ver abajo) y probar con un número de WhatsApp de prueba.
2. Cargar los datos del negocio desde el panel (Configuración → Datos del negocio).
3. Lista de precios mayorista: hoy solo se usa si existe la lista `wholesale` con precios cargados.

## Credenciales que van a hacer falta (no commitear)

- `OPENAI_API_KEY`
- `TIENDANUBE_STORE_ID` (Male Style: 3924560), `TIENDANUBE_ACCESS_TOKEN`, `TIENDANUBE_APP_SECRET` (app de Tiendanube con permiso de lectura de productos)
- Un número de WhatsApp para vincular por QR.

## Datos del negocio a confirmar con Male Style

Medios de pago, envíos y zonas, condiciones mayoristas (el sitio muestra "+ $40.000 compra mayorista", sin confirmar),
lista de precios mayorista, detalle y condiciones de Glitter Bar y Shimmer Walls, horarios de atención humana.
