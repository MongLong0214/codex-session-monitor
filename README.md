# Agent Session Monitor

A local-only operations dashboard for watching and lightly controlling AI coding-agent sessions — **Codex CLI** and **Claude Code** — running on your own machine. One page, real-time, no login, no server beyond `127.0.0.1`.

It reads Codex's local SQLite state DB and Claude Code's local JSONL session transcripts directly off disk, cross-references live OS processes, and never talks to any external service beyond the AI provider APIs those CLIs already use on their own. Nothing here requires an account, a cloud backend, or your session data leaving your machine.

## Why

Running several Codex/Claude Code sessions across several projects at once makes it easy to lose track of what's actually happening: which session failed, which is stuck waiting, which one is quietly burning tokens. This dashboard puts all of it in one table, sorted worst-first, updated in real time.

## Features

- **Multi-source** — Codex CLI and Claude Code sessions in one unified, virtualized table, each row tagged with its real source.
- **Real-time** — initial state over HTTP, incremental updates over Server-Sent Events, with reconnect/backoff, sequence-gap detection, and automatic resync on reconnect. Not client-side polling.
- **Built for scale** — TanStack Table + Virtual, sticky core columns, resizable columns, compact/comfortable density, roving-tabindex keyboard navigation, bulk selection and bulk actions. Row updates are reference-isolated: one agent changing never re-renders another agent's row.
- **Detail panel** — Overview / Logs / Changes tabs per agent, resizable 380–520px, with a real (paginated, tail-bounded) log view backed by each source's own transcript format.
- **Real cost, only where it's real** — Claude Code sessions carry real per-message token usage, priced against Anthropic's actual published rates. Codex sessions show `—` for cost, because Codex's local state genuinely has no pricing data. Nothing here is a guessed number, and neither is the progress column: there's no percent-complete signal from either tool, so it's an honest indeterminate indicator, never a fabricated percentage.
- **Honest action set** — Stop, Pause/Resume (OS-level `SIGTERM`/`SIGSTOP`/`SIGCONT`), Open Terminal, View Diff, Create/Open PR are real. Retry, Approve, and Reject are disabled with the actual reason shown: this tool observes externally-launched sessions read-only and has no stdin/PTY channel into them.
- **Command palette** (`Cmd/Ctrl+K`) — search agents, projects, and branches; open a detail panel; act on whichever agent's panel is open; change theme or density. `/` focuses the table search directly.
- **Persisted, per-device UI state** — theme, density, column layout, filters, and sort survive a reload via localStorage, validated and versioned so a corrupted or stale value never breaks the dashboard.
- **Local-only security** — binds `127.0.0.1` only, validates `Host`/`Origin` on every request (DNS-rebinding aware), every child process call uses `execFile` with an argument array (never a shell string), every filesystem path is canonicalized and checked against the tool's own live snapshot before use.
- **Accessible** — semantic HTML throughout, no incomplete ARIA grid, verified with `@axe-core/playwright` against the loaded dashboard and the open detail panel (zero violations), real keyboard-navigation and light/dark contrast checks.

## Getting started

### Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 11 (via Corepack)
- macOS — process discovery uses `ps`/`lsof`, and Codex reads shell out to the `sqlite3` CLI
- [Codex CLI](https://github.com/openai/codex) and/or [Claude Code](https://claude.com/claude-code), used at least once, so there's real local session data to show

### Install & run

```bash
corepack enable
pnpm install
pnpm dev
```

Open the local address printed in the terminal (`http://127.0.0.1:3000` by default). The dashboard reflects whatever Codex/Claude Code sessions are actually on your machine — there's no seed data to load, and nothing to configure.

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Start the dev server (Turbopack, bound to `127.0.0.1`) |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build (bound to `127.0.0.1`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (flat config) |
| `pnpm test:vitest` | Unit + component tests (Vitest + React Testing Library) |
| `pnpm test:e2e` | Playwright end-to-end tests, including accessibility checks |
| `pnpm astryx` | Astryx design-system CLI (component docs, tokens, themes) |

## Architecture

```
src/
  app/                 Next.js App Router: pages + API route handlers
  domain/              Zod schemas + inferred types — the single source of truth for shapes
  data-access/         Codex adapter, Claude Code adapter, mock adapter, command execution
  lib/query/           Normalized TanStack Query cache + realtime event reducer
  lib/realtime/        SSE transport (reconnect, backoff, sequence-gap detection)
  lib/settings/        localStorage-backed persisted UI settings
  features/dashboard/  App shell, operations table, detail panel, command palette
```

- **Server state** lives entirely in a normalized TanStack Query cache (`byId` / `allIds` / `summary`), kept in sync by a pure, reference-preserving reducer applying realtime events — an update to one agent never re-renders rows for every other agent.
- **Initial load** is a plain HTTP snapshot (`GET /api/dashboard/snapshot`); **live updates** arrive over SSE (`GET /api/dashboard/events`) as a poll-and-diff bridge — Codex and Claude Code have no push capability of their own, so this is an honest adaptation, not a simulated one; **commands** are plain HTTP POSTs (`POST /api/agents/[agentId]/actions`, `POST /api/agents/bulk-actions`).
- **UI** is built on [Astryx](https://astryx.atmeta.com) (Neutral theme) for the app shell, navigation, forms, dialogs, and overlays, plus [TanStack Table](https://tanstack.com/table) + [TanStack Virtual](https://tanstack.com/virtual) for the operations table specifically — Astryx's own `Table` component is meant for small, non-virtualized data and isn't used for the main table.
- **Local UI state** (selection, open panels, dialog state) lives in plain React state; **persisted settings** (theme, density, columns, filters, sort) live in a `useSyncExternalStore`-backed localStorage hook — the two are never mixed into the same object.

## Known limitations

- **No progress percentage.** Neither Codex nor Claude Code expose a percent-complete signal. The progress indicator shows indeterminate while running and full when complete — never a fabricated number.
- **Codex cost is always `—`.** Codex's local state has no pricing data. This is expected, not a bug.
- **Process control for Claude Code sessions is limited.** Claude Code sessions have no reliable OS-process correlation in most environments, so Stop/Pause/Resume are only available for agents with a real, observed PID (in practice, usually Codex-sourced ones).
- **Retry/Approve/Reject never do anything.** This tool is a read-only observer of externally-launched sessions; there is no control channel to send these, so they're disabled with the reason shown rather than offered as a false promise.
- **macOS only**, currently — process discovery depends on `ps`/`lsof`.

## Security model

This is a single-user local tool, not a multi-tenant service — there is deliberately no login, no accounts, no roles. Safety instead comes from:

- Binding `127.0.0.1` only, never `0.0.0.0`
- Rejecting requests whose `Host`/`Origin` don't resolve to loopback (DNS-rebinding aware)
- Never building a shell command from a string — always `execFile` with an argument array
- Canonicalizing every filesystem path and checking it against the tool's own live snapshot before touching it
- Every request body validated with Zod before it reaches any handler logic

## License

No license file yet — treat as all-rights-reserved until one is added.
