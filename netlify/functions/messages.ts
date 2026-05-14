import { requireUser, requireWriter, json, errorResponse, AuthError } from "./_lib/auth.js";
import { normalizeRoom, userEmail, isMessagePath } from "./_lib/paths.js";
import { parseMentions } from "./_lib/mention.js";
import { readRoomService, sendMessageService } from "./_lib/services.js";
import { putFile, deleteFile, getFile } from "./_lib/github.js";

interface MessagePayload {
  text: string;
  author: string;
  mentions: string[];
  sent_at: string;
  client_id?: string;
  edited_at?: string;
}

const MAX_TEXT_LEN = 8000;
const MAX_LIMIT = 100;

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      return await handleGet(req, url);
    }
    if (req.method === "POST") {
      return await handlePost(req);
    }
    if (req.method === "PATCH") {
      return await handlePatch(req, url);
    }
    if (req.method === "DELETE") {
      return await handleDelete(req, url);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return errorResponse(e);
  }
}

async function handleGet(req: Request, url: URL): Promise<Response> {
  await requireUser(req);
  const room = url.searchParams.get("room");
  if (!room) return json({ error: "Missing 'room' query parameter." }, 400);
  const safe = normalizeRoom(room);

  const limit = clampInt(url.searchParams.get("limit"), 1, MAX_LIMIT, 50);
  const sinceIso = url.searchParams.get("since");

  const { topic, messages } = await readRoomService({
    room: safe,
    limit,
    since: sinceIso ?? undefined,
  });

  return json({ room: safe, topic, messages });
}

async function handlePost(req: Request): Promise<Response> {
  const user = await requireWriter(req);
  const body = (await req.json().catch(() => ({}))) as {
    room?: string;
    text?: string;
    client_id?: string;
    reply_to?: string;
  };
  if (!body.room) return json({ error: "Missing 'room'." }, 400);
  if (!body.text || typeof body.text !== "string") return json({ error: "Missing 'text'." }, 400);
  if (body.text.length > MAX_TEXT_LEN) {
    return json({ error: `Message too long (max ${MAX_TEXT_LEN} chars).` }, 400);
  }
  if (body.reply_to && !/^[0-9a-f]{40}$/i.test(body.reply_to)) {
    return json({ error: "Invalid 'reply_to' — must be a 40-char hex commit SHA." }, 400);
  }

  const message = await sendMessageService({
    room: body.room,
    text: body.text,
    user,
    client_id: body.client_id,
    reply_to: body.reply_to,
  });

  return json(message, 201);
}

async function handlePatch(req: Request, url: URL): Promise<Response> {
  const user = await requireWriter(req);
  const path = url.searchParams.get("path");
  if (!path || !isMessagePath(path)) {
    return json({ error: "Missing or invalid 'path' query parameter." }, 400);
  }

  const existing = await getFile(path);
  if (!existing) return json({ error: "Message not found." }, 404);
  const prev = JSON.parse(existing.content) as MessagePayload;

  if (prev.author !== user.name && user.role !== "admin") {
    throw new AuthError(403, "You can only edit your own messages.");
  }

  const body = (await req.json().catch(() => ({}))) as { text?: string };
  if (!body.text) return json({ error: "Missing 'text'." }, 400);
  if (body.text.length > MAX_TEXT_LEN) {
    return json({ error: `Message too long (max ${MAX_TEXT_LEN} chars).` }, 400);
  }

  const mentions = parseMentions(body.text);
  const next: MessagePayload = {
    ...prev,
    text: body.text,
    mentions,
    edited_at: new Date().toISOString(),
  };

  const preview = body.text.replace(/\s+/g, " ").slice(0, 50);
  const result = await putFile(
    path,
    JSON.stringify(next, null, 2) + "\n",
    `edit: ${preview}`,
    { name: user.name, email: userEmail(user.name) },
  );

  return json({ sha: result.commitSha, path, edited_at: next.edited_at });
}

async function handleDelete(req: Request, url: URL): Promise<Response> {
  const user = await requireWriter(req);
  const path = url.searchParams.get("path");
  if (!path || !isMessagePath(path)) {
    return json({ error: "Missing or invalid 'path' query parameter." }, 400);
  }

  const existing = await getFile(path);
  if (!existing) return json({ error: "Message not found." }, 404);
  const prev = JSON.parse(existing.content) as MessagePayload;

  if (prev.author !== user.name && user.role !== "admin") {
    throw new AuthError(403, "You can only delete your own messages.");
  }

  await deleteFile(
    path,
    `delete: ${prev.text.slice(0, 30)}`,
    { name: user.name, email: userEmail(user.name) },
  );
  return json({ deleted: true, path });
}

function clampInt(s: string | null, min: number, max: number, fallback: number): number {
  const n = s ? parseInt(s, 10) : NaN;
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return fallback;
}
