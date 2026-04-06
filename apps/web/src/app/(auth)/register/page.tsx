import Link from "next/link";
import { RegisterForm } from "./register-form";

export default function RegisterPage() {
  return (
    <>
      <div className="text-center">
        <h1 className="text-2xl font-bold">Create account</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Start streaming to multiple platforms
        </p>
      </div>
      <RegisterForm />
      <p className="text-center text-sm text-zinc-400">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-white hover:underline">
          Log in
        </Link>
      </p>
    </>
  );
}
