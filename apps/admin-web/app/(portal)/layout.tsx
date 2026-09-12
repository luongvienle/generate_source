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
    <div style={{ maxWidth: '72rem', margin: '0 auto', padding: '1.5rem' }}>
      <header
        style={{
          display: 'flex',
          gap: '1rem',
          alignItems: 'baseline',
          borderBottom: '1px solid #ddd',
          paddingBottom: '0.75rem',
          marginBottom: '1.5rem',
        }}
      >
        <strong>Knowledge Explorer</strong>
        <nav style={{ display: 'flex', gap: '1rem' }}>
          <Link href="/import">Import</Link>
        </nav>
        <span style={{ marginLeft: 'auto', color: '#666' }}>{session.user.email}</span>
      </header>
      <main>{children}</main>
    </div>
  );
}
