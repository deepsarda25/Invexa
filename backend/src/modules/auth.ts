import { Elysia, t } from "elysia";
import { randomInt } from "node:crypto";
import { authenticate, hashPassword, verifyPassword } from "../lib/auth";
import { sendOtpEmail, sendAccountCreatedEmail, MailDeliveryError, isMailConfigured } from "../lib/mailer";
import { sql } from "../lib/db";
import { redis } from "../lib/redis";
import { env } from "../config/env";

const ACCESS_KEY_PATTERN = /^\d{4}$/;

// ── Signup email verification (OTP) ──────────────────────────────────────
// Nothing is written to the `users` table until the emailed code is
// confirmed — the submitted signup details live in Redis for a short
// window instead. This keeps unverified signups from squatting
// usernames/emails, and matches "verify the mail id, then the account is
// created".
const OTP_TTL_SECONDS = 10 * 60; // how long a pending signup + its code stay valid
const RESEND_COOLDOWN_SECONDS = 45; // minimum gap between OTP (re)sends per email
const MAX_OTP_ATTEMPTS = 5; // wrong-code attempts allowed before the signup must restart

type PendingRegistration = {
  username: string;
  passwordHash: string;
  accessKeyHash: string;
  accessKey: string; // kept only long enough to include in the post-verification "credentials" email
  role: "user" | "educator";
  otp: string;
  attempts: number;
};

const pendingKey = (email: string) => `register:pending:${email}`;
const cooldownKey = (email: string) => `register:cooldown:${email}`;

function generateOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Stores the pending signup and emails its code.
 *
 * Order matters: the code is emailed *first*, and the pending record is
 * only persisted once the mail server has accepted it. Previously this ran
 * the other way round and `sendOtpEmail` swallowed every failure, so a
 * broken SMTP config produced a signup that cheerfully reported "we've sent
 * you a code" while no email ever left the server — leaving the user stuck
 * on the verification screen with no way forward and nothing in the logs
 * tied to their request. Now a delivery failure surfaces as a
 * `MailDeliveryError` and leaves no half-finished signup behind.
 */
async function issueAndSendOtp(email: string, username: string, pending: PendingRegistration) {
  await sendOtpEmail({
    to: email,
    username,
    otp: pending.otp,
    expiresInMinutes: OTP_TTL_SECONDS / 60
  });

  await redis.set(pendingKey(email), JSON.stringify(pending), "EX", OTP_TTL_SECONDS);
  await redis.set(cooldownKey(email), "1", "EX", RESEND_COOLDOWN_SECONDS);
}

/**
 * In development without SMTP configured, `sendOtpEmail` can't deliver
 * anything — so the pending signup is kept and the code is returned in the
 * response body instead, letting local work proceed. In production, or
 * whenever SMTP *is* configured and simply failed, the error is real and
 * must reach the user.
 */
function isDevMailFallback() {
  return env.NODE_ENV !== "production" && !isMailConfigured();
}

