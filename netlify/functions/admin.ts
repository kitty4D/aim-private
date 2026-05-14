import { requireAdmin, json, errorResponse, type AuthedUser } from "./_lib/auth.js";
import { setToken, listTokens, deleteToken, type AimRole } from "./_lib/blobs.js";
import { generateAimToken } from "./_lib/paths.js";

const VALID_ROLES: AimRole[] = ["admin", "moderator", "member", "read-only"];

export default async function handler(req: Request): Promise<Response> {
  try {
    const authUser = await requireAdmin(req);
    const url = new URL(req.url);

    if (req.method === "GET") return await handleList();
    if (req.method === "POST") return await handleCreate(req, authUser);
    if (req.method === "DELETE") return await handleDelete(url);

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return errorResponse(e);
  }
}

async function handleList(): Promise<Response> {
  const all = await listTokens();
  const sanitized = all.map(({ token, meta }) => ({
    token_preview: token.slice(0, 12) + "…",
    name: meta.name,
    role: meta.role,
    created_at: meta.created_at,
  }));
  return json({ tokens: sanitized });
}

async function handleCreate(req: Request, authUser: AuthedUser | null): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: string; role?: string };
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "Missing 'name'." }, 400);
  const role = (body.role ?? "member") as AimRole;
  if (!VALID_ROLES.includes(role)) {
    return json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` }, 400);
  }

  // Tighter security: only the master ADMIN_SECRET can mint new admin tokens.
  // Admin-role tokens (Bearer auth) can mint moderator / member / read-only,
  // but not more admins — this bounds blast radius if an admin token leaks.
  if (role === "admin" && authUser !== null) {
    return json(
      {
        error:
          "Creating admin-role tokens requires the master X-Admin-Secret header, not a Bearer token. This is intentional — it prevents an admin AIM token from minting more admins.",
      },
      403,
    );
  }

  const token = generateAimToken();
  await setToken(token, {
    name,
    role,
    created_at: new Date().toISOString(),
  });

  return json(
    {
      token,
      name,
      role,
      message: "Save this token now — it cannot be retrieved later.",
    },
    201,
  );
}

async function handleDelete(url: URL): Promise<Response> {
  const byName = url.searchParams.get("name");
  if (byName) return await revokeByName(byName);

  const fromQuery = url.searchParams.get("token");
  const fromPath = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const token = fromQuery && fromQuery.startsWith("aim_") ? fromQuery : fromPath;
  if (!token || !token.startsWith("aim_")) {
    return json(
      {
        error:
          "Missing token. Use either DELETE /api/admin/tokens?token=<full-token> or DELETE /api/admin/tokens?name=<name> to revoke all tokens by name.",
      },
      400,
    );
  }
  await deleteToken(token);
  return json({ revoked: true, token_preview: token.slice(0, 12) + "…" });
}

async function revokeByName(name: string): Promise<Response> {
  const all = await listTokens();
  const matches = all.filter((entry) => entry.meta.name === name);
  if (matches.length === 0) {
    return json({ error: `No tokens found for name '${name}'.` }, 404);
  }
  const revoked: Array<{ token_preview: string; role: string }> = [];
  for (const { token, meta } of matches) {
    await deleteToken(token);
    revoked.push({ token_preview: token.slice(0, 12) + "…", role: meta.role });
  }
  return json({ revoked_count: revoked.length, name, revoked });
}
