/**
 * Signing in: a magic link, a passkey, or approving a terminal.
 *
 * No passwords. The passkey path is progressive enhancement - the form works
 * without it, and the button only appears once the script has confirmed the
 * browser has WebAuthn at all.
 */

import { COLUMNS as PROFILE_COLUMNS, renderProfileFields } from '@profullstack/profile';
import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import { Alert, Card, Field } from './layout.tsx';

/**
 * The rest of the shared profile (@profullstack/profile), asked for on /signup
 * only. Email is the form's own box, so the package renders the other five. A
 * plain sign-in never sees or needs them.
 */
export const SIGNUP_FIELDS = PROFILE_COLUMNS.filter((field) => field !== 'email');

export const LoginPage: FC<{ sent?: string; error?: string; next?: string; unsent?: boolean }> = ({
  sent,
  error,
  next,
  unsent,
}) => (
  <div style="max-width:26rem;margin:0 auto">
    <div class="stack">
      <h1>Sign in</h1>
      {error !== undefined && <Alert variant="error">{error}</Alert>}
      {sent !== undefined ? (
        <Card>
          <div class="card-header">
            <h2 class="card-title">{unsent === true ? 'That link was not sent' : 'Check your email'}</h2>
            <p class="card-description">
              {unsent === true
                ? `A link for ${sent} was made, but this board could not send it. It is in the server log, where whoever runs this board can find it.`
                : `A sign-in link is on its way to ${sent}. It lasts 15 minutes.`}
            </p>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <form class="stack" method="post" action="/login">
              {next !== undefined && <input type="hidden" name="next" value={next} />}
              <Field label="Email" name="email" hint="We send a link. There is no password.">
                <input
                  class="input"
                  type="email"
                  id="email"
                  name="email"
                  autocomplete="email"
                  required
                />
              </Field>
              <button class="btn btn-block" type="submit">
                Email me a link
              </button>
            </form>
          </Card>
          <p class="small muted">
            New here? <a href="/signup">Create an account</a>.
          </p>
          <Card id="passkey-card" hidden>
            <div class="card-header">
              <h2 class="card-title">Or use a passkey</h2>
              <p class="card-description">If you have already added one to this board.</p>
            </div>
            <button class="btn btn-secondary btn-block" type="button" id="passkey-login">
              Sign in with a passkey
            </button>
            <p class="small error-text" id="passkey-error" hidden></p>
          </Card>
        </>
      )}
      <p class="small muted">
        Signing in from a terminal? Run <code>agenticjobs login</code> and approve the code at{' '}
        <a href="/device">/device</a>.
      </p>
    </div>
  </div>
);

export const SignupPage: FC<{
  next?: string;
  values?: Record<string, string>;
  errors?: Record<string, string>;
  /** An invite code from /i/<code>, carried on the link this form asks for. */
  invite?: string;
}> = ({ next, values = {}, errors = {}, invite }) => (
  <div style="max-width:26rem;margin:0 auto">
    <div class="stack">
      <h1>Create your account</h1>
      {invite !== undefined && (
        <Alert variant="info">
          You were invited. The invite is applied when you follow the link we email you.
        </Alert>
      )}
      {Object.keys(errors).length > 0 && (
        <Alert variant="error">Some fields need fixing.</Alert>
      )}
      <Card>
        <form class="stack" method="post" action="/signup">
          {next !== undefined && <input type="hidden" name="next" value={next} />}
          {invite !== undefined && <input type="hidden" name="invite" value={invite} />}
          <Field
            label="Email"
            name="email"
            hint="We send a link. There is no password."
            {...(errors['email'] === undefined ? {} : { error: errors['email'] })}
          >
            <input
              class="input"
              type="email"
              id="email"
              name="email"
              autocomplete="email"
              value={values['email'] ?? ''}
              required
            />
          </Field>
          {raw(renderProfileFields({ fields: SIGNUP_FIELDS, values, errors }))}
          <button class="btn btn-block" type="submit">
            Email me a link
          </button>
        </form>
      </Card>
      <p class="small muted">
        Already have an account? <a href="/login">Sign in</a>.
      </p>
      {/* Fills the company box from a work email. A file, not inline: the CSP allows no inline script. */}
      <script src="/vendor-profile.js" defer></script>
    </div>
  </div>
);

export const DevicePage: FC<{
  signedIn: boolean;
  code?: string;
  label?: string;
  done?: boolean;
  error?: string;
}> = ({ signedIn, code, label, done, error }) => (
  <div style="max-width:30rem;margin:0 auto">
    <div class="stack">
      <h1>Approve a terminal</h1>
      {done === true ? (
        <Alert variant="success">
          <strong>Approved.</strong> The terminal that was waiting is signed in now. You can close
          this page.
        </Alert>
      ) : (
        <>
          {error !== undefined && <Alert variant="error">{error}</Alert>}
          <p class="lede">
            Type the code your terminal is showing. It signs that terminal in as you.
          </p>
          {!signedIn ? (
            <Alert variant="info">
              <a href={`/login?next=${encodeURIComponent('/device')}`}>Sign in first</a>, then come
              back here.
            </Alert>
          ) : (
            <Card>
              <form class="stack" method="post" action="/device">
                <Field label="Code" name="userCode" hint={label === undefined ? undefined : `From: ${label}`}>
                  <input
                    class="input mono"
                    type="text"
                    id="userCode"
                    name="userCode"
                    value={code ?? ''}
                    placeholder="ABCD-EFGH"
                    autocomplete="off"
                    autocapitalize="characters"
                    spellcheck={false}
                    required
                  />
                </Field>
                <button class="btn btn-block" type="submit">
                  Approve
                </button>
              </form>
            </Card>
          )}
          <Alert variant="warning">
            Only approve a code you are looking at yourself. A code someone sent you signs
            <em> their </em> terminal in as <em> you</em>.
          </Alert>
        </>
      )}
    </div>
  </div>
);
