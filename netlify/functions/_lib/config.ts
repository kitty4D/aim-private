import { getFile, putFile } from "./github.js";

export interface RoomMeta {
  created_by: string;
  created_at: string;
}

export interface AimConfig {
  server_name: string;
  rooms: string[];
  /** Per-room ownership info. Rooms missing here are considered system-owned. */
  room_meta?: Record<string, RoomMeta>;
  version: number;
  motd?: string;
}

const CONFIG_PATH = ".aim/config.json";
const DEFAULT_CONFIG: AimConfig = {
  server_name: "AIM Server",
  rooms: ["lobby"],
  room_meta: {},
  version: 1,
  motd: "Welcome to AIM. You've got mail... sort of.",
};

const SYSTEM_AUTHOR = { name: "AIM", email: "system@aim.local" };

export async function readConfig(): Promise<AimConfig> {
  const file = await getFile(CONFIG_PATH);
  if (!file) {
    await putFile(
      CONFIG_PATH,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
      "chore: bootstrap AIM config",
      SYSTEM_AUTHOR,
    );
    return DEFAULT_CONFIG;
  }
  try {
    const parsed = JSON.parse(file.content) as AimConfig;
    if (!parsed.room_meta) parsed.room_meta = {};
    return parsed;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeConfig(next: AimConfig, by: { name: string; email: string }): Promise<void> {
  await putFile(
    CONFIG_PATH,
    JSON.stringify(next, null, 2) + "\n",
    `chore: update AIM config (by ${by.name})`,
    by,
  );
}

/** Returns true if `user` can manage `room` (set topic, etc.). */
export function canManageRoom(config: AimConfig, room: string, user: { name: string; role: string }): boolean {
  if (user.role === "admin") return true;
  if (user.role !== "moderator") return false;
  const meta = config.room_meta?.[room];
  return Boolean(meta && meta.created_by === user.name);
}