export const authModule = new Elysia({ prefix: "/auth" })
  .get("/login", () => ({
    error: "Use POST /auth/login with JSON body: { usernameOrEmail, password } or { usernameOrEmail, accessKey }"
  }))
  .post(
    "/register",
    async (ctx: any) => {
      const body = ctx.body as any;
      const username = body.username.trim();
      const email = body.email.trim().toLowerCase();

      if (body.password !== body.confirmPassword) {
        ctx.set.status = 400;
        return { error: "Password and confirm password do not match." };
      }

      if (!ACCESS_KEY_PATTERN.test(String(body.accessKey ?? ""))) {
        ctx.set.status = 400;
        return { error: "Access Key must be exactly 4 digits." };
      }

      if (body.accessKey !== body.confirmAccessKey) {
        ctx.set.status = 400;
        return { error: "Access Key and confirm Access Key do not match." };
      }

      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE username = ${username} OR email = ${email} LIMIT 1
      `;

      if (existing) {
        ctx.set.status = 409;
        return { error: "Username or email already exists" };
      }

      const onCooldown = await redis.get(cooldownKey(email));
      if (onCooldown) {
        const ttl = await redis.ttl(cooldownKey(email));
        ctx.set.status = 429;
        return { error: `Please wait ${Math.max(ttl, 1)}s before requesting another code.` };
      }

      const passwordHash = await hashPassword(body.password);
      const accessKeyHash = await hashPassword(body.accessKey);
      const otp = generateOtp();

      const pending: PendingRegistration = {
        username,
        passwordHash,
        accessKeyHash,
        accessKey: body.accessKey,
        role: (body.role ?? "user") as "user" | "educator",
        otp,
        attempts: 0
      };

      try {
        await issueAndSendOtp(email, username, pending);
      } catch (err) {
        if (err instanceof MailDeliveryError && isDevMailFallback()) {
          // No SMTP in local dev — keep the signup alive and hand the code
          // back in the response so development isn't blocked.
          await redis.set(pendingKey(email), JSON.stringify(pending), "EX", OTP_TTL_SECONDS);
          await redis.set(cooldownKey(email), "1", "EX", RESEND_COOLDOWN_SECONDS);
        } else if (err instanceof MailDeliveryError) {
          // Nothing was written to Redis (the send happens first), so the
          // user can simply try again — no cooldown to wait out, no stale
          // pending record blocking a retry.
          ctx.set.status = 502;
          return { error: err.message, mailDeliveryFailed: true };
        } else {
          throw err;
        }
      }

      return {
        pendingVerification: true,
        email,
        expiresInSeconds: OTP_TTL_SECONDS,
        message: "We've sent a 6-digit verification code to your email. Enter it to finish creating your account.",
        // Convenience for local/dev/test runs without real SMTP configured —
        // never included in production.
        ...(isDevMailFallback() ? { devOtp: otp } : {})
      };
    },
    {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 50 }),
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8, maxLength: 128 }),
        confirmPassword: t.String({ minLength: 8, maxLength: 128 }),
        accessKey: t.String({ minLength: 4, maxLength: 4 }),
        confirmAccessKey: t.String({ minLength: 4, maxLength: 4 }),
        role: t.Optional(t.Union([t.Literal("user"), t.Literal("educator")]))
      })
    }
  )
  .post(
    "/verify-email",
    async (ctx: any) => {
      const body = ctx.body as any;
      const email = String(body.email ?? "").trim().toLowerCase();
      const otp = String(body.otp ?? "").trim();

      const raw = await redis.get(pendingKey(email));
      if (!raw) {
        ctx.set.status = 400;
        return { error: "No pending signup found for this email, or it has expired. Please register again." };
      }

      const pending = JSON.parse(raw) as PendingRegistration;

      if (pending.attempts >= MAX_OTP_ATTEMPTS) {
        await redis.del(pendingKey(email));
        ctx.set.status = 429;
        return { error: "Too many incorrect attempts. Please register again." };
      }

      if (pending.otp !== otp) {
        pending.attempts += 1;
        await redis.set(pendingKey(email), JSON.stringify(pending), "KEEPTTL");
        ctx.set.status = 400;
        return {
          error: "Incorrect verification code.",
          attemptsRemaining: Math.max(MAX_OTP_ATTEMPTS - pending.attempts, 0)
        };
      }

      // Re-check uniqueness in case someone else claimed the username/email
      // while this signup was pending verification.
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE username = ${pending.username} OR email = ${email} LIMIT 1
      `;
      if (existing) {
        await redis.del(pendingKey(email));
        ctx.set.status = 409;
        return { error: "Username or email already exists. Please register again." };
      }

      const [created] = await sql<
        { id: string; username: string; role: "user" | "educator" | "admin"; email: string; virtualBalance: string }[]
      >`
        INSERT INTO users (username, email, password_hash, access_key_hash, role, email_verified)
        VALUES (${pending.username}, ${email}, ${pending.passwordHash}, ${pending.accessKeyHash}, ${pending.role}, true)
        RETURNING id, username, role, email, virtual_balance as "virtualBalance"
      `;

      await redis.del(pendingKey(email));
      await redis.del(cooldownKey(email));

      const token = await ctx.jwt.sign({
        sub: created.id,
        username: created.username,
        role: created.role
      });

      await redis.set(`session:active:${token}`, created.id, "EX", 7 * 24 * 60 * 60);

      // Fire-and-forget: share the freshly created account's credentials by
      // email now that the address is confirmed to belong to this user.
      // `sendMail` never throws, so this can't fail the signup response.
      void sendAccountCreatedEmail({
        to: email,
        username: created.username,
        email: created.email,
        accessKey: pending.accessKey
      }).catch((err) => console.error("[mailer] account-created email failed:", err));

      return { token, user: created };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        otp: t.String({ minLength: 4, maxLength: 8 })
      })
    }
  )
  .post(
    "/resend-otp",
    async (ctx: any) => {
      const body = ctx.body as any;
      const email = String(body.email ?? "").trim().toLowerCase();

      const raw = await redis.get(pendingKey(email));
      if (!raw) {
        ctx.set.status = 400;
        return { error: "No pending signup found for this email. Please register again." };
      }

      const onCooldown = await redis.get(cooldownKey(email));
      if (onCooldown) {
        const ttl = await redis.ttl(cooldownKey(email));
        ctx.set.status = 429;
        return { error: `Please wait ${Math.max(ttl, 1)}s before requesting another code.` };
      }

      const pending = JSON.parse(raw) as PendingRegistration;
      pending.otp = generateOtp();
      pending.attempts = 0;

      try {
        await issueAndSendOtp(email, pending.username, pending);
      } catch (err) {
        if (err instanceof MailDeliveryError && isDevMailFallback()) {
          await redis.set(pendingKey(email), JSON.stringify(pending), "EX", OTP_TTL_SECONDS);
          await redis.set(cooldownKey(email), "1", "EX", RESEND_COOLDOWN_SECONDS);
        } else if (err instanceof MailDeliveryError) {
          // The previously-issued code is still valid and no cooldown was
          // started, so the user can retry immediately.
          ctx.set.status = 502;
          return { error: err.message, mailDeliveryFailed: true };
        } else {
          throw err;
        }
      }

      return {
        pendingVerification: true,
        email,
        expiresInSeconds: OTP_TTL_SECONDS,
        message: "We've sent a new verification code to your email.",
        ...(isDevMailFallback() ? { devOtp: pending.otp } : {})
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" })
      })
    }
  )
  .post(
    "/login",
    async (ctx: any) => {
      const body = ctx.body as any;
      const identifier = String(body.usernameOrEmail ?? body.username ?? body.email ?? "").trim();

      if (!identifier || (!body.password && !body.accessKey)) {
        ctx.set.status = 400;
        return { error: "usernameOrEmail (or username/email) and either password or accessKey are required" };
      }

      const usernameOrEmail = identifier.toLowerCase();

      const [user] = await sql<
        {
          id: string;
          username: string;
          email: string;
          passwordHash: string;
          accessKeyHash: string | null;
          role: "user" | "educator" | "admin";
          virtualBalance: string;
        }[]
      >`
        SELECT id,
               username,
               email,
               password_hash as "passwordHash",
               access_key_hash as "accessKeyHash",
               role,
               virtual_balance as "virtualBalance"
        FROM users
        WHERE email = ${usernameOrEmail} OR username = ${identifier}
        LIMIT 1
      `;

      if (!user) {
        ctx.set.status = 401;
        return { error: "Invalid credentials" };
      }

      let ok = false;
      if (body.password) {
        ok = await verifyPassword(body.password, user.passwordHash);
      } else if (body.accessKey && user.accessKeyHash) {
        ok = await verifyPassword(body.accessKey, user.accessKeyHash);
      }

      if (!ok) {
        ctx.set.status = 401;
        return { error: "Invalid credentials" };
      }

      const token = await ctx.jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role
      });

      await redis.set(`session:active:${token}`, user.id, "EX", 7 * 24 * 60 * 60);

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          virtualBalance: user.virtualBalance
        }
      };
    },
    {
      body: t.Object({
        usernameOrEmail: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
        username: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
        email: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
        password: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
        accessKey: t.Optional(t.String({ minLength: 4, maxLength: 4 }))
      })
    }
  )
  .post("/logout", async (ctx) => {
    try {
      const { token } = await authenticate(ctx as any);
      const payload = await (ctx as any).jwt.verify(token);
      const exp = typeof payload?.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + 3600;
      const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 1);

      await redis.set(`session:blacklist:${token}`, "1", "EX", ttl);
      await redis.del(`session:active:${token}`);

      return { ok: true };
    } catch {
      return { ok: true };
    }
  })
  .get("/me", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    return { user };
  })
  .post(
    "/change-password",
    async (ctx: any) => {
      const { user } = await authenticate(ctx as any);
      const body = ctx.body as any;

      if (body.newPassword !== body.confirmNewPassword) {
        ctx.set.status = 400;
        return { error: "New password and confirm new password do not match." };
      }

      const [row] = await sql<{ passwordHash: string }[]>`
        SELECT password_hash as "passwordHash" FROM users WHERE id = ${user.id}
      `;

      const ok = await verifyPassword(body.currentPassword, row.passwordHash);
      if (!ok) {
        ctx.set.status = 401;
        return { error: "Current password is incorrect." };
      }

      const newHash = await hashPassword(body.newPassword);
      await sql`UPDATE users SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${user.id}`;

      return { ok: true };
    },
    {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 128 }),
        newPassword: t.String({ minLength: 8, maxLength: 128 }),
        confirmNewPassword: t.String({ minLength: 8, maxLength: 128 })
      })
    }
  )
  .post(
    "/change-access-key",
    async (ctx: any) => {
      const { user } = await authenticate(ctx as any);
      const body = ctx.body as any;

      if (!ACCESS_KEY_PATTERN.test(String(body.newAccessKey ?? ""))) {
        ctx.set.status = 400;
        return { error: "Access Key must be exactly 4 digits." };
      }

      if (body.newAccessKey !== body.confirmNewAccessKey) {
        ctx.set.status = 400;
        return { error: "New Access Key and confirm Access Key do not match." };
      }

      const [row] = await sql<{ passwordHash: string }[]>`
        SELECT password_hash as "passwordHash" FROM users WHERE id = ${user.id}
      `;

      const ok = await verifyPassword(body.currentPassword, row.passwordHash);
      if (!ok) {
        ctx.set.status = 401;
        return { error: "Current password is incorrect." };
      }

      const newHash = await hashPassword(body.newAccessKey);
      await sql`UPDATE users SET access_key_hash = ${newHash}, updated_at = NOW() WHERE id = ${user.id}`;

      return { ok: true };
    },
    {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 128 }),
        newAccessKey: t.String({ minLength: 4, maxLength: 4 }),
        confirmNewAccessKey: t.String({ minLength: 4, maxLength: 4 })
      })
    }
  );
