"use client";

import { LoginRequest } from "@enmo/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ApiError, errorMessage } from "@/lib/api";
import { postLoginPath, useLogin, useMe } from "@/lib/auth";
import { AuthLayout, AuthPanel } from "./AuthLayout";

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "That email and password don't match an active account.";
  }
  return errorMessage(error);
}

export function LoginScreen() {
  const me = useMe();
  const router = useRouter();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Signing in stores the session, which lands here too; so does visiting /login while signed in.
  const signedIn = Boolean(me.data);
  useEffect(() => {
    if (signedIn) router.replace(postLoginPath());
  }, [signedIn, router]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = LoginRequest.safeParse({ email, password });
    if (!parsed.success) {
      setFormError("Enter the email and password for your ENMO account.");
      return;
    }
    setFormError(null);
    login.mutate(parsed.data);
  }

  const error = formError ?? (login.isError ? loginErrorMessage(login.error) : null);

  return (
    <AuthLayout>
      <AuthPanel title="Sign in" description="Internal access for the Enmo team.">
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Input
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error ? <FormAlert>{error}</FormAlert> : null}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={login.isPending || login.isSuccess}
            className="mt-1 w-full"
          >
            Sign in
          </Button>
        </form>
        <p className="mt-6 text-xs leading-relaxed text-steel">
          New to the team? Ask an admin for an invite link.
        </p>
      </AuthPanel>
    </AuthLayout>
  );
}
