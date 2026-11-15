import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** For tenant-scoped records, where a 32-bit id would be guessable and collision-prone. */
export function newLongId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
