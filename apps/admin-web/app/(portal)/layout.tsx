import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../auth';

/**
 * The authenticated shell every P1 screen sits inside.
 *
 * The redirect here is convenience, not enforcement: authorization is the API's
 * job on every request (R-01, FR-AUTH-02), never this layout's.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  return (
    <div className="portal-main">
      <header className="mb-6 flex items-baseline gap-4 border-b border-slate-200 pb-3">
        <strong>Knowledge Explorer</strong>
        <nav className="flex gap-4">
          <Link className="text-sky-700 hover:underline" href="/import">
            Import
          </Link>
        </nav>
        <span className="ml-auto text-slate-500">{session.user.email}</span>
      </header>
      <main>{children}</main>
    </div>
  );
}
