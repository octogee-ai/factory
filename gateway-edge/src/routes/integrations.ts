import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, FieldValue } from "../lib/db.js";
import { encryptSecret } from "../lib/kms.js";

const router = Router();

router.post("/imap", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const { email, imapHost, imapPort, smtpHost, smtpPort, username, password } = req.body;
    if (!email || !imapHost || !username || !password) { res.status(400).json({ error: "Missing required fields" }); return; }

    const encryptedPassword = await encryptSecret(password);

    await db.collection("users").doc(uid).collection("integrations").doc("imap").set({
      provider: "imap", status: "pending", email,
      imap: { host: imapHost, port: imapPort || 993, username },
      smtp: { host: smtpHost || imapHost.replace("imap.", "smtp."), port: smtpPort || 587, username },
      connectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("users").doc(uid).collection("secrets").doc("imap").set({
      provider: "imap",
      imap: { encryptedPassword },
      smtp: { encryptedPassword },
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post("/twilio", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const { accountSid, authToken, fromNumber } = req.body;
    if (!accountSid || !authToken || !fromNumber) { res.status(400).json({ error: "Missing required fields" }); return; }

    const encryptedAuthToken = await encryptSecret(authToken);

    await db.collection("users").doc(uid).collection("integrations").doc("twilio").set({
      provider: "twilio", status: "pending",
      twilio: { accountSid, fromNumber },
      connectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("users").doc(uid).collection("secrets").doc("twilio").set({
      provider: "twilio",
      twilio: { encryptedAuthToken },
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post("/disconnect", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const { service } = req.body;
    const validServices = ["imap", "twilio", "whatsapp"];
    if (!service || !validServices.includes(service)) { res.status(400).json({ error: `Invalid service: ${service}` }); return; }

    await db.collection("users").doc(uid).collection("integrations").doc(service).set({
      provider: service, status: "disconnected", updatedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("users").doc(uid).collection("secrets").doc(service).delete();
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
