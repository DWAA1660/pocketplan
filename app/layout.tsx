import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const siteUrl = process.env.PUBLIC_SITE_URL ?? 'http://localhost:3000';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'PocketPlan — A shared budget for two',
  description: 'Plan your monthly income, expenses, and envelopes together.',
  openGraph: {
    title: 'PocketPlan',
    description: 'A shared budget for two.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PocketPlan',
    description: 'A shared budget for two.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
