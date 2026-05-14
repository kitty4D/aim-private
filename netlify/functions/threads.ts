import { requireUser, json, errorResponse } from "./_lib/auth.js";
import { getThreadService } from "./_lib/services.js";

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    await requireUser(req);

    const url = new URL(req.url);
    const room = url.searchParams.get("room");
    const parent = url.searchParams.get("parent");
    if (!room) return json({ error: "Missing 'room' query parameter." }, 400);
    if (!parent) return json({ error: "Missing 'parent' query parameter (commit SHA)." }, 400);
    if (!/^[0-9a-f]{40}$/i.test(parent)) {
      return json({ error: "Invalid 'parent' — must be a 40-char hex commit SHA." }, 400);
    }
    const scanRaw = url.searchParams.get("scan");
    const scan = scanRaw ? Math.min(Math.max(parseInt(scanRaw, 10) || 100, 1), 300) : 100;

    const result = await getThreadService({ room, parent_sha: parent, scan });
    if (!result.parent && result.replies.length === 0) {
      return json({ error: "Thread not found in the recent scan window.", room, parent }, 404);
    }
    return json({
      room,
      parent: result.parent,
      replies: result.replies,
      reply_count: result.replies.length,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
