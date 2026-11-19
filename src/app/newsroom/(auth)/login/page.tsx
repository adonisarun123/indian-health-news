import { redirect } from "next/navigation";
import { Field, Flash, type SP } from "@/components/Desk";
import { currentStaff } from "@/lib/session";
import { loginAction } from "../../actions";

export const metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: SP }) {
  if (await currentStaff()) redirect("/newsroom");
  return (
    <>
      <h1>Newsroom sign-in</h1>
      <Flash searchParams={searchParams} />
      <form action={loginAction} className="form" style={{ maxWidth: "24rem" }}>
        <Field label="Email" name="email">
          <input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password" name="password">
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Field label="Authenticator code" name="code" hint="Six digits from your authenticator app.">
          <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
        </Field>
        <button className="button primary" type="submit">
          Sign in
        </button>
      </form>
      <p className="meta" style={{ marginTop: "1rem" }}>
        Accounts are created by invitation. Ask an administrator if you have lost access.
      </p>
    </>
  );
}
