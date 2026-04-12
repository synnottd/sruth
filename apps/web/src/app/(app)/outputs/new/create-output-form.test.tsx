import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestWrapper } from "@/test/wrapper";

const { mockPush, mockPost } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: mockPost },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { CreateOutputForm } from "./create-output-form";

describe("CreateOutputForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits form and redirects to outputs list", async () => {
    mockPost.mockResolvedValue({ id: "1", name: "My Twitch", platform: "TWITCH" });
    const user = userEvent.setup();

    render(<CreateOutputForm />, { wrapper: createTestWrapper() });

    await user.type(screen.getByLabelText(/name/i), "My Twitch");
    await user.selectOptions(screen.getByLabelText(/platform/i), "TWITCH");
    await user.type(screen.getByLabelText(/stream key/i), "live_abc123");
    await user.click(screen.getByRole("button", { name: /create/i }));

    expect(mockPost).toHaveBeenCalledWith("/outputs", {
      name: "My Twitch",
      platform: "TWITCH",
      rtmpUrl: "rtmp://live.twitch.tv/app",
      streamKey: "live_abc123",
    });
    expect(mockPush).toHaveBeenCalledWith("/outputs");
  });

  it("auto-fills RTMP URL based on platform preset", async () => {
    const user = userEvent.setup();

    render(<CreateOutputForm />, { wrapper: createTestWrapper() });

    await user.selectOptions(screen.getByLabelText(/platform/i), "YOUTUBE");

    const rtmpInput = screen.getByLabelText(/rtmp url/i) as HTMLInputElement;
    expect(rtmpInput.value).toBe("rtmp://a.rtmp.youtube.com/live2");
  });

  it("shows error on API failure", async () => {
    const { ApiError } = await import("@/lib/api/client");
    mockPost.mockRejectedValue(
      new ApiError(422, "MAX_OUTPUTS_REACHED", "Maximum of 5 outputs allowed"),
    );
    const user = userEvent.setup();

    render(<CreateOutputForm />, { wrapper: createTestWrapper() });

    await user.type(screen.getByLabelText(/name/i), "Too Many");
    await user.selectOptions(screen.getByLabelText(/platform/i), "CUSTOM");
    await user.type(screen.getByLabelText(/rtmp url/i), "rtmp://example.com/live");
    await user.type(screen.getByLabelText(/stream key/i), "key123");
    await user.click(screen.getByRole("button", { name: /create/i }));

    expect(await screen.findByText(/maximum of 5 outputs/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
