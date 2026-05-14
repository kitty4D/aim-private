import { getToken, type AimToken } from "./blobs.js";

export interface AuthedUser extends AimToken {
  token: string;
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function requireUser(req: Request): Promise<AuthedUser> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(aim_[A-Za-z0-9_-]+)$/);
  if (!match) {
    throw new AuthError(401, "Missing or malformed Authorization header. Expected: Bearer aim_...");
  }
  const token = match[1];
  const meta = await getToken(token);
  if (!meta) {
    throw new AuthError(401, "Invalid or revoked token.");
  }
  return { ...meta, token };
}

export async function requireWriter(req: Request): Promise<AuthedUser> {
  const user = await requireUser(req);
  if (user.role === "read-only") {
    throw new AuthError(403, "This token is read-only.");
  }
  return user;
}

export async function requireAdminRole(req: Request): Promise<AuthedUser> {
  const user = await requireUser(req);
  if (user.role !== "admin") {
    throw new AuthError(403, "This action requires an admin-role AIM token.");
  }
  return user;
}

export async function requireModeratorOrAdmin(req: Request): Promise<AuthedUser> {
  const user = await requireUser(req);
  if (user.role !== "admin" && user.role !== "moderator") {
    throw new AuthError(403, "This action requires an admin or moderator AIM token.");
  }
  return user;
}

/**
 * Allow either:
 *   - X-Admin-Secret header matching ADMIN_SECRET env (bootstrap / CLI), or
 *   - Bearer auth with an admin-role AIM token (signed-in admin UI).
 * Returns the AuthedUser when authenticated via Bearer, or null for secret-based auth.
 */
export async function requireAdmin(req: Request): Promise<AuthedUser | null> {
  const expected = process.env.ADMIN_SECRET ?? "";
  if (!expected) {
    throw new AuthError(500, "Server misconfigured: ADMIN_SECRET is not set.");
  }

  const secret = req.headers.get("x-admin-secret") ?? "";
  if (secret) {
    if (!timingSafeEqual(secret, expected)) {
      throw new AuthError(401, "Invalid X-Admin-Secret header.");
    }
    return null;
  }

  // Fall back to Bearer auth — must be an admin-role AIM token.
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader) {
    const user = await requireUser(req);
    if (user.role !== "admin") {
      throw new AuthError(
        403,
        "This endpoint requires an admin-role AIM token (or the X-Admin-Secret header).",
      );
    }
    return user;
  }

  throw new AuthError(
    401,
    "Missing auth. Provide either X-Admin-Secret header or Authorization: Bearer <admin-role token>.",
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AuthError) {
    return json({ error: e.message }, e.status);
  }
  const msg = e instanceof Error ? e.message : "Internal error";
  console.error("[aim] unhandled error:", e);
  return json({ error: msg }, 500);
}

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
