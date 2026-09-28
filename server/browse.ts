import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { describe } from "./util";

export interface BrowseEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number | null;
  modifiedAt: string | null;
  link: boolean;
}

export interface BrowseResult {
  home: string;
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
  error: string | null;
}

export interface FileReadResult {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  error: string | null;
}

const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export function homeDirectory(): string {
  return homedir();
}

export async function browseDirectory(input: string | null): Promise<BrowseResult> {
  const home = homeDirectory();
  const requested = input && input.trim().length > 0 ? input.trim() : home;
  const target = isAbsolute(requested) ? resolve(requested) : resolve(home, requested);
  const base: BrowseResult = { home, path: target, parent: null, entries: [], truncated: false, error: null };

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (error) {
    return { ...base, error: describe(error) };
  }

  const entries: BrowseEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const entryPath = join(target, dirent.name);
    let directory = dirent.isDirectory();
    let link = dirent.isSymbolicLink();
    let size: number | null = null;
    let modifiedAt: string | null = null;
    try {
      const info = await stat(entryPath);
      directory = info.isDirectory();
      size = directory ? null : info.size;
      modifiedAt = info.mtime.toISOString();
    } catch {
      if (link) {
        continue;
      }
    }
    entries.push({ name: dirent.name, path: entryPath, directory, size, modifiedAt, link });
  }

  entries.sort((left, right) => {
    if (left.directory !== right.directory) {
      return left.directory ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const parent = dirname(target);
  return { ...base, parent: parent === target ? null : parent, entries, truncated };
}

export async function readTextFile(path: string): Promise<FileReadResult> {
  const target = isAbsolute(path) ? resolve(path) : resolve(homeDirectory(), path);
  const empty: FileReadResult = { path: target, text: "", size: 0, truncated: false, binary: false, error: null };

  let info;
  try {
    info = await stat(target);
  } catch (error) {
    return { ...empty, error: describe(error) };
  }
  if (info.isDirectory()) {
    return { ...empty, error: "That path is a directory." };
  }

  let buffer;
  try {
    buffer = await readFile(target);
  } catch (error) {
    return { ...empty, size: info.size, error: describe(error) };
  }

  const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) {
    return { ...empty, size: info.size, binary: true, error: "Binary file — not shown." };
  }

  const truncated = buffer.length > MAX_FILE_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_FILE_BYTES) : buffer;
  return {
    path: target,
    text: slice.toString("utf8"),
    size: info.size,
    truncated,
    binary: false,
    error: null,
  };
}
