import { requireUser, AuthError, json, errorResponse } from "./_lib/auth.js";
import { normalizeRoom } from "./_lib/paths.js";
import { readConfig, canManageRoom } from "./_lib/config.js";
import { getRoomTopicService, setRoomTopicService } from "./_lib/services.js";

const MAX_TOPIC_LEN = 16_000;

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const room = url.searchParams.get("room");
    if (!room) return json({ error: "Missing 'room' query parameter." }, 400);
    const safe = normalizeRoom(room);

    if (req.method === "GET") {
      await requireUser(req);
      const topic = await getRoomTopicService(safe);
      return json({ room: safe, topic });
    }

    if (req.method === "PUT") {
      const user = await requireUser(req);
      const cfg = await readConfig();
      if (!cfg.rooms.includes(safe)) {
        return json({ error: `Unknown room: '${safe}'.` }, 404);
      }
      if (!canManageRoom(cfg, safe, user)) {
        throw new AuthError(
          403,
          user.role === "moderator"
            ? "Moderators can only set topics for rooms they created. Ask an admin to update this room's topic."
            : "This action requires admin or moderator (room creator) permissions.",
        );
      }
      const body = (await req.json().catch(() => ({}))) as { content?: string };
      if (typeof body.content !== "string") {
        return json({ error: "Missing 'content' in body." }, 400);
      }
      if (body.content.length > MAX_TOPIC_LEN) {
        return json({ error: `Topic too long (max ${MAX_TOPIC_LEN} chars).` }, 400);
      }
      const result = await setRoomTopicService(safe, body.content, user);
      return json({ room: safe, sha: result.commitSha, length: body.content.length }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return errorResponse(e);
  }
}
