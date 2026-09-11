import type { ReactNode } from 'react';

export const metadata = {
  title: 'Knowledge Explorer',
  description: 'Learn by reading and listening.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
