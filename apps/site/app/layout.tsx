import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BANG! 온라인",
  description: "친구들과 초대 링크로 함께하는 한국어 BANG! 기본판 게임.",
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
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
