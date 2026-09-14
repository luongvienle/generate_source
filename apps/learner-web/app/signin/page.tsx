import { signIn } from '../../auth';
import { safeCallbackPath } from '../../lib/safe-callback';

/**
 * Self-serve sign-in and sign-up in one form.
 *
 * Auth.js's email provider creates the user row on first successful link, so
 * there is no separate registration step — and no role selection, because new
 * rows take the schema default `user_role = 'learner'`.
 *
 * Reaching this page is never required to browse: §7.3 lets an anonymous
 * visitor read a free course and any free-preview lesson, and the catalog is
 * open to everyone. Sign-in buys progress, resume and My Courses.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /**
   * Where the magic link lands afterwards — the checkout confirm page, when a
   * learner was sent here from one. Relative same-origin paths only; see
   * safe-callback.ts.
   */
  const callbackPath = safeCallbackPath((await searchParams)['callbackUrl']);

  async function requestLink(formData: FormData): Promise<void> {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    if (!email) return;
    // Re-validated here: a server action's input is whatever the browser posted,
    // not what the page rendered into the hidden field.
    const redirectTo = safeCallbackPath(formData.get('callbackUrl'));
    await signIn('email', { email, redirect: false, ...(redirectTo ? { redirectTo } : {}) });
  }

  return (
    <main className="reading-main">
      <h1 className="text-2xl font-semibold">Đăng nhập</h1>
      <p className="mt-2 text-neutral-700">
        Nhập địa chỉ email của bạn. Chúng tôi sẽ gửi một liên kết đăng nhập dùng một lần. Nếu bạn
        chưa có tài khoản, tài khoản sẽ được tạo tự động.
      </p>

      <form action={requestLink} className="mt-6 flex flex-col gap-3" data-testid="signin-form">
        {callbackPath ? <input type="hidden" name="callbackUrl" value={callbackPath} /> : null}
        <label htmlFor="email" className="text-sm font-medium">
          Địa chỉ email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          data-testid="signin-email"
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <button
          type="submit"
          data-testid="signin-submit"
          className="self-start rounded bg-neutral-900 px-4 py-2 text-white"
        >
          Gửi liên kết đăng nhập
        </button>
      </form>

      <SentNotice searchParams={searchParams} />
    </main>
  );
}

/**
 * The form posts to itself, so "sent" is the absence of an error rather than a
 * redirect. Deliberately says nothing about whether the address is registered:
 * a message that differs for a known and an unknown address turns this form
 * into an account-enumeration oracle.
 */
async function SentNotice({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (!('sent' in params)) return null;

  return (
    <p className="mt-6 rounded border border-neutral-200 p-4 text-sm" data-testid="signin-sent">
      Nếu địa chỉ này hợp lệ, liên kết đăng nhập đã được gửi. Hãy kiểm tra hộp thư của bạn.
    </p>
  );
}
