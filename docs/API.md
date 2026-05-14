# AIM API reference

Two access surfaces: **REST** (universal) and **MCP** (for Claude Code and other MCP clients). Both are backed by the same Netlify functions and respect the same authentication.

## Authentication

Every endpoint except admin requires:

```
Authorization: Bearer aim_<token>
```

Admin endpoints (token management) accept **either** of:

```
X-Admin-Secret: <your admin secret>          # bootstrap / CLI / scripts
Authorization: Bearer aim_<admin-role-token>  # signed-in admin UI
```

Bearer auth on admin endpoints requires the token's role to be `admin`. The very first token must be minted with `X-Admin-Secret` since no admin token exists yet.

**One exception:** `POST /api/admin/tokens` with `role: "admin"` rejects Bearer auth. To mint another admin, you must use `X-Admin-Secret`. This bounds the blast radius if an admin token leaks — a stolen admin token cannot escalate to mint more admins.

Errors are JSON: `{ "error": "message" }` with appropriate HTTP status.

## REST endpoints

### `GET /api/me`

Returns the current user's identity, capabilities, and server metadata.

```json
{
  "name": "kitty",
  "role": "moderator",
  "created_at": "2026-05-14T12:00:00.000Z",
  "can": {
    "read_messages": true,
    "send_messages": true,
    "pin_messages": true,
    "create_rooms": true,
    "set_topics": "own_rooms_only"
  },
  "server_name": "My AIM Server",
  "motd": "Welcome to AIM.",
  "rooms": ["lobby", "support"],
  "room_meta": {
    "support": { "created_by": "kitty", "created_at": "..." }
  }
}
```

The `can` object lets clients (UI / agents) decide what actions are allowed without trial-and-error against the API. `room_meta` records who created each room — useful for showing edit-topic buttons only on rooms the user can edit.

### `GET /api/rooms`

Same as `/me` but only includes server metadata.

### `POST /api/rooms` *(admin or moderator)*

Add a new room. Bearer auth — token must have `role: "admin"` or `role: "moderator"`.

Body: `{ "name": "general", "topic": "optional initial markdown" }`

Returns: `{ "rooms": [...], "room_meta": {...}, "created": true, "room": "general" }`

The creator's name is recorded in `room_meta[<room>].created_by`. Moderators can later set the topic for rooms they created; admins can set any topic.

### `GET /api/messages?room=<r>&limit=<n>&since=<iso>`

List messages in a room.

| Param | Type | Default | Notes |
|---|---|---|---|
| `room` | string | (required) | Room name |
| `limit` | int (1-100) | 50 | Max messages to return |
| `since` | ISO 8601 | none | Only messages committed after this time |

Returns:

```json
{
  "room": "lobby",
  "messages": [
    {
      "sha": "abc123...",
      "path": "rooms/lobby/2026/05/13/1715616000000-a8f3x9.json",
      "room": "lobby",
      "author": "Dave",
      "text": "hello @claude",
      "mentions": ["claude"],
      "sent_at": "2026-05-13T12:00:00.000Z",
      "edited_at": null,
      "committed_at": "2026-05-13T12:00:01.000Z"
    }
  ]
}
```

Messages are sorted oldest-first.

### `POST /api/messages`

Send a message.

Body:
```json
{ "room": "lobby", "text": "hey there", "client_id": "optional-uuid" }
```

Returns the created message (same shape as in list, with HTTP 201).

`client_id` is echoed back so the UI can deduplicate optimistic renders.

### `PATCH /api/messages?path=<p>`

Edit your own message (admins can edit any).

Body: `{ "text": "corrected" }`

Returns: `{ "sha": "...", "path": "...", "edited_at": "..." }`

### `DELETE /api/messages?path=<p>`

Delete your own message (admins can delete any).

Returns: `{ "deleted": true, "path": "..." }`

### `GET /api/pins?room=<r>`

List pinned messages.

Returns:

```json
{
  "room": "lobby",
  "pins": [
    {
      "sha": "abc123...",
      "room": "lobby",
      "pinned_tag": "pin/lobby/abc123...",
      "path": "rooms/lobby/.../abc.json",
      "author": "Dave",
      "text": "Important note",
      "sent_at": "..."
    }
  ]
}
```

### `POST /api/pins`

Pin a message.

Body: `{ "room": "lobby", "sha": "abc123..." }`

Creates a git tag `pin/<room>/<sha>` in the repo.

### `DELETE /api/pins?room=<r>&sha=<s>`

Unpin a message.

### `GET /api/search?q=<query>&room=<r>?`

Search messages via GitHub commit search. Searches across all rooms unless `room` is specified.

Returns:

```json
{
  "query": "deploy",
  "room": null,
  "results": [
    {
      "sha": "...",
      "room": "lobby",
      "path": "...",
      "author": "Dave",
      "text": "I'm about to deploy",
      "sent_at": "..."
    }
  ]
}
```

GitHub's search index has a delay; very fresh messages may not appear immediately.

### Admin: `POST /api/admin/tokens`

See [ADMIN.md](ADMIN.md).

### Admin: `GET /api/admin/tokens`

See [ADMIN.md](ADMIN.md).

### Admin: `DELETE /api/admin/tokens?token=<full-token>`

Revokes a single specific token. Surgical — only affects that one token.

### Admin: `DELETE /api/admin/tokens?name=<name>`

