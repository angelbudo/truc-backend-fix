# `rooms-rpc` — Edge Function en Supabase externo

Este directorio (`supabase/functions/rooms-rpc/`) contiene la función que
sirve toda la lógica online del juego. Está pensada para desplegarse en
**tu propio proyecto de Supabase** (no en Lovable Cloud) para que cuando
subas el frontend a Vercel todo funcione de forma independiente.

## 1. Esquema SQL

Ejecuta `sql/0001_rooms_rpc_schema.sql` en el **SQL Editor** de tu Supabase.
Es idempotente, lo puedes re-ejecutar sin romper nada.

## 2. Despliegue de la función

Con el [Supabase CLI](https://supabase.com/docs/guides/cli) ya logueado y
con tu proyecto enlazado:

```bash
supabase functions deploy rooms-rpc --no-verify-jwt
```

`--no-verify-jwt` es importante: la función valida la autorización por
`deviceId`, no por JWT.

## 3. Secrets de la función

En **Project Settings → Edge Functions → Secrets** define:

| Nombre           | Valor                                           |
|------------------|-------------------------------------------------|
| `ADMIN_PASSWORD` | Contraseña para los RPCs `admin*` (moderación) |

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase
automáticamente, no hace falta declararlos.

## 4. Variables del frontend en Vercel

En **Vercel → Project → Settings → Environment Variables**:

| Nombre                          | Valor                                  |
|---------------------------------|----------------------------------------|
| `VITE_SUPABASE_URL`             | `https://TU-PROYECTO.supabase.co`      |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | tu **anon key** pública                |

`src/integrations/supabase/client.ts` ya las lee en `import.meta.env`, así
que no hay que tocar nada del frontend. `supabase.functions.invoke("rooms-rpc", …)`
resolverá automáticamente a `https://TU-PROYECTO.supabase.co/functions/v1/rooms-rpc`.

## 5. Estado de implementación

**Fase 1 (este commit):** esqueleto + router + validación + 25 handlers
que devuelven `{ error: "not_implemented" }` con HTTP 501. La función ya
se puede desplegar y probar (CORS, JSON, errores).

Próximas fases:

- **Fase 2** — `createRoom`, `joinRoom`, `getRoom`, `listLobbyRooms`,
  `listMyActiveRooms`, `heartbeat`, `leaveRoom`, `setRoomSettings`,
  `setSeatKind`, `updatePlayerName`, `adminCloseRoom`.
- **Fase 3** — chats y moderación.
- **Fase 4** — motor del juego portado a Deno (anti-trampas real).
- **Fase 5** — bots.
- **Fase 6** — limpieza automática de salas viejas (cron pg_cron).