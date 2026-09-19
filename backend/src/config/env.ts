import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const loadEnvFile = (path: string) => {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    // Strip a matching pair of surrounding quotes. dotenv-style files
    // routinely quote values that contain spaces — e.g.
    //   MAIL_FROM="Invexa <no-reply@invexa.app>"
    // and without this the quotes became *part of the value*, producing a
    // literal `"Invexa <no-reply@invexa.app>"` From header. SMTP servers
    // (Gmail included) reject that as a malformed address, which silently
    // killed every outgoing email. Also drop a trailing \r so CRLF-saved
    // .env files (common on Windows) don't poison values the same way.
    let value = line.slice(separatorIndex + 1).trim().replace(/\r$/, "");
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
};

loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "..", ".env"));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().min(16).default("replace_with_a_long_random_secret"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z.string().default("localhost:9094"),
  KAFKA_CLIENT_ID: z.string().default("invexa-backend"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // WebAuthn (fingerprint / platform biometric) settings.
  // RP_ID must be the bare hostname (no scheme/port) the frontend is served from.
  WEBAUTHN_RP_ID: z.string().default("localhost"),
  WEBAUTHN_RP_NAME: z.string().default("Invexa"),
  // Comma-separated list of origins allowed to complete a WebAuthn ceremony.
  // Defaults to CORS_ORIGIN so it "just works" in dev without extra config.
  WEBAUTHN_ORIGIN: z.string().optional(),
  SIM_CONTROL_TOPIC: z.string().default("sim-control"),
  PRICE_TICKS_TOPIC: z.string().default("price-ticks"),
  ORDERS_PLACED_TOPIC: z.string().default("orders-placed"),
  ORDERS_FILLED_TOPIC: z.string().default("orders-filled"),
  COMPETITION_EVENTS_TOPIC: z.string().default("competition-events"),
  REAL_TICKERS: z.string().default("RELIANCE.NS,TCS.NS,HDFCBANK.NS,INFY.NS"),
  REAL_TICKER_INTERVAL: z.coerce.number().default(10000),
  // Transaction email notifications. Left unset, the app runs fine and
  // simply skips sending mail (logged once) — nothing else depends on this.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  // Left unset, this is derived from the port below (465 = implicit TLS,
  // everything else = STARTTLS). Setting `secure: false` against port 465
  // is the single most common SMTP misconfiguration — the connection hangs
  // until it times out rather than failing fast with a useful error.
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Invexa <no-reply@invexa.app>"),
  // Verify SMTP credentials at boot and log the result, instead of only
  // finding out an email is undeliverable when a user tries to sign up.
  MAIL_VERIFY_ON_BOOT: z
    .string()
    .optional()
    .transform((v) => v !== "false")
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  // Belt-and-braces: even if the value reached us from a real environment
  // variable (docker-compose, a shell export) rather than our own .env
  // parser, strip stray wrapping quotes before it becomes a From header.
  MAIL_FROM: parsed.MAIL_FROM.replace(/^["'](.*)["']$/, "$1"),
  SMTP_SECURE: parsed.SMTP_SECURE === undefined ? parsed.SMTP_PORT === 465 : parsed.SMTP_SECURE === "true",
  kafkaBrokers: parsed.KAFKA_BROKERS.split(",").map((b) => b.trim()).filter(Boolean),
  webauthnOrigins: (parsed.WEBAUTHN_ORIGIN ?? parsed.CORS_ORIGIN)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
};
