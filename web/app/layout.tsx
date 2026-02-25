export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0b1020",
          color: "#f4f7ff"
        }}
      >
        {children}
      </body>
    </html>
  );
}
