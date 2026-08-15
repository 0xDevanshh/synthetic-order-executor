/**
 * Root layout: wagmi + react-query providers, Tailwind globals.
 *
 * TODO(impl)
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
