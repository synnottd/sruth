import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  const redirect = vi.fn((url: URL) => ({ type: "redirect", url: url.toString() }));
  const next = vi.fn(() => ({ type: "next" }));
  return {
    NextResponse: { redirect, next },
    NextRequest: vi.fn(),
  };
});

import { proxy, config } from "./proxy";
import { NextResponse } from "next/server";

function makeRequest(pathname: string, cookies: Record<string, string> = {}) {
  return {
    nextUrl: new URL(`http://localhost:3002${pathname}`),
    url: `http://localhost:3002${pathname}`,
    cookies: {
      get: (name: string) => {
        const value = cookies[name];
        return value ? { name, value } : undefined;
      },
    },
  } as Parameters<typeof proxy>[0];
}

describe("proxy (auth middleware)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users from protected routes to /login", () => {
    const request = makeRequest("/dashboard");

    proxy(request);

    expect(NextResponse.redirect).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/login" }),
    );
  });

  it("allows unauthenticated access to /login", () => {
    const request = makeRequest("/login");

    proxy(request);

    expect(NextResponse.next).toHaveBeenCalled();
    expect(NextResponse.redirect).not.toHaveBeenCalled();
  });

  it("allows unauthenticated access to /register", () => {
    const request = makeRequest("/register");

    proxy(request);

    expect(NextResponse.next).toHaveBeenCalled();
  });

  it("redirects authenticated users from /login to /dashboard", () => {
    const request = makeRequest("/login", { accessToken: "tok_123" });

    proxy(request);

    expect(NextResponse.redirect).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/dashboard" }),
    );
  });

  it("allows authenticated users to access protected routes", () => {
    const request = makeRequest("/dashboard", { accessToken: "tok_123" });

    proxy(request);

    expect(NextResponse.next).toHaveBeenCalled();
  });

  it("matcher covers app and auth routes", () => {
    expect(config.matcher).toContain("/((?!_next/static|_next/image|favicon.ico|icon.svg).*)");
  });
});
