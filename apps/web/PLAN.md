# Web UI — Implementation Plan

## Overview

**Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS** + **shadcn/ui** frontend for omega-stream. Mobile-first responsive design — built for phone browsers and desktop from the start. Deployed to **ECS Fargate** (SSR) behind **ALB + CloudFront** — SSR is required for SSE real-time updates and auth; ECS is consistent with the rest of the stack and avoids Lambda timeout/streaming limitations of Amplify Hosting.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | Latest release, React 19, Turbopack |
| UI Components | shadcn/ui | Radix-based, accessible, Tailwind-styled, source-owned |
| Styling | Tailwind CSS | Utility-first, dark mode via `dark:` classes |
| Data Fetching | TanStack Query | Client-side caching, mutations, optimistic updates |
| Server Components | For initial page loads | Outputs list, stream setup — static-ish data |
| Forms | react-hook-form + zod | shadcn Form integration, matches API validation schemas |
| Theming | next-themes | Dark default, system/light/dark toggle |
| API Client | Typed fetch wrapper | Thin `api/` module, no extra dependencies |
| Testing | vitest + React Testing Library | Integration tests on critical flows |

---

## Authentication

- **Both tokens as httpOnly cookies** (requires small API change — access token currently returned in JSON body)
- Access token (15min) + refresh token (7-day), both set as httpOnly, secure, sameSite: strict cookies
- Next.js middleware reads the access token cookie to gate authenticated routes and redirects to `/login` if missing/expired
- Server components can forward cookies to the API for SSR data fetching
- No client-side token storage — cookies flow automatically

---

## Routing & Layout

**Route groups:**
- `(auth)/` — login, register. Clean centered layout, no nav.
- `(app)/` — dashboard, outputs, stream-setup, logs. Authenticated shell with navigation.
- `/` redirects to `/dashboard`

**Navigation:**
- **Desktop:** sidebar with page links + user menu (avatar dropdown with logout)
- **Mobile:** bottom tab bar — Dashboard, Outputs, Stream Setup, Logs (4 tabs, always visible, thumb-friendly)

---

## Pages

### Dashboard (`(app)/dashboard`)
- **Hero banner** — overall stream state: "LIVE" with duration timer, or "OFFLINE"
- **Output cards** — grid below hero, each card shows: platform icon, name, status badge (live/error/stopped), current bitrate, last error if any. "View logs" shortcut link per card.
- **Offline state** — last session summary (duration, peak bitrate), CTAs to configure outputs or copy stream key. Page is never empty.
- **Real-time** — SSE connection for live bitrate, status changes, per-output health

### Outputs (`(app)/outputs`)
- **Card grid** — browse outputs as cards with platform icon, name, enabled/disabled badge, RTMP URL (masked)
- **Create/Edit** — dedicated pages (`/outputs/new`, `/outputs/:id/edit`), not modals. Mobile-friendly, room to grow.
- **Platform presets** — selecting Twitch/YouTube/Facebook auto-fills the standard RTMP ingest URL (editable for power users). "Custom" leaves both fields blank.
- **Max 5 outputs** enforced by API

