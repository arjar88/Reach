import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Reach",
  description: "Reach workspace",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
