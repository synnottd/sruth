import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createTestWrapper } from "@/test/wrapper";

const { mockGet, mockReplace } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockReplace: vi.fn(),
}));

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    apiClient: { get: mockGet },
    ApiError: actual.ApiError,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
  usePathname: () => "/admin/status",
}));

import AdminLayout from "./layout";

/**
 * The admin layout is the only client-side guard we have — it redirects away
 * any non-admin hitting /admin/*. The underlying /admin routes are already
 * 403'd server-side, so this layout exists mainly to avoid a flash of
 * unauthorized UI and to keep the tab out of the browser history.
 */
describe("AdminLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children for an admin user", async () => {
    mockGet.mockResolvedValue({
      id: "u-1",
      email: "admin@example.com",
      isAdmin: true,
    });

    render(
      <AdminLayout>
        <div>admin content</div>
      </AdminLayout>,
      { wrapper: createTestWrapper() },
    );

    expect(await screen.findByText("admin content")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects a non-admin user to /dashboard and does not render children", async () => {
    mockGet.mockResolvedValue({
      id: "u-2",
      email: "user@example.com",
      isAdmin: false,
    });

    render(
      <AdminLayout>
        <div>admin content</div>
      </AdminLayout>,
      { wrapper: createTestWrapper() },
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByText("admin content")).not.toBeInTheDocument();
  });

  it("redirects an unauthenticated (401 → null) visitor to /dashboard", async () => {
    // useCurrentUser swallows 401 to null; the layout must treat null as
    // not-admin rather than hanging forever on an indeterminate state.
    const { ApiError } = await import("@/lib/api/client");
    mockGet.mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "nope"));

    render(
      <AdminLayout>
        <div>admin content</div>
      </AdminLayout>,
      { wrapper: createTestWrapper() },
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/dashboard"));
  });
});
