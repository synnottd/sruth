"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/lib/api/hooks";

// Keep the access-token cookie warm well inside the 15-minute expiry so the
// long-lived SSE connection from /admin/status doesn't get booted to the
// refresh race at the boundary.
const KEEPALIVE_MS = 10 * 60_000;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading } = useCurrentUser();

  useEffect(() => {
    if (isLoading) return;
    if (!data?.isAdmin) router.replace("/dashboard");
  }, [data, isLoading, router]);

  useEffect(() => {
    if (!data?.isAdmin) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    }, KEEPALIVE_MS);
    return () => clearInterval(timer);
  }, [data?.isAdmin, queryClient]);

  if (!data?.isAdmin) return null;
  return <>{children}</>;
}
