import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiClient, ApiError } from "./client";

describe("apiClient", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a GET request and returns JSON", async () => {
    const data = [{ id: "1", name: "Twitch" }];
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    );

    const result = await apiClient.get("/outputs");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/outputs",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
    expect(result).toEqual(data);
  });

  it("makes a POST request with JSON body", async () => {
    const body = { name: "My Twitch", platform: "TWITCH", rtmpUrl: "rtmp://...", streamKey: "key" };
    const response = { id: "1", ...body };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 201 }),
    );

    const result = await apiClient.post("/outputs", body);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/outputs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(result).toEqual(response);
  });

  it("throws ApiError on 4xx responses", async () => {
    const errorBody = {
      statusCode: 400,
      error: "VALIDATION_ERROR",
      message: "Valid email required",
    };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(errorBody), { status: 400 }),
    );

    const err = await apiClient.post("/auth/register", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Valid email required",
    });
  });

  it("throws ApiError on network failure", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(apiClient.get("/outputs")).rejects.toThrow(ApiError);
    await expect(apiClient.get("/outputs")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Failed to fetch",
    });
  });

  it("refreshes token and retries on 401", async () => {
    const errorBody = { error: "UNAUTHORIZED", message: "Token expired" };
    const data = { id: "1", name: "Twitch" };

    mockFetch
      // 1st call: GET /outputs → 401
      .mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 401 }))
      // 2nd call: POST /auth/refresh → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // 3rd call: GET /outputs retry → 200
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await apiClient.get("/outputs");

    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      "http://localhost:3000/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("throws 401 when refresh fails", async () => {
    const errorBody = { error: "UNAUTHORIZED", message: "Token expired" };

    mockFetch
      // 1st call: GET /outputs → 401
      .mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 401 }))
      // 2nd call: POST /auth/refresh → 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    const err = await apiClient.get("/outputs").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not attempt refresh on auth routes", async () => {
    const errorBody = { error: "UNAUTHORIZED", message: "Invalid credentials" };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(errorBody), { status: 401 }),
    );

    const err = await apiClient.post("/auth/login", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refresh attempts into one request", async () => {
    const errorBody = { error: "UNAUTHORIZED", message: "Token expired" };
    const data = { active: true };

    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 401 }))
      // Single refresh call
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // Both retries
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const [r1, r2] = await Promise.all([
      apiClient.get("/streams/active"),
      apiClient.get("/outputs"),
    ]);

    expect(r1).toEqual(data);
    expect(r2).toEqual(data);

    const refreshCalls = mockFetch.mock.calls.filter(
      (call) => call[0] === "http://localhost:3000/auth/refresh",
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it("handles 204 No Content responses", async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await apiClient.delete("/outputs/1");

    expect(result).toBeNull();
  });
});
