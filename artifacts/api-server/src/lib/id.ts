import { randomUUID } from "crypto";

export function generateId(): string {
  return randomUUID();
}

export function generateReference(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KWR-${ts}-${rand}`;
}

export function generateApiKey(): string {
  return `kwk_${randomUUID().replace(/-/g, "")}`;
}
