import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Search } from '../components/Search.tsx';
import '../design/tokens.css';
import '../design/components.css';
import { Footer, NavBar } from '../design/index.tsx';
import {
  BASE_PATH,
  GITHUB_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  pagePath,
} from '../site.ts';
import './site.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  keywords: [
    'react native',
    'qa',
    'qa agent',
    'expo',
    'ios simulator',
    'test plan',
    'pull request',
    'claude code',
    'codex',
    'cursor',
  ],
  icons: { icon: `${BASE_PATH}/favicon.svg` },
  openGraph: { type: 'website', siteName: SITE_NAME, images: `${BASE_PATH}/og-image.png` },
  twitter: { card: 'summary_large_image' },
};

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS',
  url: `${SITE_ORIGIN}${BASE_PATH}/`,
  author: { '@type': 'Person', name: 'Anton Lykhoyda', url: 'https://github.com/Lykhoyda' },
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

const home = `${BASE_PATH}${pagePath('')}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${inter.variable} ${mono.variable}`}>
      <body className="qr-root">
        <a className="qr-skip" href="#main">
          Skip to content
        </a>
        <NavBar
          homeHref={home}
          links={[
            { label: 'Docs', href: home },
            { label: 'CLI reference', href: `${BASE_PATH}${pagePath('cli')}` },
            { label: 'Changelog', href: `${BASE_PATH}${pagePath('changelog')}` },
          ]}
          action={<Search />}
        />
        {children}
        <Footer
          links={[
            { label: 'GitHub', href: GITHUB_URL },
            { label: 'Changelog', href: `${BASE_PATH}${pagePath('changelog')}` },
          ]}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </body>
    </html>
  );
}
