import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let writeQueue: Promise<unknown> = Promise.resolve();

export function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
