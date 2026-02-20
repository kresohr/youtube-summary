import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { query } from "../lib/db.js";

const router = Router();

// Rate limit login attempts: max 10 per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

router.post("/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Invalid input types" });
      return;
    }

    // Enforce reasonable length limits
    if (username.length > 255 || password.length > 1000) {
      res.status(400).json({ error: "Invalid credentials" });
      return;
    }

    const result = await query(
      "SELECT id, username, password FROM users WHERE username = $1",
      [username]
    );

    const user = result.rows[0];

    if (!user) {
      // Perform a dummy hash comparison to prevent timing attacks
      await bcrypt.compare(password, "$2b$10$dummyhashfortimingattkprevention000000000000000");
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      jwtSecret,
      { expiresIn: "24h", algorithm: "HS256" }
    );

    res.json({
      token,
      user: { username: user.username },
    });
  } catch (error) {
    console.error("Login error:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
