import fs from "fs";
import path from "path";
import type { Notice } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "notices.json");

export function readNotices(): Notice[] {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
      return [];
    }
    const data = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(data) as Notice[];
  } catch {
    return [];
  }
}

export function writeNotices(notices: Notice[]): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(notices, null, 2), "utf-8");
}

export function getNotices(): Notice[] {
  const notices = readNotices();
  const now = new Date();
  return notices.map((n) => ({
    ...n,
    expired: n.deadline ? new Date(n.deadline) < now : false,
  }));
}

export function addNotices(newNotices: Notice[]): Notice[] {
  const existing = readNotices();
  const all = [...existing, ...newNotices];
  writeNotices(all);
  return newNotices;
}

export function deleteNotice(id: string): boolean {
  const notices = readNotices();
  const filtered = notices.filter((n) => n.id !== id);
  if (filtered.length === notices.length) return false;
  writeNotices(filtered);
  return true;
}

export function updateNotice(id: string, updates: Partial<Notice>): Notice | null {
  const notices = readNotices();
  const idx = notices.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  notices[idx] = { ...notices[idx], ...updates };
  writeNotices(notices);
  return notices[idx];
}
