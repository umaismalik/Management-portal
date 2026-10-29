import "./globals.css";
export const metadata = { title: "Rewaldo Support Tracker", description: "Engineering support issues and features dashboard" };
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
