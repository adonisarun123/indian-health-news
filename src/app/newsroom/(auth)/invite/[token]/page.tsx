import QRCode from "qrcode";
import { getDb } from "@/db/client";
import { beginEnrolment, MIN_PASSWORD, otpauthUri } from "@/core/auth";
import { Field, Flash, type SP } from "@/components/Desk";
import { SITE_NAME } from "@/lib/site";
import { enrolAction } from "../../../actions";

export const metadata = { title: "Set up your account" };

export default async function Invite({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: SP }) {
  const { token } = await params;
  const start = await beginEnrolment(getDb(), token, new Date());
  if (!start) {
    return (
      <>
        <h1>This invitation is no longer valid</h1>
        <p>It may have been used already or have expired. Ask an administrator for a new one.</p>
      </>
    );
  }
  const uri = otpauthUri(start.secret, start.email, SITE_NAME);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 192 });
  return (
    <>
      <h1>Set up your account</h1>
      <p>
        {start.displayName} · {start.email}
      </p>
      <Flash searchParams={searchParams} />
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>1. Add this account to an authenticator app</h2>
        <p>Scan the code with Google Authenticator, Microsoft Authenticator, 1Password or a similar app.</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="qr" src={qr} alt="QR code for your authenticator app" width={192} height={192} />
        <p>
          Cannot scan? Enter this key by hand: <span className="secret">{start.secret}</span>
        </p>
      </div>
      <form action={enrolAction.bind(null, token)} className="form" style={{ maxWidth: "24rem" }}>
        <h2>2. Choose a password and confirm the code</h2>
        <Field label="Password" name="password" hint={`At least ${MIN_PASSWORD} characters.`}>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
        </Field>
        <Field label="Password again" name="confirm">
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
        </Field>
        <Field label="Authenticator code" name="code" hint="The six digits your app shows now.">
          <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
        </Field>
        <button className="button primary" type="submit">
          Finish setup
        </button>
      </form>
    </>
  );
}
