export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        style={{
          margin: 0,
          fontFamily:
            "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
