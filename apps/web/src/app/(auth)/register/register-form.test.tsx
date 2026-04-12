import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockPush, mockPost, MockApiError } = vi.hoisted(() => {
  const mockPush = vi.fn();
  const mockPost = vi.fn();
  class MockApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { mockPush, mockPost, MockApiError };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: mockPost },
  ApiError: MockApiError,
}));

import { RegisterForm } from "./register-form";

describe("RegisterForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits registration and redirects to dashboard on success", async () => {
    mockPost.mockResolvedValue({ accessToken: "tok_123", streamKey: "sk_abc" });
    const user = userEvent.setup();

    render(<RegisterForm />);

    await user.type(screen.getByLabelText(/email/i), "new@example.com");
    await user.type(screen.getByLabelText(/password/i), "securepass123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(mockPost).toHaveBeenCalledWith("/auth/register", {
      email: "new@example.com",
      password: "securepass123",
    });
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("shows error when email is already taken", async () => {
    mockPost.mockRejectedValue(
      new MockApiError(409, "EMAIL_TAKEN", "An account with this email already exists"),
    );
    const user = userEvent.setup();

    render(<RegisterForm />);

    await user.type(screen.getByLabelText(/email/i), "existing@example.com");
    await user.type(screen.getByLabelText(/password/i), "securepass123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/an account with this email already exists/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("shows validation error from API", async () => {
    mockPost.mockRejectedValue(
      new MockApiError(400, "VALIDATION_ERROR", "Valid email and password (min 8 chars) are required"),
    );
    const user = userEvent.setup();

    render(<RegisterForm />);

    await user.type(screen.getByLabelText(/email/i), "bad@x.c");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/valid email and password/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
