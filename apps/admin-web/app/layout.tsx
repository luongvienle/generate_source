import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Knowledge Explorer — Admin',
  description: 'Author lessons, illustrations, narration and audio.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
