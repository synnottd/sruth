import { Sidebar, BottomTabs } from "@/components/nav";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1">
      <Sidebar />
      <main className="flex flex-1 flex-col pb-16 md:pb-0">
        <div className="flex-1 p-4 md:p-6">{children}</div>
      </main>
      <BottomTabs />
    </div>
  );
}
