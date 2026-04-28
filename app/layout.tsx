import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "学院通知便利贴看板",
  description: "从微信群消息提取通知，自动分类、标注重要性、显示时间与截止日期",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
