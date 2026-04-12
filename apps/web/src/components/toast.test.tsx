import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";

function ToastTrigger() {
  const { toast } = useToast();
  return (
    <>
      <button onClick={() => toast("Success message")}>Show success</button>
      <button onClick={() => toast("Error message", "error")}>Show error</button>
    </>
  );
}

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows toast and auto-dismisses after timeout", async () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    await act(() => {
      screen.getByText("Show success").click();
    });

    expect(screen.getByText("Success message")).toBeInTheDocument();

    await act(() => {
      vi.advanceTimersByTime(4100);
    });

    expect(screen.queryByText("Success message")).not.toBeInTheDocument();
  });

  it("renders error toast with error styling", async () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    await act(() => {
      screen.getByText("Show error").click();
    });

    const toast = screen.getByText("Error message");
    expect(toast).toBeInTheDocument();
    expect(toast.className).toContain("bg-red-900");
  });
});
