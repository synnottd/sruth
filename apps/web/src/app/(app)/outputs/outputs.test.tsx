import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestWrapper } from "@/test/wrapper";

const { mockGet, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: mockGet, delete: mockDelete },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/outputs",
  Link: ({ children, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a {...props}>{children}</a>
  ),
}));

import { OutputsList } from "./outputs-list";

const sampleOutputs = [
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
    name: "YouTube Gaming",
    platform: "YOUTUBE",
    rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    streamKey: "abcd****",
    enabled: false,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
  },
];

describe("OutputsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders output cards from API", async () => {
    mockGet.mockResolvedValue(sampleOutputs);

    render(<OutputsList />, { wrapper: createTestWrapper() });

    expect(await screen.findByText("My Twitch")).toBeInTheDocument();
    expect(screen.getByText("YouTube Gaming")).toBeInTheDocument();
    expect(screen.getByText("TWITCH")).toBeInTheDocument();
    expect(screen.getByText("YOUTUBE")).toBeInTheDocument();
  });

  it("shows empty state when no outputs", async () => {
    mockGet.mockResolvedValue([]);

    render(<OutputsList />, { wrapper: createTestWrapper() });

    expect(await screen.findByText(/no outputs/i)).toBeInTheDocument();
  });

  it("deletes output after confirmation", async () => {
    mockGet.mockResolvedValue(sampleOutputs);
    mockDelete.mockResolvedValue(null);
    const user = userEvent.setup();

    render(<OutputsList />, { wrapper: createTestWrapper() });

    await screen.findByText("My Twitch");
    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    await user.click(deleteButtons[0]);

    // Confirmation dialog should appear
    expect(await screen.findByText(/are you sure/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(mockDelete).toHaveBeenCalledWith("/outputs/1");
  });

  it("renders a toggle switch reflecting enabled state", async () => {
    mockGet.mockResolvedValue(sampleOutputs);

    render(<OutputsList />, { wrapper: createTestWrapper() });

    await screen.findByText("My Twitch");
    const toggles = screen.getAllByRole("checkbox", { name: /enabled/i });
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toBeChecked();
    expect(toggles[1]).not.toBeChecked();
  });
});
