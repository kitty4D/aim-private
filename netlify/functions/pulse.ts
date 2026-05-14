import { requireUser, json, errorResponse } from "./_lib/auth.js";
import { readPulse, listOnline } from "./_lib/blobs.js";
import { readConfig } from "./_lib/config.js";

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    await requireUser(req);

    const url = new URL(req.url);
    const room = url.searchParams.get("room");

    // Pulse + presence + canonical room list all in one round-trip so the
    // client can keep the buddy list (online users AND available rooms)
    // current without separately polling /api/rooms or /api/me.
    const [pulse, online, config] = await Promise.all([readPulse(), listOnline(), readConfig()]);

    if (room) {
      const entry = pulse.rooms[room] ?? null;
      return json({
        room,
        sha: entry?.sha ?? null,
        at: entry?.at ?? null,
        updated_at: pulse.updated_at,
        online,
      });
    }
    return json({
      ...pulse,
      online,
      // canonical room list (everything in .aim/config.json) — this is what
      // clients should use for the buddy list, not the keys of `rooms` (those
      // are only rooms that have message activity).
      available_rooms: config.rooms,
      room_meta: config.room_meta ?? {},
    });
  } catch (e) {
    return errorResponse(e);
  }
}
