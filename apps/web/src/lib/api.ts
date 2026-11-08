import type { ApiError as ApiErrorBody, ErrorCode } from "@trippr/contracts";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isConflict = (e: unknown) => e instanceof ApiError && e.code === "version_conflict";

type TokenGetter = () => Promise<string | null>;
let tokenGetter: TokenGetter = async () => null;

/** The auth provider registers how to get the current token (local or Clerk). */
export function setTokenGetter(getter: TokenGetter) {
  tokenGetter = getter;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await tokenGetter();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "network", "Can't reach the Trippr API. Check your connection.");
  }
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw new ApiError(
      res.status,
      body?.error.code ?? "internal",
      body?.error.message ?? `Request failed (${res.status})`,
      body?.error.details,
    );
  }
  return res;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await request(path, {
    method: options.method ?? "GET",
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Fetch an authenticated file (export) and hand it to the browser as a download. */
export async function download(path: string, fallbackName: string) {
  const res = await request(path);
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Safe localStorage access: private windows and blocked storage must not break the app. */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
