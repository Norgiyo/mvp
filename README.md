# La Esquina MVP

Bot de Telegram orientado a canal, con economia de coins, eventos simples y rewarded ads validados en backend.

## Estado actual

- El destino publico es un canal de Telegram.
- El panel de control vive en el chat privado del bot.
- El runtime principal es un solo servidor Express para Railway.
- No hay cron HTTP expuesto para produccion.
- Los eventos automaticos no quedan programados por defecto. Lo normal es publicarlos desde el panel privado.
- `GROUP_CHANNEL_ID` es la variable recomendada.
- `GROUP_CHAT_ID` sigue siendo aceptada solo por compatibilidad.

## Stack

- Node.js 20
- TypeScript
- Express
- grammY
- Postgres directo con `postgres`
- Upstash Redis
- Telegram Mini App
- Monetag Rewarded Interstitial
- Railway como hosting del servicio web

## Arquitectura

1. Telegram envia updates a `POST /api/webhook`.
2. El bot procesa mensajes privados y `callback_query`.
3. Redis guarda dedupe, cooldowns, locks y estado temporal de eventos.
4. Postgres guarda usuarios, balance, transacciones, rifas, claims e historial.
5. La Mini App valida `initData`, crea una sesion corta y solo acredita coins cuando llega un postback valido de Monetag.
6. Railway ejecuta un solo proceso web con `npm start`.
7. Si en algun momento quieres jobs de Railway, se ejecutan con `npm run job -- <job>`.

## Scripts

- `npm install`
- `npm run build`
- `npm start`
- `npm run job -- auction-tick`
- `npm run job -- cleanup-expired`

## Variables de entorno

### Obligatorias

- `APP_URL`
- `BOT_TOKEN`
- `BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `ADMIN_SECRET`
- `SUPABASE_DB_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `MONETAG_MAIN_ZONE_IDS`
- `MONETAG_SDK_URL`
- `MONETAG_POSTBACK_SECRET`
- `GROUP_CHANNEL_ID`

### Opcionales

- `PORT`
- `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- `ADMIN_SECRET_PREVIOUS`
- `MONETAG_POSTBACK_SECRET_PREVIOUS`
- `ADMIN_TELEGRAM_IDS`
- `SUPABASE_DB_POOL_MAX`
- `MONETAG_REQUEST_VAR`
- `GROUP_CHAT_ID`
- `AD_REWARD_COINS`
- `AD_DAILY_LIMIT`
- `AD_THROTTLE_AFTER_COUNT`
- `AD_THROTTLE_COOLDOWN_SECONDS`
- `DAILY_REWARD_COINS`
- `WEEKLY_LEADERBOARD_BONUS_COINS`
- `BIRTHDAY_GIFT_COINS`
- `AD_EVENT_COOLDOWN_SECONDS`
- `LUCKY_DROP_EVENT_COOLDOWN_SECONDS`
- `IDLE_EVENT_INACTIVITY_SECONDS`
- `IDLE_EVENT_GLOBAL_COOLDOWN_SECONDS`
- `LUCKY_DROP_REWARD_COINS`
- `WEBAPP_INITDATA_MAX_AGE_SECONDS`
- `WEBAPP_SESSION_TTL_SECONDS`

## Checklist exacta para migrar variables desde Vercel

Saca estas variables del proyecto de Vercel antes de borrar nada:

- `APP_URL`
- `BOT_TOKEN`
- `BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- `ADMIN_SECRET`
- `ADMIN_SECRET_PREVIOUS`
- `ADMIN_TELEGRAM_IDS`
- `SUPABASE_DB_URL`
- `SUPABASE_DB_POOL_MAX`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `MONETAG_MAIN_ZONE_IDS`
- `MONETAG_SDK_URL`
- `MONETAG_POSTBACK_SECRET`
- `MONETAG_POSTBACK_SECRET_PREVIOUS`
- `MONETAG_REQUEST_VAR`
- `GROUP_CHANNEL_ID`
- `GROUP_CHAT_ID`
- `AD_REWARD_COINS`
- `AD_DAILY_LIMIT`
- `AD_THROTTLE_AFTER_COUNT`
- `AD_THROTTLE_COOLDOWN_SECONDS`
- `DAILY_REWARD_COINS`
- `WEEKLY_LEADERBOARD_BONUS_COINS`
- `BIRTHDAY_GIFT_COINS`
- `AD_EVENT_COOLDOWN_SECONDS`
- `LUCKY_DROP_EVENT_COOLDOWN_SECONDS`
- `IDLE_EVENT_INACTIVITY_SECONDS`
- `IDLE_EVENT_GLOBAL_COOLDOWN_SECONDS`
- `LUCKY_DROP_REWARD_COINS`
- `WEBAPP_INITDATA_MAX_AGE_SECONDS`
- `WEBAPP_SESSION_TTL_SECONDS`

### Comandos utiles en Vercel

