# Invexa — Simulated Stock Exchange Platform

Invexa is a full-stack, real-time virtual stock exchange built for students and educators. It lets users trade synthetic (and real) stocks with virtual money, track portfolio performance, and compete in trading leagues — all in a risk-free environment powered by a live market simulation engine.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Repository Structure](#repository-structure)
4. [Prerequisites](#prerequisites)
5. [Environment Setup](#environment-setup)
6. [Running the Project](#running-the-project)
7. [Verifying the System](#verifying-the-system)
8. [Key API Endpoints](#key-api-endpoints)
9. [Troubleshooting](#troubleshooting)

---

## Project Overview

Invexa simulates a real stock exchange end-to-end:

- A **Python simulator** continuously generates price ticks using configurable strategies (Random Walk, Mean Reversion, Circuit Breaker) and publishes them to **Kafka**.
- A **TypeScript backend** (Bun + Elysia) consumes those ticks, persists them to **TimescaleDB**, caches the latest price in **Redis**, and broadcasts updates to all connected browsers over **WebSocket**.
- Users can place **Market**, **Limit**, and **Stop-Loss** orders. Market orders execute immediately in an ACID database transaction. Limit and stop-loss orders are queued in Redis sorted sets and triggered automatically when the price moves.
- A **React frontend** shows live prices, portfolio P&L, order history, market indexes (Nifty 50, S&P 500, etc.), and leaderboards — all updating in real time.
- **Email notifications** (via Google SMTP) keep users in the loop: a one-time code to verify a new account's email, a follow-up email sharing login details once that account is created, and a receipt-style email every time one of a user's orders fills.

### Core Features

| Feature | Description |
|---------|-------------|
| **Authentication** | Register (with email OTP verification) / Login / Logout with JWT + Redis session blacklist |
| **Email Notifications** | Signup OTP, "account created" credentials email, and trade-execution receipts — all via Gmail SMTP |
| **Live Prices** | WebSocket-streamed price ticks from the Python simulator via Kafka |
| **Market Indexes** | Nifty 50, Sensex, S&P 500, NASDAQ, Dow Jones (Yahoo Finance, 60s cache) |
| **Order Placement** | Market, Limit, Stop-Loss orders with full business-rule validation |
| **Portfolio** | Live holdings, cash balance, unrealised P&L updated on every price tick |
| **Order History** | Paginated trade history with status filters and cancel-pending support |
| **Competition Mode** | Create/join trading competitions with isolated portfolios and leaderboards |
| **Market Events** | Admin-triggered circuit breakers and volatility shocks via Kafka |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, Vite, Zustand, React Query, Recharts |
| **Backend** | Bun runtime, Elysia (TypeScript) |
| **Database** | TimescaleDB (PostgreSQL 15 + time-series extension) |
| **Cache / Pub-Sub** | Redis 7 |
| **Message Bus** | Apache Kafka (KRaft mode — no Zookeeper) |
| **Simulator** | Python 3.11+ (`confluent-kafka`) |
| **ORM** | Drizzle ORM |
| **Auth** | JWT (`@elysiajs/jwt`) + bcrypt |
| **Email** | Nodemailer over Google SMTP |
| **Containerisation** | Docker + Docker Compose |

---

## Repository Structure

```
INVEXA_V1/
│
├── backend/                        # Bun + Elysia API server
│   ├── src/
│   │   ├── index.ts                # Entry point — mounts all route modules
│   │   ├── config/
│   │   │   └── env.ts              # Typed environment variable loader
│   │   ├── modules/                # HTTP route controllers (thin GRASP Controllers)
│   │   │   ├── auth.ts             # POST /auth/register|verify-email|resend-otp|login|logout
│   │   │   ├── market.ts           # GET /stocks, GET /stocks/:ticker/history
│   │   │   ├── orders.ts           # POST|GET|DELETE /orders
│   │   │   ├── portfolio.ts        # GET /portfolio, GET /portfolio/history
│   │   │   ├── competitions.ts     # Full competition CRUD + leaderboard
│   │   │   └── indexes.ts          # GET /indexes (Yahoo Finance + Redis cache)
│   │   ├── domain/                 # Business logic — framework-independent
│   │   │   ├── orders/
│   │   │   │   ├── factory.ts      # Factory Method + Template Method: MarketOrder, LimitOrder, StopLossOrder
│   │   │   │   ├── validator.ts    # SRP: all order validation rules
│   │   │   │   ├── executor.ts     # ACID transaction: balance + holdings + order status + trade email
│   │   │   │   └── priceResolver.ts# Chain of Responsibility: Redis → DB → Yahoo → default
│   │   │   ├── portfolio/
│   │   │   │   └── portfolioService.ts  # Information Expert: P&L computation
│   │   │   └── market/
│   │   │       └── adapter.ts      # Adapter: IMarketDataAdapter → YahooFinanceAdapter
│   │   ├── lib/                    # Infrastructure adapters
│   │   │   ├── auth.ts             # Facade: JWT verify + Redis blacklist + user lookup
│   │   │   ├── mailer.ts           # Nodemailer/Gmail SMTP: OTP, account-created, and trade emails
│   │   │   ├── db.ts               # Drizzle ORM + TimescaleDB connection
│   │   │   ├── redis.ts            # Redis client + pub/sub helpers
│   │   │   ├── kafka.ts            # Kafka producer/consumer setup
│   │   │   ├── priceCache.ts       # getLivePrice(): Redis → Yahoo fallback
│   │   │   └── wsHub.ts            # Observer: WebSocket broadcast hub
│   │   ├── workers/                # Background Kafka consumers
│   │   │   ├── priceTicksConsumer.ts   # Kafka price.ticks → DB + Redis + WS broadcast + order triggers
│   │   │   ├── ordersConsumer.ts       # Kafka orders.placed → executePendingOrder()
│   │   │   └── realMarketWorker.ts     # Polls Yahoo Finance for real tickers → price.ticks
│   │   ├── db/
│   │   │   ├── schema.ts           # Drizzle schema: users, orders, holdings, price_ticks, competitions
│   │   │   └── bootstrapSchema.ts  # Idempotent `ALTER TABLE IF NOT EXISTS` migrations run at boot
│   │   └── types/                  # Shared TypeScript types
│   ├── drizzle/                    # Auto-generated Drizzle migrations
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/                       # React + Vite single-page app
│   ├── src/
│   │   ├── main.tsx                # App entry point
│   │   ├── App.tsx                 # Root component + routing + layout
│   │   ├── api/
│   │   │   └── client.ts           # Facade: apiFetch() — base URL, auth header, error handling
│   │   ├── components/             # UI components
│   │   │   ├── AuthPage.tsx        # Login/register UI, including the email-OTP verification step
│   │   │   ├── IndexTicker.tsx     # Horizontal scrolling live index bar
│   │   │   ├── PriceTable.tsx      # Live stock price table
│   │   │   ├── OrderForm.tsx       # BUY/SELL order placement form
│   │   │   ├── OrderHistory.tsx    # Filterable order list + cancel button
│   │   │   ├── PortfolioCard.tsx   # Holdings tab + Trade history tab + analytics chart
│   │   │   ├── CompetitionBoard.tsx# Competition leaderboard
│   │   │   └── ProfilePanel.tsx    # User profile + account metrics
│   │   ├── hooks/
│   │   │   └── usePriceSocket.ts   # WebSocket hook — Observer: updates Zustand store on each tick
│   │   ├── store/
│   │   │   ├── marketStore.ts      # Zustand: live price state
│   │   │   └── authStore.ts        # Zustand: user session state, incl. register/verifyEmail/resendOtp
│   │   └── styles.css              # Global styles
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
├── sim/                            # Python market simulator (standalone process)
│   ├── app/
│   │   ├── main.py                 # Entry point: generates ticks every 1s, publishes to Kafka
│   │   ├── strategies.py           # Price strategies: RandomWalk, MeanReversion, CircuitBreaker, UserInfluence
│   │   └── config.py               # Simulator config: tickers, volatility, interval
│   ├── requirements.txt            # confluent-kafka, python-dotenv
│   └── Dockerfile
│
├── infra/
│   ├── kafka/
│   │   └── init.sh                 # Creates Kafka topics on first boot:
│   │                               #   price.ticks, orders.placed, orders.filled,
│   │                               #   sim.control, competition.events
│   └── timescaledb/
│       └── init/
│           └── 01_schema.sql       # DB init: extensions, tables, hypertable (price_ticks),
│                                   #   continuous aggregates (ohlc_1m, ohlc_5m), indexes
│
├── scripts/
│   ├── bootstrap.sh                # Linux/macOS: installs backend + frontend + sim dependencies
│   └── bootstrap.ps1               # Windows (PowerShell): same as above
│
├── docker-compose.yml              # Orchestrates: timescaledb, redis, kafka, kafka-init, backend, sim
├── .env.example                    # Template for all required environment variables — copy this to .env
├── REPORT.md                       # SE project report (Tasks 1–4)
└── README.md                       # This file
```

---

## Prerequisites

Install the following on every developer machine:

| Tool | Version | Purpose |
|------|---------|---------|
| **Docker Desktop** | Latest | Runs TimescaleDB, Redis, Kafka (and optionally the backend/sim) |
| **Bun** | v1.1+ | Runs and builds the backend (only needed if running it *outside* Docker) |
| **Node.js** | v20+ | Runs the frontend (Vite dev server) |
| **Python** | v3.11+ | Runs the simulator (only needed if running it *outside* Docker) |
| **A Google account** | — | To send email via Gmail SMTP (OTP / credentials / trade emails) |

> **Docker Desktop must actually be running**, not just installed. Open it from Applications/Spotlight and wait for the whale icon in the menu bar before running any `docker` command — otherwise you'll hit `Cannot connect to the Docker daemon`.

---

## Environment Setup

### 1. Clone the repository

```bash
git clone https://github.com/deepsarda25/INVEXA_V1.git
cd INVEXA_FINAL_VERSION
```

### 2. Create your `.env` file

There is **no `.env` file in the repo** — only a template called `.env.example`. You create the real one yourself, **once**:

```bash
# Linux / macOS
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

> ⚠️ **Only run this `cp`/`Copy-Item` command once.** Running it again later will silently overwrite `.env` and wipe out any values you've already filled in (like your SMTP password). If you need to reset `.env` on purpose, back up your real values first.

### 3. Fill in the values that matter

Open `.env` in any text editor (`nano .env`, `code .env`, `open -e .env`, etc.) and set these:

```env
# Auth — make up any long random string, it isn't tied to any account
JWT_SECRET=replace_with_a_long_random_secret

# Database / Redis / Kafka — the defaults already match docker-compose.yml,
# you normally don't need to touch these for local development
DATABASE_URL=postgres://invexa:invexa_password@localhost:5432/invexa
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9094

# Frontend
CORS_ORIGIN=http://localhost:5173

# Email (Google SMTP) — see the dedicated section below
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=venture.global.info@gmail.com
SMTP_PASS=replace_with_a_gmail_app_password
MAIL_FROM="Invexa <venture.global.info@gmail.com>"
```

#### Setting up Gmail SMTP (`SMTP_PASS`)

Email (OTP codes, the account-created message, trade receipts) is sent through Gmail SMTP. **A normal Gmail password will not work here** — Google requires a separate **App Password** for SMTP logins:

1. Sign in to the Google account you want to send from (e.g. `venture.global.info@gmail.com`).
2. Turn on **2-Step Verification** if it isn't already: https://myaccount.google.com/security
3. Go to https://myaccount.google.com/apppasswords and create a new App Password (name it e.g. "Invexa SMTP").
4. Google shows you a 16-character code like `abcd efgh ijkl mnop`. Copy it **without spaces**: `abcdefghijklmnop`.
5. Put it in `.env` on the `SMTP_PASS=` line:
   ```
   SMTP_PASS=abcdefghijklmnop
   ```

You can also do this from the terminal instead of a text editor, from the `INVEXA_V1` root:

```bash
sed -i '' 's/SMTP_PASS=replace_with_a_gmail_app_password/SMTP_PASS=abcdefghijklmnop/' .env
```
(macOS's `sed` needs the `-i ''`; on Linux, drop the empty quotes: `sed -i 's/.../.../' .env`.)

Verify it saved:
```bash
grep SMTP_PASS .env
```

**Running without email set up:** if you leave `SMTP_HOST` unset (or the whole block untouched with the placeholder password), the app doesn't crash — signup, OTP, and trade emails are simply skipped and logged to the console instead of sent. This is fine for local development when you don't need real emails.

### 4. Install dependencies (only needed if running things outside Docker)

```bash
# Linux / macOS
chmod +x scripts/bootstrap.sh
./scripts/bootstrap.sh

# Windows (PowerShell)
./scripts/bootstrap.ps1
```

This runs:
- `bun install` inside `backend/`
- `npm install` inside `frontend/`
- Creates a Python virtualenv inside `sim/.venv` and installs `requirements.txt`

---

## Running the Project

There are two ways to run the system. If you're not sure which to pick, use **Mode B** — it's the simplest, since Docker handles the database/queue/backend for you and you only run the frontend yourself.

---

### Mode A — Recommended for Active Development

Runs infrastructure (DB, Redis, Kafka) in Docker, and the app services (backend, simulator, frontend) locally for fast iteration.

#### Step 1: Start infrastructure

```bash
docker compose up -d timescaledb redis kafka kafka-init
```

Wait ~10 seconds for Kafka to finish initialising topics.

#### Step 2: Start the backend

```bash
cd backend
bun run dev
```

The API server starts at **http://localhost:3000**.

#### Step 3: Start the simulator

```bash
# Linux / macOS
cd sim
./.venv/bin/python -m app.main

# Windows (PowerShell)
cd sim
.\.venv\Scripts\python -m app.main
```

You should see tick logs like:
```
Published FAKE @ 150.25 → price.ticks
Published TSIM @ 95.50  → price.ticks
```

#### Step 4: Start the frontend

```bash
cd frontend
npm run dev
```

The dashboard is available at **http://localhost:5173**.

---

### Mode B — Everything in Docker (simplest)

Starts backend and simulator in Docker alongside the infrastructure. You only run the frontend yourself.

Make sure Docker Desktop is open and running first, then from the `INVEXA_V1` root:

```bash
docker compose up
```

(Add `-d` to run it in the background instead of tying up your terminal: `docker compose up -d`.)

First run takes a few minutes while images build/download. Leave that terminal open (unless you used `-d`).

Then, in a **new** terminal tab/window, start the frontend (it is not containerised):

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

**To stop everything:**

```bash
docker compose down

# To also wipe all data volumes (fresh start — new DB, no existing users):
docker compose down -v
```

**After changing `.env`** (e.g. adding your SMTP password), Docker Compose needs a restart to pick it up:

```bash
docker compose down
docker compose up
```

---

## Verifying the System

Once all services are running, run these checks:

### 1. Backend health check

```bash
curl http://localhost:3000/health
# Expected: { "status": "ok" }
```

### 2. Register a user (and verify the email flow)

`POST /auth/register` does **not** create the account directly — it emails a 6-digit code to the given address and holds the signup in Redis for 10 minutes. The account is only created once that code is confirmed via `POST /auth/verify-email`, which also returns the login token and triggers the "account created" credentials email.

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","email":"demo@example.com","password":"demopass123","confirmPassword":"demopass123","accessKey":"1234","confirmAccessKey":"1234"}'
# -> { "pendingVerification": true, "email": "demo@example.com", ... }
# If SMTP isn't configured, the response also includes "devOtp" so you can test without real email.

curl -X POST http://localhost:3000/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","otp":"123456"}'
# -> { "token": "...", "user": { ... } }  — account now exists, credentials email sent.
```

A wrong code can be retried up to 5 times before the signup must restart; `POST /auth/resend-otp` (rate-limited to once per 45s) sends a fresh code for the same email.

Once the account exists, every filled order (see `/orders` below) also triggers a trade-receipt email, e.g. *"Bought 50 share(s) of MRF.NS at ₹123.00 per share."*

### 3. Check live stock prices

```bash
curl http://localhost:3000/stocks
```

If the simulator is running, prices should be changing each second.

### 4. Open the dashboard

Visit **http://localhost:5173** — you should see the live index ticker bar updating and stock prices streaming in real time. Try registering through the UI with a real email address to confirm the OTP email actually arrives.

---

## Key API Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/auth/register` | Start signup — sends an email OTP, doesn't create the account yet | No |
| `POST` | `/auth/verify-email` | Confirm the OTP — creates the account, returns a token, sends credentials email | No |
| `POST` | `/auth/resend-otp` | Resend the OTP for a pending signup (max once per 45s) | No |
| `POST` | `/auth/login` | Get JWT token | No |
| `POST` | `/auth/logout` | Invalidate token | Yes |
| `GET` | `/stocks` | List all tickers with current price | No |
| `GET` | `/stocks/:ticker/history` | OHLC price history (`?range=1mo\|3mo\|1y`) | No |
| `GET` | `/indexes` | Live market indexes (Nifty, S&P 500, etc.) | No |
| `POST` | `/orders` | Place a market / limit / stop-loss order (fills trigger a trade email) | Yes |
| `GET` | `/orders` | List user's orders (`?status=&ticker=`) | Yes |
| `DELETE` | `/orders/:id` | Cancel a pending order | Yes |
| `GET` | `/portfolio` | Live holdings + cash + unrealised P&L | Yes |
| `GET` | `/portfolio/history` | Paginated trade history | Yes |
| `GET` | `/competitions` | List public competitions | Yes |
| `POST` | `/competitions` | Create a competition | Yes |
| `POST` | `/competitions/:id/join` | Join a competition | Yes |
| `GET` | `/competitions/:id/leaderboard` | Get current rankings | Yes |
| `WS` | `/ws/prices` | WebSocket stream of live price ticks | No |

---

## Troubleshooting

### `Cannot connect to the Docker daemon`

Docker Desktop isn't actually running — having it installed isn't enough. Open it from Applications/Spotlight, wait for the whale icon in the menu bar to say it's running, then retry.

### My `.env` values keep resetting to placeholders

You (or a script) re-ran `cp .env.example .env`, which fully overwrites `.env`. Only run that command **once**, when you first set things up. If it happens again, just redo the edits — nothing else is broken.

### I don't see `.env` in the folder

It's hidden by default. On macOS, `ls -a` in the terminal shows it; in Finder, press `Cmd+Shift+.`. On Windows, enable "Show hidden files" in File Explorer's View tab. It's also not included if you downloaded a zip of this repo — only `.env.example` is; you must create `.env` yourself (Step 2 above).

### Signup emails aren't arriving

1. Confirm `SMTP_PASS` in `.env` is a real Gmail **App Password**, not your regular Gmail password or the placeholder text: `grep SMTP_PASS .env`
2. Confirm you restarted the backend / `docker compose` after editing `.env` — it only reads the file at startup.
3. Check backend logs for `[mailer]` lines — if SMTP isn't configured it logs a one-time skip warning instead of failing silently.
4. Check the Gmail account's **Sent** folder and the recipient's spam folder.

### Prices not updating on the dashboard

1. Check the simulator is running and logging tick publications.
2. Verify the Kafka topic exists:
   ```bash
   docker exec -it invexa-kafka bash -lc \
     "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list"
   ```
3. Check the backend logs for `priceTicksConsumer` errors:
   ```bash
   # If running locally:
   # Look at terminal output of `bun run dev`

   # If running in Docker:
   docker logs invexa-backend --tail 50
   ```

### Kafka connection errors

- When running app services **locally**, use `KAFKA_BROKERS=localhost:9094` in `.env`.
- When running backend **inside Docker**, use `KAFKA_BROKERS=kafka:9092` (already set in `docker-compose.yml`).

### Frontend cannot reach the backend

- Confirm the backend is actually running (`curl http://localhost:3000/health`).
- Confirm the backend's `CORS_ORIGIN` in `.env` includes `http://localhost:5173`.

### Database errors on first boot

The TimescaleDB init script runs once on first container creation. If the schema is inconsistent:

```bash
docker compose down -v          # wipes volumes
docker compose up -d timescaledb redis kafka kafka-init
```

### Orders placed but never fill (limit/stop-loss)

Check Redis sorted sets to confirm the order was queued:

```bash
docker exec -it invexa-redis redis-cli
> ZRANGE limits:buy:FAKE 0 -1 WITHSCORES
```

If the key is empty, the order was not queued — check `orders.ts` route logs for validation errors.