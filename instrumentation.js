export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { startReminders } = await import("./lib/reminders");
    startReminders();
  }
}
