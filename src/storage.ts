import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function loadJson<T = any>(root: string, relativePath: string): Promise<T> {
  const content = await readFile(join(root, relativePath), "utf8");
  return JSON.parse(content) as T;
}

export async function loadJsonOrDefault<T = any>(
  root: string,
  relativePath: string,
  defaultValue: T
): Promise<T> {
  try {
    return await loadJson<T>(root, relativePath);
  } catch (error) {
    if (isMissingFileError(error)) return defaultValue;
    throw error;
  }
}

export async function saveJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = join(root, relativePath);
  await ensureDir(dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

export async function saveText(root: string, relativePath: string, value: string): Promise<void> {
  const filePath = join(root, relativePath);
  await ensureDir(dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  await rename(tmpPath, filePath);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
