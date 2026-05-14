import { requireUser, json, errorResponse } from "./_lib/auth.js";
import { readConfig } from "./_lib/config.js";

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const user = await requireUser(req);
    const config = await readConfig();

    return json({
      name: user.name,
      role: user.role,
      created_at: user.created_at,
      can: capabilitiesFor(user.role),
      server_name: config.server_name,
      motd: config.motd ?? null,
      rooms: config.rooms,
      room_meta: config.room_meta ?? {},
      realtime: realtimeConfig(),
    });
  } catch (e) {
    return errorResponse(e);
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

function realtimeConfig() {
  const mode = (process.env.REALTIME_MODE ?? "pulse").toLowerCase();
  if (mode === "sse") {
    return {
      mode: "sse" as const,
      endpoint: "/api/events",
      reconnect_delay_ms: 1000,
      fallback: { mode: "pulse" as const, endpoint: "/api/pulse", poll_interval_ms: 10000 },
    };
  }
  return {
    mode: "pulse" as const,
    endpoint: "/api/pulse",
    poll_interval_ms: Number(process.env.PULSE_INTERVAL_MS) || 5000,
    webhook_configured: Boolean(process.env.WEBHOOK_SECRET),
  };
}
