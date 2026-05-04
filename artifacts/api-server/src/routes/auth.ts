import { Router } from "express";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession } from "../lib/productAuth";
import { normalizePhone, parsePin } from "../middleware/validate";

const router = Router();

// Backward-compatible auth endpoint expected by external clients.
router.post("/login", async (req, res) => {
  const { phone, pin } = req.body ?? {};
  const normalizedPhone = normalizePhone(phone);
  const parsedPin = parsePin(pin);
  if (!normalizedPhone || !parsedPin) {
    return res.status(400).json({ error: true, message: "phone and pin required" });
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, normalizedPhone)).limit(1);
    if (!user) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const pinHash = createHash("sha256").update(parsedPin).digest("hex");
    if ((user as any).pinHash !== pinHash) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const session = await createSession(user.id, "wallet");
    return res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        status: user.status,
        country: user.country,
      },
    });
  } catch {
    return res.status(500).json({ error: true, message: "Login failed" });
  }
});

export default router;
