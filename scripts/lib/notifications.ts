import { log } from "./config.js";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL || "";

async function sendDiscordWebhook(content: string, username = "Octogee Ops"): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    log("[notify] DISCORD_OPS_WEBHOOK_URL not set — skipping notification");
    return;
  }

  try {
    const resp = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, username }),
    });
    if (!resp.ok) {
      log(`[notify] Discord webhook failed: ${resp.status} ${resp.statusText}`);
    }
  } catch (err: any) {
    log(`[notify] Discord webhook error: ${err.message}`);
  }
}

/**
 * Notify ops of a new user signup.
 */
export async function notifyNewSignup(data: {
  name: string;
  email: string;
  tier: string;
  slug: string;
  uid: string;
}): Promise<void> {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, " UTC");
  const content = [
    `🐙 **New Signup!**`,
    `**Name:** ${data.name || "(no name)"}`,
    `**Email:** ${data.email || "(no email)"}`,
    `**Tier:** ${data.tier}`,
    `**Slug:** ${data.slug}`,
    `**UID:** \`${data.uid}\``,
    `**Time:** ${ts}`,
  ].join("\n");

  await sendDiscordWebhook(content);
}

/**
 * Notify ops of a provisioning error.
 */
export async function notifyProvisioningError(slug: string, error: string): Promise<void> {
  const content = [
    `⚠️ **Provisioning Error**`,
    `**Slug:** ${slug}`,
    `**Error:** ${error}`,
  ].join("\n");

  await sendDiscordWebhook(content);
}
