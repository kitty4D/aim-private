import { requireUser, requireModeratorOrAdmin, json, errorResponse } from "./_lib/auth.js";
import { readConfig } from "./_lib/config.js";
import { addRoomService, setRoomTopicService } from "./_lib/services.js";
import { normalizeRoom } from "./_lib/paths.js";

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method === "GET") {
      await requireUser(req);
      const config = await readConfig();
      return json({
        server_name: config.server_name,
        motd: config.motd ?? null,
        rooms: config.rooms,
        room_meta: config.room_meta ?? {},
      });
    }

    if (req.method === "POST") {
      const user = await requireModeratorOrAdmin(req);
      const body = (await req.json().catch(() => ({}))) as { name?: string; topic?: string };
      if (!body.name) return json({ error: "Missing 'name' in body." }, 400);
      const safe = normalizeRoom(body.name);
      const before = await readConfig();
      if (before.rooms.includes(safe)) {
        return json({ rooms: before.rooms, room_meta: before.room_meta ?? {}, created: false });
      }
      const after = await addRoomService(safe, user);
      if (typeof body.topic === "string" && body.topic.trim()) {
        await setRoomTopicService(safe, body.topic, user);
      }
      return json(
        {
          rooms: after.rooms,
          room_meta: after.room_meta ?? {},
          created: true,
          room: safe,
        },
        201,
      );
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return errorResponse(e);
  }
}
