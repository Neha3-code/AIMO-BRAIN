import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AIMO BRAIN — Trusted Trade Agents demo",
  description: "Reference buyer-agent calling the Valio Aimo trusted interface"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
