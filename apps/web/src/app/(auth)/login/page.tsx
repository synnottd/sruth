import Link from "next/link";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <>
      <div className="text-center">
        <h1 className="text-2xl font-bold">Log in</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Stream to multiple platforms at once
        </p>
      </div>
      <LoginForm />
      <p className="text-center text-sm text-zinc-400">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="font-medium text-white hover:underline">
          Sign up
        </Link>
      </p>
    </>
  );
}
