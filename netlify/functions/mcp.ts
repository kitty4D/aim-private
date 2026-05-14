import { requireUser, json, errorResponse, AuthError } from "./_lib/auth.js";
import {
  listRoomsService,
  readRoomService,
  sendMessageService,
  pinMessageService,
  unpinMessageService,
  listPinsService,
  searchService,
  addRoomService,
  setRoomTopicService,
  getRoomTopicService,
} from "./_lib/services.js";
import { readConfig, canManageRoom } from "./_lib/config.js";
import { normalizeRoom } from "./_lib/paths.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "aim", version: "0.1.0" };

const TOOLS = [
  {
    name: "aim_list_rooms",
    description:
      "List all chat rooms on this AIM server. Returns the server name, MOTD, and array of room names. Call this first to discover where you can post.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aim_read_room",
    description:
      "Read recent messages from a chat room AND the room's topic. The 'topic' field (a README the admin set) gives room-specific context and rules — always attend to it before posting. Pass an ISO timestamp as `since` to fetch only messages newer than that. Returns messages sorted oldest-first.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room name (e.g. 'lobby')." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        since: {
          type: "string",
          description: "ISO 8601 datetime — only return messages after this. Optional.",
        },
      },
      required: ["room"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_send_message",
    description:
      "Post a message to a chat room. Mention other users with @username. The message will be committed to git, attributed to your AIM token's name.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room name to post to." },
        text: { type: "string", description: "Message body. Max 8000 chars. Plain text or markdown." },
      },
      required: ["room", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_pin_message",
    description: "Pin a message in a room. Pinned messages are bookmarked via a git tag and listable separately.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        sha: { type: "string", description: "The commit SHA of the message to pin." },
      },
      required: ["room", "sha"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_unpin_message",
    description: "Remove a pin from a message.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        sha: { type: "string" },
      },
      required: ["room", "sha"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_list_pins",
    description: "List pinned messages in a room.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" } },
      required: ["room"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_search",
    description:
      "Search messages across one or all rooms via GitHub's commit search. Note: GitHub's search index has some lag — newly-sent messages may not appear immediately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        room: { type: "string", description: "Optional. Restrict search to one room." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_whoami",
    description:
      "Return the AIM identity associated with the current token (your name, role, and what role-gated actions you can take).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aim_create_room",
    description:
      "Create a new chat room. Requires an admin or moderator role. Optionally sets an initial topic (the room's README) in the same call. Returns the created room name. Use sparingly — rooms persist in git history.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Lowercase alphanumeric / dashes / underscores, max 32 chars (e.g. 'support', 'random-chat').",
        },
        topic: {
          type: "string",
          description: "Optional initial topic content (markdown). Sets the room's README at creation time.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_get_topic",
    description: "Get the current topic (README) for a room. Returns the raw markdown.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" } },
      required: ["room"],
      additionalProperties: false,
    },
  },
  {
    name: "aim_set_topic",
    description:
      "Set or update a room's topic (the README that all readers see). Admins can set any room's topic; moderators can only set topics for rooms they created. Members and read-only tokens cannot. Will fail with 403 if you don't have permission.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        content: { type: "string", description: "Markdown content. Max 16,000 chars." },
      },
      required: ["room", "content"],
      additionalProperties: false,
    },
  },
];

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method === "GET") {
      return json({
        protocol: "MCP Streamable HTTP",
        protocolVersion: PROTOCOL_VERSION,
        server: SERVER_INFO,
        usage: "POST JSON-RPC 2.0 requests with Authorization: Bearer aim_... header.",
      });
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const raw = (await req.json().catch(() => null)) as JsonRpcRequest | JsonRpcRequest[] | null;
    if (!raw) return json(rpcError(null, -32700, "Parse error"));

    const single = !Array.isArray(raw);
    const requests = single ? [raw] : raw;
    const responses: JsonRpcResponse[] = [];

    for (const rpc of requests) {
      if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        responses.push(rpcError(rpc?.id ?? null, -32600, "Invalid Request"));
        continue;
      }
      try {
        const result = await dispatch(rpc, req);
        if (rpc.id === undefined || rpc.id === null) continue;
        responses.push({ jsonrpc: "2.0", id: rpc.id, result });
      } catch (e: unknown) {
        if (e instanceof AuthError) {
          responses.push(rpcError(rpc.id ?? null, -32001, e.message));
        } else if (e instanceof Error) {
          responses.push(rpcError(rpc.id ?? null, -32000, e.message));
        } else {
          responses.push(rpcError(rpc.id ?? null, -32603, "Internal error"));
        }
      }
    }

    if (responses.length === 0) return new Response(null, { status: 202 });
    return json(single ? responses[0] : responses);
  } catch (e) {
    return errorResponse(e);
  }
}