- `vercel project inspect`
- `vercel env ls production`
- `vercel env ls preview`
- `vercel env ls development`

### Nota importante sobre secretos sensibles

Si alguna variable en Vercel fue creada como `sensitive`, su valor puede no ser legible despues. En ese caso:

1. Si ya tienes el valor fuera de Vercel, reutilizalo en Railway.
2. Si no lo tienes, rotalo antes de borrar el proyecto viejo.
3. No elimines Vercel hasta confirmar que Railway esta usando los secretos correctos.

## Cutover recomendado a Railway sin tocar produccion todavia

### Fase 1. Preparacion

1. Crear el servicio web en Railway.
2. Configurar Node 20.
3. Cargar en Railway todas las variables reales de produccion.
4. Generar el dominio publico de Railway.
5. Poner ese dominio en `APP_URL`.
6. Desplegar.

### Fase 2. Verificacion previa

Probar en Railway:

- `GET /health`
- `POST /api/setup-webhook` con `ADMIN_SECRET`
- apertura del bot en privado
- panel privado
- boton `Monedero`
- boton `Fondo`
- publicacion y cierre de rifa
- subasta
- flujo de anuncio con Monetag

### Fase 3. Corte real

1. Llamar una sola vez a `POST /api/setup-webhook` en Railway.
2. Confirmar que Telegram ya pega al nuevo `APP_URL`.
3. Verificar que nuevas interacciones del canal y del bot privado ya salen desde Railway.
4. Dejar Vercel intacto durante un periodo corto de observacion.

Recomendacion practica:

- dejar Vercel vivo al menos 24 horas como rollback

## Cuando ya Railway este estable

Haz estas comprobaciones antes de borrar Vercel:

- El webhook apunta al dominio de Railway.
- El panel privado funciona.
- Los botones del canal responden.
- Monetag acredita bien.
- Redis y Postgres funcionan desde Railway.
- No hay errores nuevos en logs.
- Ya no necesitas ningun secreto guardado solo en Vercel.

## Como borrar el proyecto viejo de Vercel

No lo borres antes del cutover.

Cuando Railway ya este estable:

1. Revisa si el proyecto de Vercel tiene dominio activo o preview que quieras conservar.
2. Si solo quieres borrarlo todo:
   - `vercel remove <nombre-del-proyecto>`
3. Si quieres evitar borrar un dominio activo por error:
   - `vercel remove <nombre-del-proyecto> --safe`
4. Si ya confirmaste y quieres saltarte la confirmacion interactiva:
   - `vercel remove <nombre-del-proyecto> --yes`

## Endpoints

### Publicos

- `POST /api/webhook`
- `GET /api/webapp`
- `POST /api/webapp-session`
- `POST /api/ad-attempt`
- `POST /api/ad-done`
- `GET|POST /api/monetag-postback`
- `GET /api/monetag-sdk`
- `GET /health`

### Admin protegidos

- `POST /api/admin`
- `POST /api/setup-webhook`
- `POST /api/admin/post-home`
- `POST /api/admin/create-raffle`
- `POST /api/admin/close-raffle`

### Acciones soportadas por `POST /api/admin`

- `setup_webhook`
- `post_home`
- `create_raffle`
- `close_raffle`

## Panel privado de admin

Botones actuales:

- `Home`
- `Fondo`
- `Daily`
- `Anuncio`
- `Lucky drop`
- `Cumpleanos`
- `Subasta`
- `Leaderboard semanal`
- `Crear rifa`
- `Cerrar rifa`
- `Panel`

## Funcionalidades activas

### 1. Home

- Boton admin: `Home`
- Mensaje publicado:
  - `La Esquina`
  - `Toca el boton para consultar tu saldo. El Fondo se publica aparte como mensaje.`
- Boton publico: `Monedero`
- Toast:
  - `Tu saldo actual es X`
  - `Tu saldo actual es X | Titulo: ...`

### 2. Fondo

- Boton admin: `Fondo`
- Mensaje publicado:
  - `Fondo del barrio`
  - `Fondo actual: X CUP`
  - `Apoya el Fondo con una donacion directa de 100 coins.`
- Boton publico: `Donar -100`
- Toasts:
  - `Donaste 100 al Fondo. Saldo: X. Fondo: Y`
  - `No tienes saldo suficiente para donar.`
  - `Monto de donacion invalido.`
  - `Donacion no disponible temporalmente.`
  - `Espera un momento antes de volver a donar.`

### 3. Daily reward

- Boton admin: `Daily`
- Mensaje publicado:
  - `Daily reward`
  - `Reclama tu reward diario de +N`
- Boton publico: `Reclamar +N`
- Toasts:
  - `Daily +N. Racha X dias (xM). Saldo: Y`
  - `Hoy ya reclamaste tu daily.`
  - `Este daily ya vencio.`

### 4. Rewarded ads

- Boton admin: `Anuncio`
- Mensaje publicado:
  - `Anuncio disponible`
  - `Abri la Mini App y mira un rewarded para ganar +N`
