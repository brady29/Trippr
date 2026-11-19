import { createRemoteJWKSet, decodeJwt, jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { Config } from "./config";
import { unauthorized } from "./errors";

export interface AuthUser {
  id: string;
  name?: string | null;
  email?: string | null;
  isDemo: boolean;
}

const APP_ISSUER = "trippr";

/**
 * Two kinds of token are accepted:
 * - tokens this API signs itself (dev sign-in and the read-only demo account);
 * - session tokens from the external identity provider (Clerk), verified
 *   against its JWKS when AUTH_JWKS_URL and AUTH_ISSUER are configured.
 * Either way the subject becomes the User node's id.
 */
export function createAuth(config: Config) {
  const secret = new TextEncoder().encode(config.APP_JWT_SECRET);
  const jwks = config.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)) : null;

  const claim = (payload: JWTPayload, key: string) =>
    typeof payload[key] === "string" ? (payload[key] as string) : null;

  return {
    externalEnabled: Boolean(jwks),

    async issue(user: { id: string; name?: string | null; email?: string | null; isDemo?: boolean }, expiresIn = "30d") {
      return new SignJWT({ name: user.name ?? undefined, email: user.email ?? undefined, demo: user.isDemo || undefined })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(APP_ISSUER)
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(secret);
    },

    async verify(token: string): Promise<AuthUser> {
      let issuer: string | undefined;
      try {
        issuer = decodeJwt(token).iss;
      } catch {
        throw unauthorized("Malformed token");
      }
      try {
        if (issuer === APP_ISSUER) {
          const { payload } = await jwtVerify(token, secret, { issuer: APP_ISSUER, algorithms: ["HS256"] });
          return {
            id: payload.sub!,
            name: claim(payload, "name"),
            email: claim(payload, "email"),
            isDemo: payload.demo === true,
          };
        }
        if (jwks && issuer === config.AUTH_ISSUER) {
          const { payload } = await jwtVerify(token, jwks, {
            issuer: config.AUTH_ISSUER,
            ...(config.AUTH_AUDIENCE ? { audience: config.AUTH_AUDIENCE } : {}),
          });
          if (!payload.sub) throw new Error("Token has no subject");
          return {
            id: payload.sub,
            name: claim(payload, "name") ?? claim(payload, "full_name"),
            email: claim(payload, "email"),
            isDemo: false,
          };
        }
      } catch {
        throw unauthorized("Your session has expired. Sign in again.");
      }
      throw unauthorized("Unknown token issuer");
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
