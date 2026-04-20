"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "./logout-button";
import { useCurrentUser } from "@/lib/api/hooks";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", adminOnly: false },
  { href: "/outputs", label: "Outputs", adminOnly: false },
  { href: "/stream-setup", label: "Stream Setup", adminOnly: false },
  { href: "/logs", label: "Logs", adminOnly: false },
  { href: "/admin/status", label: "Admin", adminOnly: true },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { data: user } = useCurrentUser();
  const isAdmin = user?.isAdmin ?? false;
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <aside className="hidden md:flex md:w-56 md:flex-col md:border-r md:border-zinc-800 md:bg-zinc-950">
      <div className="flex h-14 items-center border-b border-zinc-800 px-4">
        <span className="text-lg font-bold">Omega Stream</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {items.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              pathname.startsWith(href)
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-zinc-800 p-3">
        <LogoutButton />
      </div>
    </aside>
  );
}

export function BottomTabs() {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => !item.adminOnly);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-zinc-800 bg-zinc-950 md:hidden">
      {items.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className={`flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors ${
            pathname.startsWith(href)
              ? "text-white"
              : "text-zinc-500 hover:text-white"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
