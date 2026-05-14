import {
  putFile,
  deleteFile,
  listCommits,
  getCommit,
  getFile,
  searchCommits,
  createLightweightTag,
  deleteTag,
  listMatchingTags,
  type CommitInfo,
  type FileContent,
} from "./github.js";
import { readConfig, writeConfig, type AimConfig } from "./config.js";
import { bumpPulse } from "./blobs.js";
import {
  messagePath,
  normalizeRoom,
  userEmail,
  isMessagePath,
  pinTagName,
  roomFromPath,
} from "./paths.js";
import { parseMentions, mentionTrailer } from "./mention.js";
import type { AuthedUser } from "./auth.js";

export interface MessagePayload {
  text: string;
  author: string;
  mentions: string[];
  sent_at: string;
  client_id?: string;
  edited_at?: string;
}

export interface ApiMessage {
  sha: string;
  path: string;
  room: string;
  author: string;
  text: string;
  mentions: string[];
  sent_at: string;
  edited_at?: string;
  committed_at: string;
}

export interface PinInfo {
  sha: string;
  room: string;
  pinned_tag: string;
  path?: string;
  author?: string;
  text?: string;
  sent_at?: string;
}

export async function listRoomsService(): Promise<{ server_name: string; rooms: string[]; motd: string | null }> {
  const c = await readConfig();
  return { server_name: c.server_name, rooms: c.rooms, motd: c.motd ?? null };
}

export async function getRoomTopicService(room: string): Promise<string | null> {
  const safe = normalizeRoom(room);
  const file = await getFile(`rooms/${safe}/README.md`);
  return file ? file.content : null;
}

export async function setRoomTopicService(
  room: string,
  content: string,
  by: AuthedUser,
): Promise<{ commitSha: string }> {
  const safe = normalizeRoom(room);
  const result = await putFile(
    `rooms/${safe}/README.md`,
    content.endsWith("\n") ? content : content + "\n",
    `topic(${safe}): updated by ${by.name}`,
    { name: by.name, email: userEmail(by.name) },
  );
  return { commitSha: result.commitSha };
}

export async function readRoomService(opts: {
  room: string;
  limit?: number;
  since?: string;
}): Promise<{ topic: string | null; messages: ApiMessage[] }> {
  const safe = normalizeRoom(opts.room);
  const [commits, topic] = await Promise.all([
    listCommits({
      path: `rooms/${safe}`,
      since: opts.since,
      per_page: Math.min(Math.max(opts.limit ?? 50, 1), 100),
    }),
    getRoomTopicService(safe).catch(() => null),
  ]);
  const messages = await commitsToMessages(commits, safe);
  return { topic, messages };
}

export async function sendMessageService(opts: {
  room: string;
  text: string;
  user: AuthedUser;
  client_id?: string;
}): Promise<ApiMessage> {
  const config = await readConfig();
  const safe = normalizeRoom(opts.room);
  if (!config.rooms.includes(safe)) {
    throw new Error(`Unknown room: '${safe}'. Available: ${config.rooms.join(", ")}`);
  }
  if (!opts.text.trim()) throw new Error("Message text is empty.");

  const now = new Date();
  const mentions = parseMentions(opts.text);
  const payload: MessagePayload = {
    text: opts.text,
    author: opts.user.name,
    mentions,
    sent_at: now.toISOString(),
    client_id: opts.client_id,
  };

  const preview = opts.text.replace(/\s+/g, " ").slice(0, 50);
  const trailer = mentionTrailer(mentions);
  const commitMsg = `msg(${safe}): ${preview}` + (trailer ? `\n\n${trailer}\n` : "\n");

  const path = messagePath(safe, now);
  const result = await putFile(
    path,
    JSON.stringify(payload, null, 2) + "\n",
    commitMsg,
    { name: opts.user.name, email: userEmail(opts.user.name) },
  );

  await bumpPulse(safe, result.commitSha).catch((e) => {
    console.error("[aim] bumpPulse failed (non-fatal):", e);
  });

  return {
    sha: result.commitSha,
    path,
    room: safe,
    author: opts.user.name,
    text: opts.text,
    mentions,
    sent_at: payload.sent_at,
    committed_at: payload.sent_at,
  };
}

