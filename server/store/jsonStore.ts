import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// Minimal durable local storage: one JSON file per collection, written atomically.
// Everything lives on the boat's disk, so it works without connectivity.

fs.mkdirSync(config.storeDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export class Collection<T extends { id: string }> {
  private file: string;
  private items: T[];
  constructor(name: string) {
    this.file = path.join(config.storeDir, `${name}.json`);
    this.items = readJson<T[]>(this.file, []);
  }
  all(): T[] {
    return this.items;
  }
  get(id: string): T | undefined {
    return this.items.find((i) => i.id === id);
  }
  upsert(item: T): T {
    const idx = this.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) this.items[idx] = item;
    else this.items.push(item);
    this.save();
    return item;
  }
  upsertMany(items: T[]): void {
    for (const item of items) {
      const idx = this.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) this.items[idx] = item;
      else this.items.push(item);
    }
    this.save();
  }
  removeWhere(pred: (t: T) => boolean): number {
    const before = this.items.length;
    this.items = this.items.filter((i) => !pred(i));
    this.save();
    return before - this.items.length;
  }
  private save() {
    writeJson(this.file, this.items);
  }
}

export class Doc<T> {
  private file: string;
  private value: T;
  constructor(name: string, initial: () => T) {
    this.file = path.join(config.storeDir, `${name}.json`);
    this.value = readJson<T | null>(this.file, null) ?? initial();
  }
  get(): T {
    return this.value;
  }
  set(v: T): T {
    this.value = v;
    writeJson(this.file, v);
    return v;
  }
}

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
