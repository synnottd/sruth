import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiClient, ApiError } from "./client";

describe("apiClient", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
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
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
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

  it("handles 204 No Content responses", async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await apiClient.delete("/outputs/1");

    expect(result).toBeNull();
  });
});