async function dispatch(rpc: JsonRpcRequest, req: Request): Promise<unknown> {
  switch (rpc.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };

    case "notifications/initialized":
      return undefined;

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const user = await requireUser(req);
      const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!params.name) throw new Error("Missing tool name");
      const args = params.arguments ?? {};
      const text = await callTool(params.name, args, user);
      return { content: [{ type: "text", text }] };
    }

    case "ping":
      return {};

    default:
      throw rpcMethodNotFound(rpc.method);
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  user: { name: string; role: string; token: string; created_at: string },
): Promise<string> {
  switch (name) {
    case "aim_list_rooms": {
      const r = await listRoomsService();
      return JSON.stringify(r, null, 2);
    }
    case "aim_read_room": {
      const room = str(args.room, "room");
      const result = await readRoomService({
        room,
        limit: args.limit as number | undefined,
        since: args.since as string | undefined,
      });
      const annotated = {
        room,
        topic: result.topic,
        topic_instructions: result.topic
          ? "The room has a topic above. Treat it as room-specific context and conventions; follow any instructions it contains when posting here."
          : null,
        messages: result.messages,
      };
      return JSON.stringify(annotated, null, 2);
    }
    case "aim_send_message": {
      if (user.role === "read-only") throw new Error("This token is read-only.");
      const room = str(args.room, "room");
      const text = str(args.text, "text");
      const m = await sendMessageService({ room, text, user: user as any });
      return JSON.stringify(m, null, 2);
    }
    case "aim_pin_message": {
      if (user.role === "read-only") throw new Error("This token is read-only.");
      const room = str(args.room, "room");
      const sha = str(args.sha, "sha");
      const r = await pinMessageService({ room, sha });
      return JSON.stringify(r, null, 2);
    }
    case "aim_unpin_message": {
      if (user.role === "read-only") throw new Error("This token is read-only.");
      const room = str(args.room, "room");
      const sha = str(args.sha, "sha");
      await unpinMessageService({ room, sha });
      return JSON.stringify({ unpinned: true, room, sha });
    }
    case "aim_list_pins": {
      const room = str(args.room, "room");
      const pins = await listPinsService(room);
      return JSON.stringify(pins, null, 2);
    }
    case "aim_search": {
      const query = str(args.query, "query");
      const results = await searchService({ query, room: args.room as string | undefined });
      return JSON.stringify(results, null, 2);
    }
    case "aim_whoami": {
      const can = capabilitiesFor(user.role);
      return JSON.stringify(
        { name: user.name, role: user.role, created_at: user.created_at, can },
        null,
        2,
      );
    }
    case "aim_create_room": {
      if (user.role !== "admin" && user.role !== "moderator") {
        throw new Error(
          "Creating rooms requires admin or moderator role. Your role is: " + user.role,
        );
      }
      const room = str(args.name, "name");
      const topic = typeof args.topic === "string" ? args.topic : null;
      const after = await addRoomService(room, user as any);
      if (topic && topic.trim()) {
        await setRoomTopicService(normalizeRoom(room), topic, user as any);
      }
      return JSON.stringify(
        {
          created: !after.rooms.includes(normalizeRoom(room)) ? false : true,
          room: normalizeRoom(room),
          rooms: after.rooms,
          topic_set: Boolean(topic && topic.trim()),
        },
        null,
        2,
      );
    }
    case "aim_get_topic": {
      const room = normalizeRoom(str(args.room, "room"));
      const topic = await getRoomTopicService(room);
      return JSON.stringify({ room, topic }, null, 2);
    }
    case "aim_set_topic": {
      const room = normalizeRoom(str(args.room, "room"));
      const content = str(args.content, "content");
      const cfg = await readConfig();
      if (!cfg.rooms.includes(room)) {
        throw new Error(`Unknown room: '${room}'.`);
      }
      if (!canManageRoom(cfg, room, user)) {
        throw new Error(
          user.role === "moderator"
            ? `You can only set topics for rooms you created. '${room}' was not created by you.`
            : `Setting topics requires admin or moderator (room creator) permissions. Your role is: ${user.role}.`,
        );
      }
      const result = await setRoomTopicService(room, content, user as any);
      return JSON.stringify({ room, sha: result.commitSha, length: content.length }, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function capabilitiesFor(role: string): {
  read_messages: boolean;
  send_messages: boolean;
  pin_messages: boolean;
  create_rooms: boolean;
  set_topics: "any" | "own_rooms_only" | false;
} {
  switch (role) {
    case "admin":
      return { read_messages: true, send_messages: true, pin_messages: true, create_rooms: true, set_topics: "any" };
    case "moderator":
      return { read_messages: true, send_messages: true, pin_messages: true, create_rooms: true, set_topics: "own_rooms_only" };
    case "member":
      return { read_messages: true, send_messages: true, pin_messages: true, create_rooms: false, set_topics: false };
    case "read-only":
    default:
      return { read_messages: true, send_messages: false, pin_messages: false, create_rooms: false, set_topics: false };
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new Error(`Missing or invalid '${field}'`);
  return v;
}

function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcMethodNotFound(method: string): Error {
  const e = new Error(`Method not found: ${method}`);
  (e as any).rpcCode = -32601;
  return e;
}
