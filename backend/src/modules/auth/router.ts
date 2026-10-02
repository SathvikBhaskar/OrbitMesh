import { Router } from "express";
import { db } from "../../db/client";
import { users, refreshTokens } from "../../db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { validate } from "../../middlewares/validate";
import { loginSchema } from "./schemas";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts
  message: { error: "Too many login attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

function generateTokens(userId: string, role: string) {
  const accessToken = jwt.sign(
    { sub: userId, role },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn } as jwt.SignOptions
  );

  // Generate a random string for the refresh token
  const refreshToken = crypto.randomBytes(40).toString("hex");
  return { accessToken, refreshToken };
}

// POST /api/auth/login
authRouter.post("/login", loginLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) {
      // Avoid leaking whether user exists
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const expiresAt = new Date(Date.now() + env.jwtRefreshExpiresInDays * 24 * 60 * 60 * 1000);

    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: env.nodeEnv === "production",
      sameSite: "lax",
      path: "/api/auth",
      expires: expiresAt
    });

    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
authRouter.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.cookies;
    if (!refreshToken) {
      res.status(401).json({ error: "No refresh token provided" });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    
    // We use a transaction to safely rotate
    const result = await db.transaction(async (tx) => {
      const [rtRecord] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash));

      if (!rtRecord || rtRecord.revokedAt || rtRecord.expiresAt < new Date()) {
        return null;
      }

      // Revoke the old token
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, rtRecord.id));

      const [user] = await tx.select().from(users).where(eq(users.id, rtRecord.userId));
      if (!user) return null;

      const newTokens = generateTokens(user.id, user.role);
      const newTokenHash = crypto.createHash("sha256").update(newTokens.refreshToken).digest("hex");
      const expiresAt = new Date(Date.now() + env.jwtRefreshExpiresInDays * 24 * 60 * 60 * 1000);

      await tx.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: newTokenHash,
        expiresAt,
      });

      return { newTokens, expiresAt };
    });

    if (!result) {
      res.clearCookie("refreshToken", { path: "/api/auth" });
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    res.cookie("refreshToken", result.newTokens.refreshToken, {
      httpOnly: true,
      secure: env.nodeEnv === "production",
      sameSite: "lax",
      path: "/api/auth",
      expires: result.expiresAt
    });

    res.json({ accessToken: result.newTokens.accessToken });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
authRouter.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = req.cookies;
    if (refreshToken) {
      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, tokenHash));
    }
    
    res.clearCookie("refreshToken", { path: "/api/auth" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
import { authenticate } from "../../middlewares/auth";
authRouter.get("/me", authenticate, async (req, res, next) => {
  try {
    const userPayload = req.user!;
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, userPayload.sub));
      
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    
    res.json(user);
  } catch (err) {
    next(err);
  }
});
