"use client";

import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api/client";
import { clearAccessToken } from "@/lib/auth";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    try {
      await apiClient.post("/auth/logout");
    } catch {
      // Always redirect even if API call fails
    }
    clearAccessToken();
    router.push("/login");
  }

  return (
    <button type="button" onClick={handleLogout}>
      Log out
    </button>
  );
}