export async function pinMessageService(opts: { room: string; sha: string }): Promise<{
  tag: string;
  room: string;
  sha: string;
}> {
  const safe = normalizeRoom(opts.room);
  const tag = pinTagName(safe, opts.sha);
  try {
    await createLightweightTag(tag, opts.sha);
  } catch (e: unknown) {
    if (!(typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status === 422)) {
      throw e;
    }
  }
  return { tag, room: safe, sha: opts.sha };
}

export async function unpinMessageService(opts: { room: string; sha: string }): Promise<void> {
  const safe = normalizeRoom(opts.room);
  const tag = pinTagName(safe, opts.sha);
  await deleteTag(tag).catch((e: any) => {
    if (e?.status !== 404 && e?.status !== 422) throw e;
  });
}

export async function listPinsService(room: string): Promise<PinInfo[]> {
  const safe = normalizeRoom(room);
  const tags = await listMatchingTags(`pin/${safe}/`);
  const pins: PinInfo[] = [];
  for (const t of tags) {
    const sha = t.tag.split("/").pop() ?? "";
    const pin: PinInfo = { sha, room: safe, pinned_tag: t.tag };
    const detail = await getCommit(sha).catch(() => null);
    if (detail) {
      const msgFile = (detail.fileContents as FileContent[]).find(
        (f) => isMessagePath(f.path) && f.path.startsWith(`rooms/${safe}/`),
      );
      if (msgFile) {
        try {
          const p = JSON.parse(msgFile.content);
          pin.path = msgFile.path;
          pin.author = p.author;
          pin.text = p.text;
          pin.sent_at = p.sent_at;
        } catch {
          // skip
        }
      }
    }
    pins.push(pin);
  }
  return pins;
}

export async function searchService(opts: { query: string; room?: string }): Promise<
  Array<{ sha: string; room: string; path: string; author: string; text: string; sent_at: string }>
> {
  const safe = opts.room ? normalizeRoom(opts.room) : null;
  const commits = await searchCommits(opts.query);
  const out: Array<{ sha: string; room: string; path: string; author: string; text: string; sent_at: string }> = [];
  for (const c of commits) {
    const detail = await getCommit(c.sha).catch(() => null);
    if (!detail) continue;
    for (const file of detail.fileContents) {
      if (!isMessagePath(file.path)) continue;
      const r = roomFromPath(file.path);
      if (!r) continue;
      if (safe && r !== safe) continue;
      try {
        const p = JSON.parse(file.content);
        out.push({ sha: c.sha, room: r, path: file.path, author: p.author, text: p.text, sent_at: p.sent_at });
      } catch {
        // skip
      }
    }
  }
  return out;
}

export async function addRoomService(name: string, by: AuthedUser): Promise<AimConfig> {
  const safe = normalizeRoom(name);
  const cfg = await readConfig();
  if (cfg.rooms.includes(safe)) return cfg;
  const room_meta = {
    ...(cfg.room_meta ?? {}),
    [safe]: { created_by: by.name, created_at: new Date().toISOString() },
  };
  const next: AimConfig = { ...cfg, rooms: [...cfg.rooms, safe], room_meta };
  await writeConfig(next, { name: by.name, email: userEmail(by.name) });
  return next;
}

async function commitsToMessages(commits: CommitInfo[], room: string): Promise<ApiMessage[]> {
  const out: ApiMessage[] = [];
  for (const c of commits) {
    const detail = await getCommit(c.sha).catch(() => null);
    if (!detail) continue;
    for (const file of detail.fileContents) {
      if (!isMessagePath(file.path)) continue;
      if (!file.path.startsWith(`rooms/${room}/`)) continue;
      try {
        const p = JSON.parse(file.content) as MessagePayload;
        out.push({
          sha: c.sha,
          path: file.path,
          room,
          author: p.author,
          text: p.text,
          mentions: p.mentions ?? [],
          sent_at: p.sent_at,
          edited_at: p.edited_at,
          committed_at: c.committer.date,
        });
      } catch {
        // skip
      }
    }
  }
  return out.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
}
