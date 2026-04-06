"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "./logout-button";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/outputs", label: "Outputs" },
  { href: "/stream-setup", label: "Stream Setup" },
  { href: "/logs", label: "Logs" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:w-56 md:flex-col md:border-r md:border-zinc-800 md:bg-zinc-950">
      <div className="flex h-14 items-center border-b border-zinc-800 px-4">
        <span className="text-lg font-bold">Omega Stream</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map(({ href, label }) => (
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

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-zinc-800 bg-zinc-950 md:hidden">
      {NAV_ITEMS.map(({ href, label }) => (
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
