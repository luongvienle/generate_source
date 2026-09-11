import { signIn } from '../../auth';

/**
 * Unstyled by intent: P0's non-goals exclude all UI beyond sign-in.
 */
export default function SignInPage() {
  async function requestLink(formData: FormData): Promise<void> {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    if (!email) return;
    await signIn('email', { email, redirect: false });
  }

  return (
    <main>
      <h1>Sign in</h1>
      <p>Enter your address and we will send a single-use sign-in link.</p>
      <form action={requestLink}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
        <button type="submit">Send sign-in link</button>
      </form>
    </main>
  );
}
