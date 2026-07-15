import { log } from "./config.js";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL || "";
async function sendDiscordWebhook(content, username = "Octogee Ops") {
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
    }
    catch (err) {
        log(`[notify] Discord webhook error: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export async function notifyNewSignup(data) {
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
export async function notifyProvisioningError(slug, error) {
    const content = [
        `⚠️ **Provisioning Error**`,
        `**Slug:** ${slug}`,
        `**Error:** ${error}`,
    ].join("\n");
    await sendDiscordWebhook(content);
}