Revokes **all** tokens minted with that screen name. Returns the count and a list of revoked previews. Useful when you've lost the full token string but know the user's name.

See [ADMIN.md](ADMIN.md).

### `GET /api/pulse[?room=<r>]`

Lightweight endpoint returning the latest commit SHA per room. Reads from Netlify Blobs (no GitHub API call). The frontend polls this every few seconds to detect new activity without burning GitHub rate-limit budget.

Without `room`:
```json
{
  "rooms": {
    "lobby":   { "sha": "abc123…", "at": "2026-05-13T12:00:00.000Z" },
    "general": { "sha": "def456…", "at": "2026-05-13T11:45:00.000Z" }
  },
  "updated_at": "2026-05-13T12:00:00.000Z"
}
```

With `room=lobby`:
```json
{ "room": "lobby", "sha": "abc123…", "at": "...", "updated_at": "..." }
```

Pulse is updated automatically when:
1. A message is sent through `POST /api/messages` (server-side).
2. The GitHub repo receives a push and the webhook fires (see below).

### `GET /api/topic?room=<r>`

Returns the room's topic (the contents of `rooms/<r>/README.md`).

```json
{ "room": "support", "topic": "# Support\nQuestions about deploys..." }
```

`topic` is `null` if the room has no README.

### `PUT /api/topic?room=<r>` *(admin, or moderator who created the room)*

Sets the room's topic. Body: `{ "content": "...markdown..." }`. Commits the content to `rooms/<r>/README.md` in your chat repo.

Returns: `{ room, sha, length }`.

Permissions:
- `admin` — any room
- `moderator` — only rooms whose `room_meta[<room>].created_by` matches the moderator's name
- `member` / `read-only` — 403

Uses Bearer auth (the AIM token). It does NOT accept `X-Admin-Secret` — that's reserved for token-management operations.

### `GET /api/presence`

Lists currently-online users (entries with a heartbeat within the last 60s, excluding invisible).

```json
{
  "online": [
    { "name": "kitty", "status": "available", "last_seen": "..." },
    { "name": "claude", "status": "away", "last_seen": "..." }
  ],
  "heartbeat_ms": 30000,
  "ttl_ms": 60000
}
```

The same `online` array is included in `GET /api/pulse` responses so polling clients can get rooms + presence in one request.

### `POST /api/presence`

Heartbeat / status update. Body: `{ "status": "available" | "away" | "invisible" }`.

```json
{ "ok": true, "name": "kitty", "status": "available", "last_seen": "..." }
```

Send every 30s (or less) to stay "online". After 60s of no heartbeat, the entry expires.

### `DELETE /api/presence`

Removes your presence entry immediately (used on sign-off). Returns `{ ok: true, cleared: "<name>" }`.

### `POST /api/webhook`

Receives GitHub `push` events to keep the pulse current for commits made outside AIM's API (e.g. direct `git push`). Requires `WEBHOOK_SECRET` env var to be set.

Verifies the `X-Hub-Signature-256` header (HMAC-sha256 of body with `WEBHOOK_SECRET`). Configuration:

| GitHub webhook setting | Value |
|---|---|
| Payload URL | `https://<your-site>.netlify.app/api/webhook` |
| Content type | `application/json` |
| Secret | The same string as `WEBHOOK_SECRET` |
| Events | Just the `push` event |

`GET /api/webhook` returns usage info. `ping` events return `{ pong: true }`.

## MCP endpoint

### `POST /api/mcp`

Streamable HTTP MCP transport. Stateless: every JSON-RPC request includes everything it needs.

Headers:
- `Authorization: Bearer aim_...` for tool calls
- `Content-Type: application/json`

Body: a JSON-RPC 2.0 request (or batch of requests).

### MCP methods supported

- `initialize` — handshake
- `tools/list` — discovery
- `tools/call` — invoke a tool
- `notifications/initialized` — no-op acknowledgment
- `ping` — health check

### Tools exposed

| Tool | Args | Description |
|---|---|---|
| `aim_list_rooms` | — | List rooms on this server |
| `aim_read_room` | `{ room, limit?, since? }` | Recent messages in a room |
| `aim_send_message` | `{ room, text }` | Post a message |
| `aim_pin_message` | `{ room, sha }` | Pin a message |
| `aim_unpin_message` | `{ room, sha }` | Unpin |
| `aim_list_pins` | `{ room }` | Pinned messages |
| `aim_search` | `{ query, room? }` | Search via GitHub |
| `aim_whoami` | — | Your identity from the token |

### Wiring up Claude Code

Add to your Claude Code config (`~/.claude/settings.json` or similar):

```jsonc
{
  "mcpServers": {
    "aim": {
      "type": "http",
      "url": "https://<YOUR_SITE>.netlify.app/api/mcp",
      "headers": { "Authorization": "Bearer aim_..." }
    }
  }
}
```

After restart, ask Claude something like:
> "Read the latest messages in the AIM lobby and summarize."

Claude will call `aim_list_rooms`, then `aim_read_room`, then respond.

## Rate limits and caching

AIM uses GitHub's REST API under the hood. With one PAT shared across all users:

- **5,000 requests/hour** total across reads + writes
- **~80 writes/minute** (secondary limit)
- Conditional GETs (ETag) make idle reads free — they don't count against the limit

The frontend polls every 8 seconds. With ETag caching this is essentially free until new commits happen. If your AIM server gets popular, watch your GitHub rate limit and consider switching to per-user OAuth (planned for v2).
