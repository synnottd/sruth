import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import type { Output, StreamSession, StreamInfo } from "./types";

export function useOutputs() {
  return useQuery({
    queryKey: ["outputs"],
    queryFn: () => apiClient.get<Output[]>("/outputs"),
  });
}

export function useActiveStreams() {
  return useQuery({
    queryKey: ["streams", "active"],
    queryFn: () => apiClient.get<StreamSession[]>("/streams/active"),
    refetchInterval: 5_000,
  });
}

export function useCreateOutput() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; platform: string; rtmpUrl: string; streamKey: string }) =>
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
