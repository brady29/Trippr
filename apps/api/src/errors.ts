import type { ErrorCode } from "@trippr/contracts";

/** Every error leaves the API as { error: { code, message } }. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
export const unauthorized = (message = "Sign in to continue") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that") => new AppError(403, "forbidden", message);
export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const versionConflict = (currentVersion?: number) =>
  new AppError(409, "version_conflict", "This route changed since you loaded it. Refresh to see the latest version.", {
    currentVersion,
  });
export const inviteExpired = () => new AppError(410, "invite_expired", "This invite link has expired. Ask for a new one.");
