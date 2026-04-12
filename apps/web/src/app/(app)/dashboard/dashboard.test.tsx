import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createTestWrapper } from "@/test/wrapper";

const { mockGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: mockGet },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { Dashboard } from "./dashboard";

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows OFFLINE when no active streams", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/streams/active") return Promise.resolve([]);
      if (path === "/outputs") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(<Dashboard />, { wrapper: createTestWrapper() });

    expect(await screen.findByText("OFFLINE")).toBeInTheDocument();
  });

  it("shows output cards from API data", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/streams/active") return Promise.resolve([]);
      if (path === "/outputs")
        return Promise.resolve([
          {
            id: "1",
            name: "My Twitch",
            platform: "TWITCH",
            rtmpUrl: "rtmp://live.twitch.tv/app",
            streamKey: "live****",
            enabled: true,
            createdAt: "2024-01-01",
            updatedAt: "2024-01-01",
          },
          {
            id: "2",
            name: "My YouTube",
            platform: "YOUTUBE",
            rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
            streamKey: "abcd****",
            enabled: true,
            createdAt: "2024-01-01",
            updatedAt: "2024-01-01",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<Dashboard />, { wrapper: createTestWrapper() });

    expect(await screen.findByText("My Twitch")).toBeInTheDocument();
    expect(screen.getByText("My YouTube")).toBeInTheDocument();
    expect(screen.getByText("TWITCH")).toBeInTheDocument();
    expect(screen.getByText("YOUTUBE")).toBeInTheDocument();
  });

  it("shows LIVE status when stream is active", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/streams/active")
        return Promise.resolve([
          {
            id: "s1",
            userId: "u1",
            status: "LIVE",
            startedAt: new Date().toISOString(),
            endedAt: null,
            avgBitrate: null,
            peakBitrate: null,
            outputSessions: [
              {
                id: "os1",
                sessionId: "s1",
                outputId: "1",
                status: "LIVE",
                lastError: null,
                reconnectCount: 0,
                startedAt: new Date().toISOString(),
                endedAt: null,
              },
            ],
            metrics: { bitrate: 4500 },
          },
        ]);
      if (path === "/outputs")
        return Promise.resolve([
          {
            id: "1",
            name: "My Twitch",
            platform: "TWITCH",
            rtmpUrl: "rtmp://live.twitch.tv/app",
            streamKey: "live****",
            enabled: true,
            createdAt: "2024-01-01",
            updatedAt: "2024-01-01",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<Dashboard />, { wrapper: createTestWrapper() });

    const liveElements = await screen.findAllByText("LIVE");
    expect(liveElements.length).toBeGreaterThanOrEqual(1);
  });

  it("shows loading skeleton while data loads", async () => {
    mockGet.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    render(<Dashboard />, { wrapper: createTestWrapper() });

    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
  });
});
