import type { HostKvApi } from "@cursor/bdk";
import { serialize } from "./serialize.js";

/** Ordered id list stored at one KV key. Host KV has no key scan. */
export async function readIds(kv: HostKvApi, key: string): Promise<string[]> {
  const value = await kv.get(key);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

export async function rememberId(kv: HostKvApi, key: string, id: string): Promise<void> {
  await serialize(`index:${key}`, async () => {
    const ids = await readIds(kv, key);
    if (ids.includes(id)) {
      return;
    }
    await kv.put(key, [...ids, id]);
  });
}
