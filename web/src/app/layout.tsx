import type { Metadata } from "next";
import { Instrument_Sans, Martian_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import { isOwner } from "@/lib/owner";
import "./globals.css";

const martian = Martian_Mono({ variable: "--font-martian", subsets: ["latin"], axes: ["wdth"] });
const instrument = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Kestrel", template: "%s · Kestrel" },
  description: "Describe a trading idea. Kestrel's agent builds it, backtests it honestly, and paper trades it.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const owner = await isOwner();
  return (
    <html lang="en" className={`${martian.variable} ${instrument.variable} antialiased`}>
      <body className="min-h-dvh flex flex-col">
        <Nav owner={owner} />
        <main className="flex-1 w-full max-w-[1180px] mx-auto px-4 sm:px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
