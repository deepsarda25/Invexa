import nodemailer from "nodemailer";
import { env } from "../config/env";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
let warnedMissingConfig = false;

/**
 * Raised when an email we actually *depend on* (currently: the signup OTP)
 * could not be handed off to the mail server. Distinct from a plain Error so
 * callers can tell "mail is broken" apart from "the user did something
 * invalid" and respond with the right status code and message.
 */
export class MailDeliveryError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MailDeliveryError";
    this.cause = cause;
  }
}

/** True when SMTP is configured at all. Used to gate dev-only OTP fallbacks. */
export function isMailConfigured() {
  return Boolean(env.SMTP_HOST);
}

function getTransporter() {
  if (!env.SMTP_HOST) {
    if (!warnedMissingConfig) {
      console.warn(
        "[mailer] SMTP_HOST is not set — transaction emails will be skipped. " +
          "Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS to enable them."
      );
      warnedMissingConfig = true;
    }
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      // Without explicit timeouts, an unreachable or firewalled SMTP host
      // leaves the socket hanging for the OS default (~2 minutes), which in
      // practice meant the signup request appeared to freeze rather than
      // report a problem. Fail fast instead.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      // Port 587 starts plaintext and upgrades. Insist on that upgrade
      // whenever we have credentials to protect, so a password is never
      // sent in the clear. Local catch-all servers (Mailpit, MailHog,
      // maildev) take no auth and advertise no STARTTLS, so requiring it
      // unconditionally would break every developer's setup for no gain.
      requireTLS: !env.SMTP_SECURE && Boolean(env.SMTP_USER)
    });
  }

  return transporter;
}

/**
 * Drops the cached transporter so the next send rebuilds the connection
 * pool from scratch. Without this, one failed handshake could leave a dead
 * transport cached for the lifetime of the process.
 */
function resetTransporter() {
  try {
    transporter?.close();
  } catch {
    // Closing a already-broken transport is best-effort.
  }
  transporter = null;
}

/**
 * verifyMailer — one-shot startup check of host/port/credentials. Logs a
 * clear, actionable diagnosis instead of leaving a misconfiguration to be
 * discovered by the first user who tries to sign up. Never throws: a mail
 * outage must not stop the API from booting.
 */
export async function verifyMailer() {
  if (!env.SMTP_HOST) {
    console.warn("[mailer] SMTP is not configured — signup OTP emails are disabled.");
    return false;
  }

  const client = getTransporter();
  if (!client) return false;

  try {
    await client.verify();
    console.log(`[mailer] SMTP ready — ${env.SMTP_HOST}:${env.SMTP_PORT} (secure=${env.SMTP_SECURE}) as "${env.MAIL_FROM}"`);
    return true;
  } catch (err) {
    resetTransporter();
    console.error(
      `[mailer] SMTP verification FAILED for ${env.SMTP_HOST}:${env.SMTP_PORT} (secure=${env.SMTP_SECURE}).`,
      describeMailError(err)
    );
    return false;
  }
}

/**
 * Turns nodemailer's low-level error codes into something a developer can
 * act on without reading the SMTP RFCs.
 */
export function describeMailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const detail = e?.message ?? String(err);

  if (e?.code === "EAUTH" || e?.responseCode === 535) {
    return (
      `Authentication rejected. For Gmail, SMTP_PASS must be a 16-character App Password ` +
      `(https://myaccount.google.com/apppasswords) with 2-Step Verification enabled — a normal ` +
      `account password will always be rejected. Original: ${detail}`
    );
  }
  if (e?.code === "ETIMEDOUT" || e?.code === "ESOCKET" || e?.code === "ECONNECTION") {
    return (
      `Could not reach the mail server. Check SMTP_HOST/SMTP_PORT and that outbound SMTP isn't ` +
      `blocked, and make sure SMTP_SECURE matches the port (465 = true, 587 = false). Original: ${detail}`
    );
  }
  if (e?.code === "EENVELOPE") {
    return `The mail server rejected the envelope — check MAIL_FROM is a bare address like Invexa <you@gmail.com> with no surrounding quotes. Original: ${detail}`;
  }
  return detail;
}

/**
 * sendMail — delivers an email.
 *
 * By default this is fire-and-forget and never throws: a slow or
 * misconfigured mail server must not fail (or even delay) the operation
 * that triggered the email — e.g. an order fill.
 *
 * Pass `critical: true` for mail the user is actively waiting on (the
 * signup OTP). Those failures throw `MailDeliveryError` so the caller can
 * tell the user the truth instead of claiming a code was sent that never
 * was.
 */
