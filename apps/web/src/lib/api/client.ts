const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    return res.ok;
  } catch {
    return false;
  }
}

function doFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(method, path, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    throw new ApiError(0, "NETWORK_ERROR", message);
  }

  // On 401, attempt a single token refresh and retry
  if (response.status === 401 && !path.startsWith("/auth/")) {
    // Coalesce concurrent refresh attempts into one request
    refreshPromise ??= tryRefresh().finally(() => { refreshPromise = null; });
    const refreshed = await refreshPromise;

    if (refreshed) {
      try {
        response = await doFetch(method, path, body);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Network error";
        throw new ApiError(0, "NETWORK_ERROR", message);
      }
    }
  }

  if (response.status === 204) {
    return null as T;
  }

  const data = await response.json();

  if (!response.ok) {
    throw new ApiError(response.status, data.error, data.message);
  }

  return data as T;
}

export const apiClient = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
