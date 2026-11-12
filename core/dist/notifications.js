import { log } from "./config.js";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL || "";
export async function sendOpsAlert(content, username = "Octogee Ops") {
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
            log(`[notify] Discord webhook failed: ${resp.status} ${resp.statusText}`, { status: "failed" });
        }
    }
    catch (err) {
        log(`[notify] Discord webhook error: ${err instanceof Error ? err.message : String(err)}`, { status: "failed" });
    }
}
export async function notifyProvisioningError(slug, error) {
    const content = [
        `⚠️ **Provisioning Error**`,
        `**Slug:** ${slug}`,
        `**Error:** ${error}`,
    ].join("\n");
    await sendOpsAlert(content);
}
