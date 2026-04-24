# HTTP API Reference — Frontend Integration (WhatsApp AI SaaS Backend)

This document describes **every** HTTP endpoint exposed by the project: path, method, authentication, request body/query, successful response shape, and common errors.

**Base URL:** `http://<HOST>:<PORT>` — default port from the environment is `3000` (see `PORT` in `.env`).

---

## 1) Unified response shape (`/api/*` routes)

Most API routes use [`sendOk` / `sendError`](src/common/http.ts).

### Success (2xx)

```json
{
  "success": true,
  "data": <payload>
}
```

- Usually `200`; successful creation may return `201` where noted per endpoint.

### Known application error (`AppError`)

```json
{
  "success": false,
  "error": {
    "code": "SOME_CODE",
    "message": "Human readable message"
  }
}
```

- HTTP status matches the error’s `statusCode` (e.g. `401`, `404`, `409`).

### Unexpected error or non-`AppError` (e.g. Zod parse failure)

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "..."
  }
}
```

- Often `500`. Validate inputs on the client before sending to reduce validation failures.

---

## 2) Authentication (JWT)

Routes under `/api/sessions` and `/api/ai-agents` require:

```http
Authorization: Bearer <access_token>
```

- Missing or invalid token: `401` with `UNAUTHORIZED` (see [`requireAuth`](src/middleware/auth.middleware.ts)).
- Token is returned by `/api/auth/register` and `/api/auth/login`.

---

## 3) Routes without `success` / `data` wrapper

These are registered directly in [`app.ts`](src/app.ts) and are **not** under `/api`.

### `GET /health`

**Auth:** none.

**200 response (raw body):**

```json
{
  "ok": true,
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

### `GET /`

**Auth:** none.

**200 response (raw body):**

```json
{
  "ok": true,
  "name": "whatsapp-ai-saas-backend",
  "version": "1.0.0",
  "environment": "development",
  "health": "/health",
  "api": "/api"
}
```

---

## 4) `POST /api/auth/register`

**Auth:** none.

**Content-Type:** `application/json`

**Body (Zod — [`auth.routes.ts`](src/http/routes/auth.routes.ts)):**

| Field | Type | Constraints |
|-------|------|---------------|
| `email` | string | Valid email |
| `password` | string | Length ≥ 8 |

**Example request:**

```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```

**201 response:**

```json
{
  "success": true,
  "data": {
    "token": "<jwt>",
    "user": {
      "id": "<mongoObjectId>",
      "email": "user@example.com"
    }
  }
}
```

**Common errors:**

| HTTP | `error.code` | Description |
|------|----------------|-------------|
| 409 | `EMAIL_IN_USE` | Email already registered |
| 500 | `INTERNAL_ERROR` | Unexpected failure or Zod validation error |

---

## 5) `POST /api/auth/login`

**Auth:** none.

**Body:**

| Field | Type | Constraints |
|-------|------|---------------|
| `email` | string | Valid email |
| `password` | string | Non-empty |

**Example request:**

```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```

**200 response:** Same shape as `register` `data` (`token` + `user`).

**Common errors:**

| HTTP | `error.code` |
|------|----------------|
| 401 | `INVALID_CREDENTIALS` |

---

## 6) Session routes — router mounted at `/api/sessions`

**Auth:** **Bearer** on **all** routes in this section ([`sessions.routes.ts`](src/http/routes/sessions.routes.ts)).

`publicId` is the session’s public identifier (returned as `sessionId` in responses).

---

### 6.1 `POST /api/sessions`

Creates a new WhatsApp session record (DB only; actual connection uses `start` later).

**Body:**

| Field | Type | Required |
|-------|------|----------|
| `label` | string | No |

**Example:**

```json
{ "label": "Store 1" }
```

or `{}`.

**201 response — `data` is a session object (after `mapSession`):**

```json
{
  "success": true,
  "data": {
    "sessionId": "uuid-or-public-id",
    "status": "disconnected",
    "phoneNumber": null,
    "label": "Store 1",
    "qrCode": null,
    "createdAt": "2026-04-25T12:00:00.000Z"
  }
}
```

**Possible `status` values:** `disconnected` | `connecting` | `qr_pending` | `connected` | `error` (see [`session.model.ts`](src/modules/sessions/session.model.ts)).

---

### 6.2 `GET /api/sessions`

Lists the authenticated user’s sessions.

**200 response:**

```json
{
  "success": true,
  "data": [
    {
      "sessionId": "...",
      "status": "connected",
      "phoneNumber": "+201234567890",
      "label": "Store 1",
      "qrCode": null,
      "createdAt": "..."
    }
  ]
}
```

---

### 6.3 `GET /api/sessions/:publicId`

Returns one session.

**200 response:** Same shape as a single element from the list above.

**Errors:**

| HTTP | `error.code` |
|------|----------------|
| 404 | `SESSION_NOT_FOUND` |

---

### 6.4 `POST /api/sessions/:publicId/start`

Starts the WhatsApp connection (QR when needed).

**Body:** none (ignored if sent).

**200 response:**

```json
{
  "success": true,
  "data": {
    "session": {
      "sessionId": "...",
      "status": "qr_pending",
      "phoneNumber": null,
      "label": null,
      "qrCode": "data:image/png;base64,...",
      "createdAt": "..."
    },
    "qrCode": "data:image/png;base64,..."
  }
}
```

- `qrCode` may be `null` if already connected or no QR is available at that moment.

---

### 6.5 `POST /api/sessions/:publicId/stop`

Stops the socket (does **not** delete the session from the DB).

**200 response:**

```json
{ "success": true, "data": { "ok": true } }
```

---

### 6.6 `DELETE /api/sessions/:publicId`

Permanently deletes the session (campaigns, AI agent, conversation memory, WhatsApp auth state).

**200 response:**

```json
{ "success": true, "data": { "ok": true } }
```

---

### 6.7 `POST /api/sessions/:publicId/send`

Sends a plain text message from the connected session.

**Body:**

| Field | Type | Constraints |
|-------|------|-------------|
| `to` | string | Length 5–64 (phone or JID containing `@`) |
| `text` | string | 1–4096 characters |

**Example:**

```json
{
  "to": "201234567890",
  "text": "Hello"
}
```

**200 response:**

```json
{ "success": true, "data": { "ok": true } }
```

**Errors:**

| HTTP | `error.code` | Description |
|------|----------------|-------------|
| 404 | `SESSION_NOT_FOUND` | |
| 409 | `SESSION_OFFLINE` | Session not connected |

---

## 7) AI agent — `/api/sessions/:publicId/ai-agent`

Validation: [`agentPutSchema` / `agentPatchSchema`](src/http/routes/sessions.routes.ts).

**Server limits:** `memoryMessageLimit` must be between `1` and `AI_MEMORY_MAX_MESSAGES` (from env, default up to `100`).

### 7.1 `GET /api/sessions/:publicId/ai-agent`

**200 response — `data` is the public agent DTO (`AiAgentPublicDto`):**

```json
{
  "success": true,
  "data": {
    "agentId": "...",
    "sessionPublicId": "...",
    "sessionLabel": "Store 1",
    "businessName": "Business",
    "businessDescription": "...",
    "languagePreference": "en",
    "toneOfVoice": "professional",
    "enabled": true,
    "hasGeminiKey": true,
    "updatedAt": "2026-04-25T12:00:00.000Z",
    "typingIndicator": {
      "enabled": true,
      "typingDurationMs": 1000
    },
    "memoryMessageLimit": 50,
    "temperature": 0.7,
    "reactionEmoji": null
  }
}
```

- **`hasGeminiKey`:** In code this reflects whether `OPENROUTER_API_KEY` is set on the server (legacy name; not a per-user Gemini key).
- **`reactionEmoji`:** `null` = no reaction; non-empty string (e.g. `"👍"`) = bot reacts to the customer’s last message before replying (requires a WhatsApp message key from inbound traffic).

**Errors:** `404` — `SESSION_NOT_FOUND` or `AGENT_NOT_FOUND`.

---

### 7.2 `PUT /api/sessions/:publicId/ai-agent`

Creates or fully replaces the agent configuration.

**Body (all fields below are required unless noted):**

| Field | Type | Notes |
|-------|------|--------|
| `businessName` | string | 1–500 |
| `businessDescription` | string | 1–8000 |
| `languagePreference` | string | 2–32 |
| `toneOfVoice` | string | 2–80 |
| `enabled` | boolean | |
| `memoryMessageLimit` | number | Integer 1…`AI_MEMORY_MAX_MESSAGES` |
| `temperature` | number | 0.0–2.0; Zod default `0.7` |
| `reactionEmoji` | string \| null | Optional: omit, `null`, or empty after trim = no reaction |
| `typingIndicator` | object | `enabled` (boolean); if `enabled === true`, `typingDurationMs` is required (100–3000) |

**Example:**

```json
{
  "businessName": "Store",
  "businessDescription": "We sell …",
  "languagePreference": "ar",
  "toneOfVoice": "friendly",
  "enabled": true,
  "memoryMessageLimit": 40,
  "temperature": 0.7,
  "reactionEmoji": "👍",
  "typingIndicator": { "enabled": true, "typingDurationMs": 1200 }
}
```

**200 response:** Same shape as `GET` (agent object).

---

### 7.3 `PATCH /api/sessions/:publicId/ai-agent`

Partial update; **at least one** field must be sent.

| Field | Optional | Notes |
|-------|-----------|--------|
| `businessName` | Yes | |
| `businessDescription` | Yes | |
| `languagePreference` | Yes | |
| `toneOfVoice` | Yes | |
| `enabled` | Yes | |
| `memoryMessageLimit` | Yes | |
| `temperature` | Yes | |
| `reactionEmoji` | Yes | Omit = no change; `null` or `""` = disable reaction; string = enable |
| `typingIndicator` | Yes | Non-empty object; if `enabled: true`, include `typingDurationMs` |

**Errors:** `404` — `AGENT_NOT_FOUND` if no agent exists yet.

---

### 7.4 `DELETE /api/sessions/:publicId/ai-agent`

**200 response:**

```json
{ "success": true, "data": { "ok": true } }
```

---

## 8) Campaigns — `/api/sessions/:publicId/campaigns`

Create/validate logic: [`campaign.service.ts`](src/modules/campaigns/campaign.service.ts) + Zod in [`sessions.routes.ts`](src/http/routes/sessions.routes.ts).

### 8.1 `POST /api/sessions/:publicId/campaigns`

**Body:**

| Field | Type | Required |
|-------|------|----------|
| `recipients` | string[] | Yes, min 1 item, each 5–64 chars |
| `text` | string | Conditional: required if `imageUrls` is missing or empty |
| `imageUrls` | string[] | Optional; each entry must be `https://` |
| `baseDelayMs` | number | Optional; server default `3000`; allowed 0–600000 |
| `jitterMs` | number | Optional; default `0`; 0–120000 |
| `maxSendsPerHour` | number | Optional; 1–10000 |
| `scheduledAt` | string | Optional; ISO date; future date → `scheduled` status |

**201 response — `data` campaign shape:**

```json
{
  "success": true,
  "data": {
    "campaignId": "public-campaign-id",
    "status": "running",
    "scheduledAt": null,
    "startedAt": "2026-04-25T12:00:00.000Z",
    "finishedAt": null,
    "message": {
      "text": "Hello",
      "imageUrls": []
    },
    "options": {
      "baseDelayMs": 3000,
      "jitterMs": 0
    },
    "totalRecipients": 2,
    "pendingCount": 2,
    "sentCount": 0,
    "failedCount": 0,
    "skippedCount": 0,
    "lastError": null,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**`status` values:** `scheduled` | `running` | `paused` | `completed` | `cancelled` | `failed`.

**Possible errors:** `SESSION_NOT_FOUND`, `VALIDATION_ERROR`, `CAMPAIGN_TOO_LARGE` (exceeds `CAMPAIGN_MAX_RECIPIENTS` from env).

---

### 8.2 `GET /api/sessions/:publicId/campaigns`

**Query:**

| Parameter | Type | Default |
|-----------|------|---------|
| `page` | number (integer ≥ 1) | 1 |
| `pageSize` | number (1–100) | 20 |

**200 response:**

```json
{
  "success": true,
  "data": {
    "items": [ { "campaignId": "...", "status": "running" } ],
    "total": 5,
    "page": 1,
    "pageSize": 20
  }
}
```

Each item in `items` matches the campaign object described in §8.1.

---

### 8.3 `GET /api/sessions/:publicId/campaigns/:campaignPublicId`

**200 response:** Campaign object plus up to 20 `recentFailures`:

```json
{
  "success": true,
  "data": {
    "campaignId": "...",
    "status": "running",
    "recentFailures": [
      { "to": "2012...@s.whatsapp.net", "error": "...", "index": 3 }
    ]
  }
}
```

**Errors:** `CAMPAIGN_NOT_FOUND`, `SESSION_NOT_FOUND`.

---

### 8.4 `POST /api/sessions/:publicId/campaigns/:campaignPublicId/pause`

**200 response:** Updated campaign object.

**Errors:** `CAMPAIGN_TERMINAL` (already finished), `CAMPAIGN_NOT_FOUND`.

---

### 8.5 `POST /api/sessions/:publicId/campaigns/:campaignPublicId/resume`

**Additional errors:** `CAMPAIGN_NOT_PAUSED`, `CAMPAIGN_EMPTY`.

---

### 8.6 `POST /api/sessions/:publicId/campaigns/:campaignPublicId/cancel`

**Errors:** `CAMPAIGN_TERMINAL`, `CAMPAIGN_NOT_FOUND`.

---

### 8.7 `DELETE /api/sessions/:publicId/campaigns/:campaignPublicId`

Allowed only when campaign is `completed`, `cancelled`, or `failed`.

**200 response:**

```json
{ "success": true, "data": { "ok": true } }
```

**Error:** `409` — `CAMPAIGN_ACTIVE` if the campaign has not finished.

---

## 9) `GET /api/ai-agents`

Lists all AI agents for the user (typically one per session).

**200 response:**

```json
{
  "success": true,
  "data": [
    {
      "agentId": "...",
      "sessionPublicId": "...",
      "sessionLabel": "...",
      "businessName": "...",
      "businessDescription": "...",
      "languagePreference": "ar",
      "toneOfVoice": "professional",
      "enabled": true,
      "hasGeminiKey": true,
      "updatedAt": "...",
      "typingIndicator": { "enabled": true, "typingDurationMs": 1000 },
      "memoryMessageLimit": 50,
      "temperature": 0.7,
      "reactionEmoji": null
    }
  ]
}
```

Source: [`ai-agents.routes.ts`](src/http/routes/ai-agents.routes.ts) + [`AiAgentsService.listForUser`](src/modules/ai-agents/ai-agents.service.ts).

---

## 10) Errors not wrapped as `AppError` (e.g. Zod)

When `schema.parse(...)` throws inside `try/catch` with `sendError`, the response goes through [`toErrorResponse`](src/common/errors.ts) and may be `INTERNAL_ERROR` with a generic message. Prefer client-side validation before submit.

---

## 11) Quick reference — all routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | No |
| GET | `/` | No |
| POST | `/api/auth/register` | No |
| POST | `/api/auth/login` | No |
| POST | `/api/sessions` | Bearer |
| GET | `/api/sessions` | Bearer |
| GET | `/api/sessions/:publicId/ai-agent` | Bearer |
| PUT | `/api/sessions/:publicId/ai-agent` | Bearer |
| PATCH | `/api/sessions/:publicId/ai-agent` | Bearer |
| DELETE | `/api/sessions/:publicId/ai-agent` | Bearer |
| POST | `/api/sessions/:publicId/send` | Bearer |
| POST | `/api/sessions/:publicId/campaigns` | Bearer |
| GET | `/api/sessions/:publicId/campaigns` | Bearer |
| GET | `/api/sessions/:publicId/campaigns/:campaignPublicId` | Bearer |
| POST | `/api/sessions/:publicId/campaigns/:campaignPublicId/pause` | Bearer |
| POST | `/api/sessions/:publicId/campaigns/:campaignPublicId/resume` | Bearer |
| POST | `/api/sessions/:publicId/campaigns/:campaignPublicId/cancel` | Bearer |
| DELETE | `/api/sessions/:publicId/campaigns/:campaignPublicId` | Bearer |
| GET | `/api/sessions/:publicId` | Bearer |
| POST | `/api/sessions/:publicId/start` | Bearer |
| POST | `/api/sessions/:publicId/stop` | Bearer |
| DELETE | `/api/sessions/:publicId` | Bearer |
| GET | `/api/ai-agents` | Bearer |

No other REST routes are registered in [`app.ts`](src/app.ts) beyond the above.

---

## 12) `404` — unknown path

Any request that does not match a route above hits the 404 handler in [`app.ts`](src/app.ts):

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Endpoint not found"
  }
}
```

---

## 13) UI / product behaviour notes (WhatsApp + AI)

- **Linking a session:** create session → `start` → show `qrCode` until `status === 'connected'`.
- **Agent:** after `PUT`/`PATCH` with `enabled: true` and a connected session, inbound messages are processed in the background (AI queue); this codebase does not expose real-time progress over these REST routes (no WebSocket in these route files).
- **OpenRouter model choice:** not exposed via API; the server tries an internal fixed model list.

---

## 14) Global error handler (Express `next(err)`)

Errors passed to `next(error)` are handled by [`errorMiddleware`](src/middleware/error.middleware.ts) with the same shape as `sendError` for `AppError`, or `INTERNAL_ERROR` otherwise.

---

*Last updated to match `src/http/routes` and `src/app.ts`.*
