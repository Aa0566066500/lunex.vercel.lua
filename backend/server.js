"use strict";

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "256kb" }));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

let firebaseReady = false;
let pool = null;

function initializeFirebase() {
  if (firebaseReady) return;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  firebaseReady = true;
}

function getPool() {
  if (pool) return pool;

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable"
      ? false
      : { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on("error", (error) => {
    console.error("Unexpected database pool error:", error.message);
  });

  return pool;
}

function isAdminEmail(email) {
  const allowedEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return allowedEmails.includes(String(email || "").toLowerCase());
}

async function authenticate(req, res, next) {
  try {
    const authorization = req.get("authorization") || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: "يلزم تسجيل الدخول."
      });
    }

    initializeFirebase();

    const decoded = await admin.auth().verifyIdToken(match[1]);

    if (!decoded.uid) {
      return res.status(401).json({
        error: "تعذّر التحقق من الحساب."
      });
    }

    req.user = {
      id: decoded.uid,
      email: decoded.email || "",
      name: decoded.name || ""
    };

    req.user.isAdmin = isAdminEmail(req.user.email);

    next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    return res.status(401).json({
      error: "جلسة تسجيل الدخول غير صالحة."
    });
  }
}

function requireDatabase(req, res, next) {
  try {
    req.db = getPool();
    next();
  } catch (error) {
    console.error("Database configuration error:", error.message);

    res.status(503).json({
      error: "الخادم غير جاهز؛ تحقق من إعداد قاعدة البيانات."
    });
  }
}

function validateScript(req, res, next) {
  const { title, slug, source_code } = req.body || {};

  if (typeof title !== "string" || !title.trim() || title.length > 80) {
    return res.status(400).json({
      error: "اسم السورس مطلوب، والحد الأقصى 80 حرفًا."
    });
  }

  if (
    typeof slug !== "string" ||
    !/^[A-Za-z0-9_-]{1,50}$/.test(slug)
  ) {
    return res.status(400).json({
      error: "اسم الرابط غير صالح."
    });
  }

  if (
    typeof source_code !== "string" ||
    !source_code.trim() ||
    Buffer.byteLength(source_code, "utf8") > 200000
  ) {
    return res.status(400).json({
      error: "الكود مطلوب، وحجمه يجب ألا يتجاوز 200 كيلوبايت."
    });
  }

  req.validatedScript = {
    title: title.trim(),
    slug,
    source_code
  };

  next();
}

async function recordEvent(db, actorId, eventType, scriptId = null) {
  try {
    await db.query(
      `INSERT INTO audit_events (actor_id, event_type, script_id)
       VALUES ($1, $2, $3)`,
      [actorId, eventType, scriptId]
    );
  } catch (error) {
    console.error("Audit event could not be saved:", error.message);
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Lunex Scripts"
  });
});

app.get("/api/me", authenticate, (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    isAdmin: req.user.isAdmin
  });
});

app.get("/api/scripts", authenticate, requireDatabase, async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const query = req.user.isAdmin
      ? `SELECT id, owner_id, title, slug, visibility, created_at, updated_at
         FROM scripts
         ORDER BY updated_at DESC
         LIMIT 500`
      : `SELECT id, owner_id, title, slug, visibility, created_at, updated_at
         FROM scripts
         WHERE owner_id = $1
         ORDER BY updated_at DESC
         LIMIT 500`;

    const result = req.user.isAdmin
      ? await req.db.query(query)
      : await req.db.query(query, [req.user.id]);

    res.json({
      scripts: result.rows
    });
  } catch (error) {
    console.error("List scripts error:", error.message);

    res.status(500).json({
      error: "تعذّر تحميل السورسات."
    });
  }
});

