import "./globals.css";

export const metadata = {
  title: "New Seabury Tee Times",
  description: "Automatic tee-time booking",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