export async function sendMail(
  opts: { to: string; subject: string; text: string; html?: string },
  options: { critical?: boolean } = {}
) {
  const client = getTransporter();

  if (!client) {
    if (options.critical) {
      throw new MailDeliveryError(
        "Email delivery is not configured on the server, so we can't send your verification code. Please contact support."
      );
    }
    return;
  }

  try {
    await client.sendMail({
      from: env.MAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html
    });
  } catch (err) {
    console.error("[mailer] Failed to send email:", describeMailError(err));
    resetTransporter();

    if (options.critical) {
      throw new MailDeliveryError(
        "We couldn't send the verification email right now. Please double-check the address and try again in a moment.",
        err
      );
    }
  }
}

function inr(n: number) {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * sendTransactionEmail — notifies a user by email whenever one of their
 * orders fills, e.g. "Bought 50 share(s) of CUPID.NS at ₹290.00 per share."
 */
export async function sendTransactionEmail(params: {
  to: string;
  username: string;
  side: "buy" | "sell";
  ticker: string;
  quantity: number;
  price: number;
}) {
  const { to, username, side, ticker, quantity, price } = params;
  const verb = side === "buy" ? "Bought" : "Sold";
  const total = quantity * price;

  const headline = `${verb} ${quantity} share(s) of ${ticker} at ${inr(price)} per share.`;

  const text = `Hi ${username},

${headline}
Total ${side === "buy" ? "cost" : "proceeds"}: ${inr(total)}

This is an automated notification from Invexa — no action is needed.`;

  const html = `
    <p>Hi ${escapeHtml(username)},</p>
    <p style="font-size:16px;"><strong>${escapeHtml(headline)}</strong></p>
    <p>Total ${side === "buy" ? "cost" : "proceeds"}: <strong>${escapeHtml(inr(total))}</strong></p>
    <p style="color:#8c90a3;font-size:13px;">This is an automated notification from Invexa — no action is needed.</p>
  `;

  await sendMail({
    to,
    subject: `Invexa: ${verb} ${ticker} — order filled`,
    text,
    html
  });
}

/**
 * sendOtpEmail — sends the 6-digit verification code a new user must enter
 * to prove they own the email address they registered with.
 */
export async function sendOtpEmail(params: { to: string; username: string; otp: string; expiresInMinutes: number }) {
  const { to, username, otp, expiresInMinutes } = params;

  const text = `Hi ${username},

Your Invexa email verification code is: ${otp}

This code expires in ${expiresInMinutes} minutes. Enter it in the app to finish creating your account.

If you didn't try to create an Invexa account, you can safely ignore this email.`;

  const html = `
    <p>Hi ${escapeHtml(username)},</p>
    <p>Your Invexa email verification code is:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:0.3em;margin:16px 0;">${escapeHtml(otp)}</p>
    <p>This code expires in <strong>${expiresInMinutes} minutes</strong>. Enter it in the app to finish creating your account.</p>
    <p style="color:#8c90a3;font-size:13px;">If you didn't try to create an Invexa account, you can safely ignore this email.</p>
  `;

  await sendMail(
    {
      to,
      subject: `${otp} is your Invexa verification code`,
      text,
      html
    },
    // The user is staring at a "enter the code we emailed you" screen — if
    // this didn't actually leave the building, they must be told.
    { critical: true }
  );
}

/**
 * sendAccountCreatedEmail — confirms account creation once the email has
 * been verified, and shares the login credentials the user will need.
 *
 * Deliberately never includes the plaintext password: the user chose and
 * already knows it, and emailing passwords back is bad practice even for a
 * paper-trading app. The Access Key (a 4-digit PIN designed as an
 * alternate login credential) is included instead, since sharing that is
 * the whole point of this email.
 */
export async function sendAccountCreatedEmail(params: {
  to: string;
  username: string;
  email: string;
  accessKey: string;
}) {
  const { to, username, email, accessKey } = params;

  const text = `Hi ${username},

Your Invexa account has been created and your email is verified.

Username: ${username}
Email: ${email}
Access Key (PIN login): ${accessKey}

You can sign in with your username/email plus either your password or this Access Key.
For security, we don't include your password in this email — use the one you chose at signup.

This is an automated notification from Invexa.`;

  const html = `
    <p>Hi ${escapeHtml(username)},</p>
    <p>Your Invexa account has been created and your email is verified.</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 12px 4px 0;color:#8c90a3;">Username</td><td><strong>${escapeHtml(username)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#8c90a3;">Email</td><td><strong>${escapeHtml(email)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#8c90a3;">Access Key (PIN login)</td><td style="letter-spacing:0.2em;"><strong>${escapeHtml(accessKey)}</strong></td></tr>
    </table>
    <p>You can sign in with your username/email plus either your password or this Access Key.</p>
    <p style="color:#8c90a3;font-size:13px;">For security, we don't include your password in this email — use the one you chose at signup.</p>
    <p style="color:#8c90a3;font-size:13px;">This is an automated notification from Invexa.</p>
  `;

  await sendMail({
    to,
    subject: "Welcome to Invexa — your account is ready",
    text,
    html
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
