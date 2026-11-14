import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AIMO BRAIN — Trusted Trade Agents",
  description: "Autonomous trade. Independent control. Built on trust."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
