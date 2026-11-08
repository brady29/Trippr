import { randomBytes } from "node:crypto";

/** Short, URL-safe, prefixed ids: "rt_3kV9x0aQ1b2c". */
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

/** Unguessable invite tokens. */
export const newToken = () => randomBytes(18).toString("base64url");

export const nowIso = () => new Date().toISOString();