- Boton publico: `Ver anuncio +N`
- Flujo:
  1. El usuario abre la Mini App.
  2. `POST /api/webapp-session` valida `initData`.
  3. El backend crea una sesion corta en Redis.
  4. `POST /api/ad-attempt` crea `token`, `ymid`, zona y expiracion.
  5. Monetag muestra el anuncio.
  6. Monetag llama `GET|POST /api/monetag-postback`.
  7. Solo si el postback es valido y `reward_event_type=valued`, se acredita el reward.
  8. La Mini App consulta `POST /api/ad-done` para leer el estado real.

### 5. Lucky drop

- Boton admin: `Lucky drop`
- Mensaje publicado:
  - `Lucky drop`
  - `El primero que llegue se lleva +N`
- Boton publico: `Agarrarlo`

### 6. Cumpleanos

- Comandos privados:
  - `/cumple DD/MM`
  - `/cumple borrar`
  - `/cumple`
- Boton admin: `Cumpleanos`
- Mensaje publicado:
  - `Hoy es el cumpleanos de @usuario`
  - `Le mandas un regalo?`
- Boton publico: `10 coins`

### 7. Subasta

- Boton admin: `Subasta`
- Mensaje publicado:
  - `SUBASTA ACTIVA`
  - `Premio: 500 coins del Fondo`
  - `Precio actual: 80 coins - sin puja`
  - `Cierra en: ...`
- Boton publico: `Pujar (-10)`

### 8. Rifas

- Botones admin:
  - `Crear rifa`
  - `Cerrar rifa`
- Mensaje publicado al crear:
  - `Sorteo activo`
  - `Premio: 500 coins`
  - `Costo: 10 coins por entrada`
  - `Maximo: 10 entradas por usuario`
  - `Cierra: fecha/hora`
- Boton publico: `Comprar -10`

### 9. Leaderboard semanal

- Boton admin: `Leaderboard semanal`
- Mensaje publicado:
  - `Leaderboard semanal (YYYY-Www)`
  - top 10 por balance
  - bonus semanal al ganador si aun no se entrego

## Seguridad

### Secretos separados

- `TELEGRAM_WEBHOOK_SECRET`
- `ADMIN_SECRET`
- `MONETAG_POSTBACK_SECRET`

### Segunda capa de rotacion

- `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- `ADMIN_SECRET_PREVIOUS`
- `MONETAG_POSTBACK_SECRET_PREVIOUS`

### Protecciones reales

- Telegram webhook con secreto dedicado
- Dedupe de `update_id` en Redis
- Endpoints admin protegidos con Bearer o `x-admin-secret`
- Mini App validada con HMAC oficial de Telegram
- Sesion corta de Mini App en Redis
- Monetag validado por secreto, `ymid`, `zone_id`, `request_var` y `reward_event_type`
- SQL parametrizado con tagged templates de `postgres`
- Escape de HTML antes de enviar menciones o nombres al canal
- Cooldowns, rate limit, locks e idempotencia en acciones competitivas
- Verificacion de membresia al canal antes de permitir callbacks publicos y anuncios

## Jobs opcionales para Railway

Por defecto no hace falta programar ninguno. Si quieres montar un job real en Railway, usa:

- `npm run job -- auction-tick`
- `npm run job -- cleanup-expired`
- `npm run job -- daily-birthdays`
- `npm run job -- daily-reward`
- `npm run job -- weekly-leaderboard`
- `npm run job -- maybe-post-ad`
- `npm run job -- maybe-post-lucky-drop`
- `npm run job -- maybe-post-idle-event`

Recomendacion:

- no programar `daily-birthdays`, `daily-reward` ni `weekly-leaderboard` si los vas a publicar desde el panel
- si quieres una red de seguridad para eventos vencidos, el mas util es `cleanup-expired`
- si quieres cierre puntual de subastas aunque no haya trafico, usa `auction-tick`

## Mapa rapido de codigo

- Runtime web:
  - `src/server.ts`
- Bot:
  - `src/bot/bot.ts`
  - `src/bot/handlers.ts`
  - `src/bot/callbacks.ts`
  - `src/bot/webhook.ts`
- Endpoints:
  - `src/api/`
- Jobs Railway:
  - `src/jobs/`
  - `src/cli/run-job.ts`
- Base de datos:
  - `src/db/postgres.ts`
  - `src/db/redis.ts`
- Servicios:
  - `src/services/ads.ts`
  - `src/services/fondo.ts`
  - `src/services/birthdays.ts`
  - `src/services/auction.ts`
  - `src/services/raffles.ts`
  - `src/services/leaderboard.ts`
  - `src/services/eventCleanup.ts`

## Nota final

El proyecto nacio para grupo y hoy corre orientado a canal. Por eso todavia quedan algunos nombres heredados en el codigo interno, pero la configuracion recomendada y el flujo publico ya estan pensados para canal.
