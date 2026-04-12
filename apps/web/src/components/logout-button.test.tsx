import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockPush, mockPost } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: mockPost },
}));

import { LogoutButton } from "./logout-button";

describe("LogoutButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls logout API and redirects to /login", async () => {
    mockPost.mockResolvedValue({ status: "logged_out" });
    const user = userEvent.setup();

    render(<LogoutButton />);

    await user.click(screen.getByRole("button", { name: /log out/i }));

    expect(mockPost).toHaveBeenCalledWith("/auth/logout");
    expect(mockPush).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login even if logout API fails", async () => {
    mockPost.mockRejectedValue(new Error("Network error"));
    const user = userEvent.setup();

    render(<LogoutButton />);

    await user.click(screen.getByRole("button", { name: /log out/i }));

    expect(mockPush).toHaveBeenCalledWith("/login");
  });
});