app.post(
  "/api/scripts",
  authenticate,
  requireDatabase,
  validateScript,
  async (req, res) => {
    const { title, slug, source_code } = req.validatedScript;

    try {
      await req.db.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id)
         DO UPDATE SET
           email = EXCLUDED.email,
           display_name = EXCLUDED.display_name`,
        [
          req.user.id,
          req.user.email || `${req.user.id}@no-email.invalid`,
          req.user.name || "User"
        ]
      );

      const result = await req.db.query(
        `INSERT INTO scripts
           (owner_id, title, slug, source_code, visibility)
         VALUES ($1, $2, $3, $4, 'private')
         RETURNING id, title, slug, visibility, created_at, updated_at`,
        [req.user.id, title, slug, source_code]
      );

      await recordEvent(
        req.db,
        req.user.id,
        "script_created",
        result.rows[0].id
      );

      res.status(201).json({
        script: result.rows[0]
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "اسم الرابط مستخدم بالفعل. اختر اسمًا آخر."
        });
      }

      console.error("Create script error:", error.message);

      res.status(500).json({
        error: "تعذّر إنشاء السورس."
      });
    }
  }
);

app.get(
  "/api/scripts/:id",
  authenticate,
  requireDatabase,
  async (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
      const result = await req.db.query(
        `SELECT id, owner_id, title, slug, source_code,
                visibility, created_at, updated_at
         FROM scripts
         WHERE id = $1
         LIMIT 1`,
        [req.params.id]
      );

      const script = result.rows[0];

      if (
        !script ||
        (!req.user.isAdmin && script.owner_id !== req.user.id)
      ) {
        return res.status(403).json({
          error: "ليس لديك صلاحية للوصول لهذا السورس."
        });
      }

      await recordEvent(
        req.db,
        req.user.id,
        "script_accessed",
        script.id
      );

      res.json(script);
    } catch (error) {
      if (error.code === "22P02") {
        return res.status(404).json({
          error: "السورس غير موجود."
        });
      }

      console.error("Get script error:", error.message);

      res.status(500).json({
        error: "تعذّر تحميل السورس."
      });
    }
  }
);

app.put(
  "/api/scripts/:id",
  authenticate,
  requireDatabase,
  validateScript,
  async (req, res) => {
    const { title, slug, source_code } = req.validatedScript;

    try {
      const result = await req.db.query(
        `UPDATE scripts
         SET title = $1,
             slug = $2,
             source_code = $3,
             updated_at = NOW()
         WHERE id = $4
           AND ($5::boolean OR owner_id = $6)
         RETURNING id, owner_id, title, slug, visibility,
                   created_at, updated_at`,
        [
          title,
          slug,
          source_code,
          req.params.id,
          req.user.isAdmin,
          req.user.id
        ]
      );

      if (!result.rows.length) {
        return res.status(403).json({
          error: "ليس لديك صلاحية لتعديل هذا السورس."
        });
      }

      await recordEvent(
        req.db,
        req.user.id,
        "script_updated",
        result.rows[0].id
      );

      res.json({
        script: result.rows[0]
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "اسم الرابط مستخدم بالفعل."
        });
      }

      if (error.code === "22P02") {
        return res.status(404).json({
          error: "السورس غير موجود."
        });
      }

      console.error("Update script error:", error.message);

      res.status(500).json({
        error: "تعذّر تعديل السورس."
      });
    }
  }
);

app.delete(
  "/api/scripts/:id",
  authenticate,
  requireDatabase,
  async (req, res) => {
    try {
      const result = await req.db.query(
        `DELETE FROM scripts
         WHERE id = $1
           AND ($2::boolean OR owner_id = $3)
         RETURNING id`,
        [req.params.id, req.user.isAdmin, req.user.id]
      );

      if (!result.rows.length) {
        return res.status(403).json({
          error: "ليس لديك صلاحية لحذف هذا السورس."
        });
      }

      await recordEvent(
        req.db,
        req.user.id,
        "script_deleted",
        result.rows[0].id
      );

      res.json({
        success: true
      });
    } catch (error) {
      if (error.code === "22P02") {
        return res.status(404).json({
          error: "السورس غير موجود."
        });
      }

      console.error("Delete script error:", error.message);

      res.status(500).json({
        error: "تعذّر حذف السورس."
      });
    }
  }
);

app.get(
  "/api/admin/events",
  authenticate,
  requireDatabase,
  async (req, res) => {
    if (!req.user.isAdmin) {
      return res.status(403).json({
        error: "هذه الصفحة مخصصة للإدارة."
      });
    }

    try {
      const result = await req.db.query(
        `SELECT id, actor_id, event_type, script_id, created_at
         FROM audit_events
         ORDER BY created_at DESC
         LIMIT 200`
      );

      res.set("Cache-Control", "no-store");
      res.json({
        events: result.rows
      });
    } catch (error) {
      console.error("Admin events error:", error.message);

      res.status(500).json({
        error: "تعذّر تحميل سجل الأحداث."
      });
    }
  }
);

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "المسار المطلوب غير موجود."
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "حدث خطأ غير متوقع."
  });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  app.listen(port, "0.0.0.0", () => {
    console.log(`Lunex Scripts server listening on port ${port}`);
  });
}

module.exports = app;