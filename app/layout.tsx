import "./globals.css";
import type { Metadata } from "next";
import { Sora } from "next/font/google";

const sans = Sora({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"]
});

export const metadata: Metadata = {
  title: "BeReal Photo Processor",
  description: "Process BeReal exports into clean, metadata-rich photo sets."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={sans.variable}>{children}</body>
    </html>
  );
}
