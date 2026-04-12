import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestWrapper } from "@/test/wrapper";

const { mockGet, mockPost, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    mockGet: vi.fn(),
    mockPost: vi.fn(),
    MockApiError,
  };
});

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: mockGet, post: mockPost },
  ApiError: MockApiError,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/stream-setup",
}));

import { StreamSetup } from "./stream-setup";

describe("StreamSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  it("shows ingest URL and masked stream key", async () => {
    mockGet.mockResolvedValue({
      streamKey: "abc-123-def-456",
      ingestUrl: "rtmp://localhost:1935/live/abc-123-def-456",
    });

    render(<StreamSetup />, { wrapper: createTestWrapper() });

    expect(await screen.findByText(/rtmp:\/\/localhost:1935\/live/)).toBeInTheDocument();
    // Stream key should be masked by default
    expect(screen.queryByText("abc-123-def-456")).not.toBeInTheDocument();
    expect(screen.getByText(/\*{4,}/)).toBeInTheDocument();
  });

  it("reveals stream key when toggle is clicked", async () => {
    mockGet.mockResolvedValue({
      streamKey: "abc-123-def-456",
      ingestUrl: "rtmp://localhost:1935/live/abc-123-def-456",
    });
    const user = userEvent.setup();

    render(<StreamSetup />, { wrapper: createTestWrapper() });

    await screen.findByText(/rtmp:\/\/localhost:1935\/live/);
    await user.click(screen.getByRole("button", { name: /reveal/i }));

    expect(screen.getByText("abc-123-def-456")).toBeInTheDocument();
  });

  it("rotates stream key after confirmation", async () => {
    mockGet.mockResolvedValue({
      streamKey: "old-key",
      ingestUrl: "rtmp://localhost:1935/live/old-key",
    });
    mockPost.mockResolvedValue({ streamKey: "new-key" });
    const user = userEvent.setup();

    render(<StreamSetup />, { wrapper: createTestWrapper() });

    await screen.findByText(/rtmp:\/\/localhost:1935\/live/);
    await user.click(screen.getByRole("button", { name: /rotate/i }));

    // Confirmation should appear
    expect(await screen.findByText(/are you sure/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(mockPost).toHaveBeenCalledWith("/stream/key/rotate");
  });

  it("shows error when rotating while live", async () => {
    mockGet.mockResolvedValue({
      streamKey: "live-key",
      ingestUrl: "rtmp://localhost:1935/live/live-key",
    });
    mockPost.mockRejectedValue(
      new MockApiError(409, "STREAM_IS_LIVE", "Cannot rotate stream key while streaming"),
    );
    const user = userEvent.setup();

    render(<StreamSetup />, { wrapper: createTestWrapper() });

    await screen.findByText(/rtmp:\/\/localhost:1935\/live/);
    await user.click(screen.getByRole("button", { name: /rotate/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(await screen.findByText(/cannot rotate/i)).toBeInTheDocument();
  });
});
