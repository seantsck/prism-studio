import type { Metadata } from "next";
import "./globals.css";
import { LegacyLinkGuard } from "@/components/legacy-link-guard";

export const metadata: Metadata = {
  title: "Prism Studio",
  description: "AI filmmaking production operating system",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <LegacyLinkGuard />
        {children}
      </body>
    </html>
  );
}