### Stream Setup (`(app)/stream-setup`)
- Displays ingest URL (`rtmp://ingest.omega-stream.io/live/{streamKey}`)
- Stream key with copy button (masked by default, reveal toggle)
- Rotate stream key button with confirmation dialog (can't rotate while live)

### Logs (`(app)/logs`)
- **Output selector dropdown** — pick a specific output, or "All outputs" (interleaved with output labels)
- **Initial load** — last 100 log lines on connect
- **Live tail** — SSE streams new FFmpeg stderr lines in real time
- Auto-scroll to bottom with "jump to latest" button if user scrolls up

### No settings page for MVP — logout lives in the nav user menu

---

## Real-Time (SSE)

- **Per-page SSE connections** — dashboard has its own, logs has its own. No shared cross-page connection.
- **Latest-state-wins** — no sequence IDs or replay. Dashboard shows current state, not history. EventSource's built-in auto-reconnect is sufficient.
- **Auth** — httpOnly cookies sent automatically with SSE connections, no custom header workaround needed.
- SSE endpoints need to be added to the API (not yet implemented).

---

## API Endpoints Consumed

- `POST /auth/register` — create account
- `POST /auth/login` — authenticate
- `POST /auth/refresh` — rotate tokens
- `POST /auth/logout` — revoke refresh token
- `GET /outputs` — list user's outputs
- `POST /outputs` — create output
- `PUT /outputs/:id` — update output
- `DELETE /outputs/:id` — delete output
- `GET /stream` — get ingest URL + stream key
- `POST /stream/key/rotate` — rotate stream key
- `GET /streams/active` — live sessions with per-output health
- `POST /streams/:outputSessionId/stop` — stop an output
- `GET /streams/logs/{outputId}` — log tail (SSE, to be built)

---

## Error Handling & Feedback

- **Inline validation** — zod schema errors shown next to form fields via react-hook-form + shadcn Form
- **Toasts** — shadcn toast component for success confirmations ("Output created"), API errors, and auth issues
- **Loading states** — skeleton loaders on initial page loads, button loading spinners on mutations
- **Error boundaries** — catch unexpected errors per route segment

---

## Theming

- **Dark mode default** — fits streamer audience (dark studios, gaming setups)
- **System/light/dark toggle** — in the nav, persisted via next-themes
- Tailwind `dark:` classes + shadcn's built-in theme tokens

---

## Architecture

```
[Next.js Web UI :3002]  →  CloudFront + ALB + ECS (SSR)
        │
        │ httpOnly cookies (access + refresh tokens)
        │ fetch calls + SSE connections
        ▼
  [API Service :3000]  ←→  PostgreSQL / Redis
```

---

## Implementation Order

1. **Project scaffold** — Next.js 16, TypeScript, Tailwind CSS, shadcn/ui init, next-themes, TanStack Query, ESLint
2. **API client** — typed fetch wrapper (`lib/api/`), TanStack Query hooks
3. **Auth flow** — login + register pages, middleware route guard, cookie-based auth (+ API change for access token cookie)
4. **App layout** — `(auth)` centered layout, `(app)` shell with sidebar (desktop) + bottom tab bar (mobile), user menu with logout
5. **Dashboard** — hero banner, output cards, SSE integration for live metrics, offline state
6. **Outputs** — card grid browse, create/edit pages with platform presets, delete with confirmation
7. **Stream setup** — ingest URL display, stream key copy/reveal/rotate
8. **Logs** — output selector dropdown (+ "All"), initial load + SSE tail, auto-scroll
9. **Error handling** — error boundaries, skeleton loaders, toast notifications
10. **Integration tests** — auth flow, outputs CRUD, dashboard rendering with mock SSE
11. **Dockerize** — Dockerfile for ECS Fargate SSR deployment

---

## Dev Commands (target state)

```bash
pnpm --filter web dev        # Local dev server (port 3002)
pnpm --filter web build      # Production build
pnpm --filter web start      # Production SSR server
pnpm --filter web lint       # Lint
pnpm --filter web test       # Integration tests
```

---

## Verification

- `pnpm --filter web dev` pointing at local API (`http://localhost:3000`)
- Auth flow: register → login → token refresh → protected routes → logout
- Dashboard live: SSE events update hero banner + output cards in real time
- Dashboard offline: last session summary + CTAs displayed
- Outputs: browse cards → create page → edit page → delete with confirmation
- Stream setup: copy ingest URL, reveal/copy stream key, rotate with confirmation
- Logs: select output → see last 100 lines → live tail streams new lines
- Mobile: bottom tab bar visible, all pages usable on 375px viewport
- Theming: toggle between dark/light/system, preference persists across reload
