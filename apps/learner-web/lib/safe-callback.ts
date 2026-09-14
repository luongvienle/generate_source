/**
 * Where a learner may be sent after signing in.
 *
 * Only a same-origin RELATIVE path: one leading slash, not two (`//evil.example`
 * is protocol-relative and leaves the site), and no backslash anywhere (browsers
 * normalize `/\evil.example` to `//evil.example`). Anything else is dropped and
 * the default destination applies — so `?callbackUrl=` can never become an open
 * redirect (specs/p8a-commerce/spec.md, "The screens").
 *
 * Applied on BOTH sides of the sign-in form: when the page renders the hidden
 * field, and again in the server action, whose input is whatever the browser
 * posted.
 */
export function safeCallbackPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^\/(?!\/)/.test(value)) return undefined;
  if (value.includes('\\')) return undefined;
  return value;
}
