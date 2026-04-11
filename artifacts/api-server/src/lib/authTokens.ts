import jwt from "jsonwebtoken";

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-jwt-secret-change-me";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export interface JwtClaims {
  sub: string;
  type: "wallet" | "merchant" | "developer";
  sid: string;
}

export function signAccessToken(claims: JwtClaims, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  return jwt.sign(claims, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: ttlSeconds,
    issuer: "kowri-api",
    audience: "kowri-clients",
  });
}

export function verifyAccessToken(token: string): JwtClaims | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "kowri-api",
      audience: "kowri-clients",
    });

    if (!decoded || typeof decoded !== "object") return null;
    const { sub, type, sid } = decoded as Partial<JwtClaims>;
    if (!sub || !sid || !type) return null;
    if (!["wallet", "merchant", "developer"].includes(type)) return null;
    return { sub, sid, type: type as JwtClaims["type"] };
  } catch {
    return null;
  }
}
