import { Router } from "express";

import { requireAuth } from "../middleware/auth.js";
import {
  deleteModelCredentialKey,
  saveModelCredentialKey,
} from "./billing/byot.js";
import subscriptionRoutes from "./byosub.js";

const router = Router();

router.post("/", requireAuth, saveModelCredentialKey);
router.delete("/", requireAuth, deleteModelCredentialKey);
router.use("/subscription", subscriptionRoutes);

export default router;
