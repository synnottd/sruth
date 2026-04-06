import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestWrapper } from "@/test/wrapper";

const { mockGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: mockGet },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/logs",
}));

import { LogsView } from "./logs-view";

const sampleOutputs = [
  { id: "1", name: "My Twitch", platform: "TWITCH", rtmpUrl: "", streamKey: "****", enabled: true, createdAt: "", updatedAt: "" },
  { id: "2", name: "YouTube Gaming", platform: "YOUTUBE", rtmpUrl: "", streamKey: "****", enabled: true, createdAt: "", updatedAt: "" },
];

describe("LogsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders output selector dropdown with all outputs", async () => {
    mockGet.mockResolvedValue(sampleOutputs);

    render(<LogsView />, { wrapper: createTestWrapper() });

    const select = await screen.findByLabelText(/output/i);
    expect(select).toBeInTheDocument();
    expect(screen.getByText("My Twitch")).toBeInTheDocument();
    expect(screen.getByText("YouTube Gaming")).toBeInTheDocument();
  });

  it("shows 'All outputs' option in selector", async () => {
    mockGet.mockResolvedValue(sampleOutputs);

    render(<LogsView />, { wrapper: createTestWrapper() });

    await screen.findByLabelText(/output/i);
    expect(screen.getByText("All outputs")).toBeInTheDocument();
  });

  it("shows empty state when no outputs exist", async () => {
    mockGet.mockResolvedValue([]);

    render(<LogsView />, { wrapper: createTestWrapper() });

    expect(await screen.findByText(/no outputs/i)).toBeInTheDocument();
  });

  it("shows placeholder message when SSE is not connected", async () => {
    mockGet.mockResolvedValue(sampleOutputs);

    render(<LogsView />, { wrapper: createTestWrapper() });

    await screen.findByLabelText(/output/i);
    expect(screen.getByText(/waiting for log data/i)).toBeInTheDocument();
  });

  it("changes selected output", async () => {
    mockGet.mockResolvedValue(sampleOutputs);
    const user = userEvent.setup();

    render(<LogsView />, { wrapper: createTestWrapper() });

    const select = await screen.findByLabelText(/output/i);
    await user.selectOptions(select, "1");

    expect((select as HTMLSelectElement).value).toBe("1");
  });
});
