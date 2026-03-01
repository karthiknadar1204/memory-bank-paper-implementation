import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { verify as verifyJwt } from "hono/jwt";

export type AuthEnv = {
  Variables: { userId: number };
};

export const authMiddleware = async (c: Context<AuthEnv>, next: Next) => {
  const token = getCookie(c, "token");
  if (!token || !process.env.JWT_SECRET) {
    return c.json({ error: "Unauthorized: log in required" }, 401);
  }
  try {
    const decoded = await verifyJwt(token, process.env.JWT_SECRET, "HS256") as { id?: number };
    if (decoded?.id == null) {
      return c.json({ error: "Unauthorized: invalid token" }, 401);
    }
    c.set("userId", decoded.id);
    await next();
  } catch {
    return c.json({ error: "Unauthorized: invalid or expired token" }, 401);
  }
};