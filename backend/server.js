
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

// Allow JSON requests containing larger Lua source code.
app.use(express.json({ limit: "1mb" }));

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false
  })
);

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
} catch {
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON"
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  allowExitOnIdle: true,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

pool.on("error", error => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);

function createPublicId() {
  return crypto.randomBytes(18).toString("base64url");
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "سجّل الدخول أولًا."
      });
    }

    const token = header.slice(7);
    const decoded = await admin.auth().verifyIdToken(token, true);

    req.user = {
      uid: decoded.uid,
      email: (decoded.email || "").toLowerCase()
    };

    req.isAdmin =
      Boolean(req.user.email) &&
      adminEmails.has(req.user.email);

    return next();
  } catch {
    return res.status(401).json({
      error: "جلسة الدخول غير صالحة. سجّل الدخول مجددًا."
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({
      error: "هذه الميزة مخصصة للمالك فقط."
    });
  }

  return next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Lunex Scripts"
  });
});

app.get("/api/me", authenticate, (req, res) => {
  res.json({
    uid: req.user.uid,
    email: req.user.email,
    isAdmin: req.isAdmin
  });
});

app.get("/api/scripts", authenticate, async (req, res) => {
  try {
    const result = req.isAdmin
      ? await pool.query(
          `SELECT public_id, owner_uid, title, created_at,
                  updated_at, enabled
           FROM scripts
           ORDER BY created_at DESC
           LIMIT 500`
        )
      : await pool.query(
          `SELECT public_id, title, created_at, updated_at, enabled
           FROM scripts
           WHERE owner_uid = $1
           ORDER BY created_at DESC`,
          [req.user.uid]
        );

    return res.json({
      scripts: result.rows
    });
  } catch (error) {
    console.error("List scripts failed:", error.message);

    return res.status(500).json({
      error: "تعذر تحميل السورسات."
    });
  }
});

app.post("/api/scripts", authenticate, async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || "").trim();
  const source = typeof body.source === "string"
    ? body.source
    : "";

  if (!title) {
    return res.status(400).json({
      error: "اكتب اسم السورس."
    });
  }

  if (title.length > 80) {
    return res.status(400).json({
      error: "اسم السورس يجب ألا يتجاوز 80 حرفًا."
    });
  }

  if (!source.trim()) {
    return res.status(400).json({
      error: "الصق كود Lua أولًا."
    });
  }

  if (source.length > 200_000) {
    return res.status(413).json({
      error: "الحد الأقصى للسورس 200 ألف حرف."
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    const publicId = createPublicId();

    const inserted = await client.query(
      `INSERT INTO scripts (public_id, owner_uid, title, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [publicId, req.user.uid, title, source]
    );

    await client.query(
      `INSERT INTO access_events (script_id, actor_uid, event_type)
       VALUES ($1, $2, 'created')`,
      [inserted.rows[0].id, req.user.uid]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      publicId,
      title
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    console.error("Create script failed:", error.message);

    return res.status(500).json({
      error: "تعذر حفظ السورس."
    });
  } finally {
    if (client) client.release();
  }
});

app.get("/api/scripts/:id", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, public_id, owner_uid, title, source,
              created_at, updated_at, enabled
       FROM scripts
       WHERE public_id = $1`,
      [req.params.id]
    );

    const script = result.rows[0];

    if (!script) {
      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    if (!req.isAdmin && script.owner_uid !== req.user.uid) {
      await pool.query(
        `INSERT INTO access_events (script_id, actor_uid, event_type)
         VALUES ($1, $2, 'denied')`,
        [script.id, req.user.uid]
      );

      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    return res.json({
      script
    });
  } catch (error) {
    console.error("Get script failed:", error.message);

    return res.status(500).json({
      error: "تعذر فتح السورس."
    });
  }
});

app.patch("/api/scripts/:id", authenticate, async (req, res) => {
  const body = req.body || {};

  const title =
    typeof body.title === "string"
      ? body.title.trim()
      : null;

  const source =
    typeof body.source === "string"
      ? body.source
      : null;

  const enabled =
    typeof body.enabled === "boolean"
      ? body.enabled
      : null;

  if (
    title === null &&
    source === null &&
    enabled === null
  ) {
    return res.status(400).json({
      error: "لا توجد تغييرات."
    });
  }

  if (title !== null && (!title || title.length > 80)) {
    return res.status(400).json({
      error: "اسم السورس فارغ أو تجاوز 80 حرفًا."
    });
  }

  if (
    source !== null &&
    (!source.trim() || source.length > 200_000)
  ) {
    return res.status(400).json({
      error: "السورس فارغ أو تجاوز الحد المسموح."
    });
  }

  // Only administrators may change the enabled flag.
  if (enabled !== null && !req.isAdmin) {
    return res.status(403).json({
      error: "تغيير حالة السورس مخصص للمشرف فقط."
    });
  }

  try {
    const existing = await pool.query(
      `SELECT id, owner_uid
       FROM scripts
       WHERE public_id = $1`,
      [req.params.id]
    );

    const script = existing.rows[0];

    if (!script) {
      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    if (!req.isAdmin && script.owner_uid !== req.user.uid) {
      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    const fields = [];
    const values = [];
    let index = 1;

    if (title !== null) {
      fields.push(`title = $${index++}`);
      values.push(title);
    }

    if (source !== null) {
      fields.push(`source = $${index++}`);
      values.push(source);
    }

    if (enabled !== null) {
      fields.push(`enabled = $${index++}`);
      values.push(enabled);
    }

    fields.push("updated_at = NOW()");
    values.push(req.params.id);

    await pool.query(
      `UPDATE scripts
       SET ${fields.join(", ")}
       WHERE public_id = $${index}`,
      values
    );

    return res.json({
      ok: true
    });
  } catch (error) {
    console.error("Update script failed:", error.message);

    return res.status(500).json({
      error: "تعذر تحديث السورس."
    });
  }
});

app.delete("/api/scripts/:id", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM scripts
       WHERE public_id = $1
       AND ($2::boolean OR owner_uid = $3)
       RETURNING id`,
      [req.params.id, req.isAdmin, req.user.uid]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    return res.json({
      ok: true
    });
  } catch (error) {
    console.error("Delete script failed:", error.message);

    return res.status(500).json({
      error: "تعذر حذف السورس."
    });
  }
});

app.get(
  "/api/admin/events",
  authenticate,
  requireAdmin,
  async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT e.event_type, e.actor_uid, e.created_at,
                s.public_id, s.title, s.owner_uid
         FROM access_events e
         LEFT JOIN scripts s ON s.id = e.script_id
         ORDER BY e.created_at DESC
         LIMIT 300`
      );

      return res.json({
        events: result.rows
      });
    } catch (error) {
      console.error("Load events failed:", error.message);

      return res.status(500).json({
        error: "تعذر تحميل سجل الإدارة."
      });
    }
  }
);

// Serve the frontend when running Express outside Vercel too.
app.use(
  express.static(path.join(__dirname, "../frontend"))
);

app.get("*", (_req, res) => {
  res.sendFile(
    path.join(__dirname, "../frontend/index.html")
  );
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  app.listen(port, "0.0.0.0", () => {
    console.log(`Lunex Scripts listening on ${port}`);
  });
}

module.exports = app;
