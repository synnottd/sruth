import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createTestWrapper } from "@/test/wrapper";

/**
 * Nav has two shells: Sidebar (desktop) and BottomTabs (mobile). Both are
 * rendered on every app page, so they must not surface admin-only links to
 * non-admin users — the /admin/* routes would redirect on click, but showing
 * the entry would leak the existence of admin surface area.
 */

const { mockGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
}));

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    apiClient: { get: mockGet, post: vi.fn() },
    ApiError: actual.ApiError,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { Sidebar, BottomTabs } from "./nav";

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Admin link for an admin user", async () => {
    mockGet.mockResolvedValue({ id: "u-1", email: "a@x.com", isAdmin: true });

    render(<Sidebar />, { wrapper: createTestWrapper() });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /admin/i })).toHaveAttribute(
        "href",
        "/admin/status",
      );
    });
  });

  it("hides the Admin link for a non-admin user", async () => {
    mockGet.mockResolvedValue({ id: "u-2", email: "b@x.com", isAdmin: false });

    render(<Sidebar />, { wrapper: createTestWrapper() });

    // Other entries still render — just not Admin.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /admin/i })).not.toBeInTheDocument();
  });

  it("hides the Admin link for an unauthenticated (401 \u2192 null) visitor", async () => {
    const { ApiError } = await import("@/lib/api/client");
    mockGet.mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "nope"));

    render(<Sidebar />, { wrapper: createTestWrapper() });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /admin/i })).not.toBeInTheDocument();
  });
});

describe("BottomTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never renders the Admin entry, even for admins (desktop-only surface)", async () => {
    mockGet.mockResolvedValue({ id: "u-1", email: "a@x.com", isAdmin: true });

    render(<BottomTabs />, { wrapper: createTestWrapper() });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /admin/i })).not.toBeInTheDocument();
  });
});
