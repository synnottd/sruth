import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

/**
 * The status page is thin: it opens an EventSource, takes the latest snapshot
 * off the wire, and renders four zones (queue, sessions, ingest banner,
 * ingest panel). We fake EventSource here so tests can drive arbitrary
 * snapshots without a running API.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  readyState = 0;
  closed = false;
  constructor(
    public url: string,
    public init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

import { StatusDashboard } from "./status";

function fixtureSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    queue: {
      pending: 2,
      claimed: 1,
      failed: 3,
      oldestPendingAgeMs: 12_500,
      recentFailures: [
        {
          id: "f1",
          type: "stop",
          sessionId: "s-1",
          completedAt: "2026-04-20T12:00:00.000Z",
          lastError: "upstream connection reset",
        },
      ],
    },
    sessions: [
      {
        sessionId: "sess-1",
        userId: "u-1",
        userEmail: "streamer@example.com",
        status: "LIVE",
        startedAt: "2026-04-20T11:30:00.000Z",
        outputs: [
          {
            outputId: "o-1",
            name: "Twitch Main",
            platform: "TWITCH",
            status: "LIVE",
            lastError: null,
          },
        ],
      },
    ],
    mediamtx: {
      reachable: true,
      publishers: [
        {
          streamKey: "abc123",
          userEmail: "streamer@example.com",
          protocol: "rtmp",
          uptimeSec: 125,
        },
      ],
      byProtocol: { rtmp: 1, srt: 0 },
    },
    generatedAt: "2026-04-20T12:00:05.000Z",
    ...overrides,
  };
}

describe("StatusDashboard", () => {
  it("opens an EventSource against /admin/status/stream with credentials", () => {
    render(<StatusDashboard />);

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0];
    expect(es.url).toMatch(/\/admin\/status\/stream$/);
    expect(es.init?.withCredentials).toBe(true);
  });

  it("shows a loading state until the first snapshot arrives", () => {
    render(<StatusDashboard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders queue counts, session rows, and publisher rows from the first message", async () => {
    render(<StatusDashboard />);
    const es = FakeEventSource.instances[0];

    await act(async () => {
      es.emit(fixtureSnapshot());
    });

    // Queue panel — counts by status.
    expect(screen.getByTestId("queue-pending")).toHaveTextContent("2");
    expect(screen.getByTestId("queue-claimed")).toHaveTextContent("1");
    expect(screen.getByTestId("queue-failed")).toHaveTextContent("3");

    // Recent failure is visible and shows the human fields.
    expect(screen.getByText("upstream connection reset")).toBeInTheDocument();
    expect(screen.getByText("s-1")).toBeInTheDocument();

    // Sessions panel — one live session for streamer@example.com.
    expect(screen.getByText("streamer@example.com")).toBeInTheDocument();
    expect(screen.getByText("Twitch Main")).toBeInTheDocument();

    // Ingest panel — publisher row and protocol breakdown.
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-rtmp-count")).toHaveTextContent("1");
    expect(screen.getByTestId("ingest-srt-count")).toHaveTextContent("0");

    // No unreachable banner when reachable=true.
    expect(screen.queryByTestId("mediamtx-banner")).not.toBeInTheDocument();
  });

  it("shows the mediamtx-unreachable banner when reachable=false", async () => {
    render(<StatusDashboard />);
    const es = FakeEventSource.instances[0];

    await act(async () => {
      es.emit(
        fixtureSnapshot({
          mediamtx: { reachable: false, publishers: [], byProtocol: { rtmp: 0, srt: 0 } },
        }),
      );
    });

    expect(screen.getByTestId("mediamtx-banner")).toBeInTheDocument();
  });

  it("overwrites the previous snapshot when a new one arrives", async () => {
    render(<StatusDashboard />);
    const es = FakeEventSource.instances[0];

    await act(async () => {
      es.emit(fixtureSnapshot());
    });
    expect(screen.getByTestId("queue-pending")).toHaveTextContent("2");

    await act(async () => {
      es.emit(
        fixtureSnapshot({
          queue: {
            pending: 0,
            claimed: 0,
            failed: 0,
            oldestPendingAgeMs: null,
            recentFailures: [],
          },
        }),
      );
    });
    expect(screen.getByTestId("queue-pending")).toHaveTextContent("0");
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = render(<StatusDashboard />);
    const es = FakeEventSource.instances[0];
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });
});
