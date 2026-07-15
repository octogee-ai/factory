import { log } from "../config.js";
import { getMmAdminToken } from "./client.js";
export async function mmUploadAvatar(userId, imageUrl) {
    const MM_URL = process.env.MM_URL;
    const token = await getMmAdminToken();
    if (!MM_URL || !token)
        return false;
    try {
        const imgResp = await fetch(imageUrl);
        if (!imgResp.ok)
            return false;
        const buffer = Buffer.from(await imgResp.arrayBuffer());
        const contentType = imgResp.headers.get("content-type") || "image/png";
        const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg" : ".png";
        const blob = new Blob([buffer], { type: contentType });
        const form = new FormData();
        form.append("image", blob, `avatar${ext}`);
        const resp = await fetch(`${MM_URL}/api/v4/users/${userId}/image`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            log(`⚠ [mattermost] avatar upload ${resp.status}: ${text.slice(0, 200)}`);
            return false;
        }
        return true;
    }
    catch (err) {
        log(`⚠ [mattermost] avatar upload failed: ${err}`);
        return false;
    }
}
