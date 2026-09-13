import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'Knowledge Explorer',
  description: 'Học bằng cách đọc và nghe.',
};

/**
 * Interface copy is Vietnamese, written inline.
 *
 * No i18n framework and no message catalogue: §13 lists no multi-language
 * requirement, courses default to `languageCode = 'vi'`, and a catalogue for a
 * single locale is scaffolding for a second one that is not planned.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen bg-white text-neutral-900">
        <header className="border-b border-neutral-200">
          {/*
            Wraps rather than scrolls at 360 px (NFR-09). The gutter comes from
            the padding here and is never re-declared with a shorthand below.
          */}
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-lg font-semibold">
              Knowledge Explorer
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Link href="/" className="hover:underline">
                Khoá học
              </Link>
              <Link href="/me/courses" className="hover:underline">
                Khoá của tôi
              </Link>
              <Link href="/requests" className="hover:underline">
                Đề xuất chủ đề
              </Link>
            </div>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
