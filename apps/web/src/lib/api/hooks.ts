import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, ApiError } from "./client";
import type { CurrentUser, Output, Platform, StreamSession, StreamInfo } from "./types";

/**
 * Current session identity. 401s are swallowed to `null` so the nav can hide
 * admin entries for unauthenticated visitors without throwing.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: async (): Promise<CurrentUser | null> => {
      try {
        return await apiClient.get<CurrentUser>("/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

export function useOutputs() {
  return useQuery({
    queryKey: ["outputs"],
    queryFn: () => apiClient.get<Output[]>("/outputs"),
  });
}

export function useActiveStream() {
  return useQuery({
    queryKey: ["streams", "active"],
    queryFn: async () => {
      const streams = await apiClient.get<StreamSession[]>("/streams/active");
      return streams[0] ?? null;
    },
    refetchInterval: 5_000,
  });
}

export function useCreateOutput() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; platform: Platform; rtmpUrl: string; streamKey: string }) =>
      apiClient.post<Output>("/outputs", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["outputs"] }),
  });
}

export function useDeleteOutput() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/outputs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["outputs"] }),
  });
}

export function useToggleOutput() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiClient.put<Output>(`/outputs/${id}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outputs"] });
      queryClient.invalidateQueries({ queryKey: ["streams", "active"] });
    },
  });
}

export function useStreamInfo() {
  return useQuery({
    queryKey: ["stream"],
    queryFn: () => apiClient.get<StreamInfo>("/stream"),
  });
}

export function useRotateStreamKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<{ streamKey: string }>("/stream/key/rotate"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["stream"] }),
  });
}
