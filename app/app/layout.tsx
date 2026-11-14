import type { Metadata } from "next";
import "./globals.css";
import { OfflineRegistration } from "@/components/offline-registration";

export const metadata: Metadata = {
  title: "fil3shareica — Your files. Straight to your device.",
  description: "Private, encrypted file sharing between phones and computers. Share as a guest or choose a prepaid ad-free plan with Maximum speed.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}<OfflineRegistration /></body>
    </html>
  );
}
