const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "256kb" }));

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const required = [
  "DATABASE_URL",
  "RESEND_API_KEY",
  "SESSION_SECRET"
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

if (process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

pool.on("error", error => {
  console.error("PostgreSQL pool error:", error.message);
});

const appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
const emailFrom = process.env.RESEND_FROM_EMAIL;

if (!emailFrom) {
  throw new Error("Missing environment variable: RESEND_FROM_EMAIL");
}

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

app.use(
  session({
    name: "lunex.sid",
    secret: process.env.SESSION_SECRET,
    store: new pgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "").trim();
}

function validPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 72 &&
    /^[A-Za-z0-9]+$/.test(value) &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[0-9]/.test(value)
  );
}

function createCode() {
  return crypto.randomInt(0, 1_000_000)
    .toString()
    .padStart(6, "0");
}

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function createPublicId() {
  return crypto.randomBytes(18).toString("base64url");
}

function requireFields(body, fields) {
  return fields.every(
    field =>
      typeof body[field] === "string" &&
      body[field].trim().length > 0
  );
}

async function sendEmail({ to, subject, html }) {
  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [to],
        subject,
        html
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "Resend request failed:",
      response.status,
      errorText.slice(0, 500)
    );

    throw new Error("تعذر إرسال البريد الإلكتروني.");
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "سجّل الدخول أولًا."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, email, email_verified
       FROM users
       WHERE id = $1`,
      [req.session.userId]
    );

    const user = result.rows[0];

    if (!user || !user.email_verified) {
      return req.session.destroy(() => {
        res.status(401).json({
          error: "الجلسة غير صالحة. سجّل الدخول مجددًا."
        });
      });
    }

    req.user = user;
    req.isAdmin = adminEmails.has(user.email);

    next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    res.status(500).json({
      error: "تعذر التحقق من الحساب."
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({
      error: "هذه الميزة مخصصة للمالك فقط."
    });
  }

  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Lunex Scripts"
  });
});

/* Registration */

app.post(
  "/api/auth/register",
  authLimiter,
  async (req, res) => {
    const body = req.body || {};

    if (
      !requireFields(body, [
        "username",
        "email",
        "password",
        "confirmPassword"
      ])
    ) {
      return res.status(400).json({
        error: "أكمل جميع الحقول."
      });
    }

    const username = normalizeUsername(body.username);
    const email = normalizeEmail(body.email);
    const password = body.password;

    if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: "اسم المستخدم يجب أن يكون 3 إلى 30 حرفًا أو رقمًا أو _."
      });
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: "البريد الإلكتروني غير صالح."
      });
    }

    if (!validPassword(password)) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن تكون 8 أحرف أو أكثر، وتحتوي حرفًا كبيرًا وصغيرًا ورقمًا، دون رموز أو مسافات."
      });
    }

    if (password !== body.confirmPassword) {
      return res.status(400).json({
        error: "كلمتا المرور غير متطابقتين."
      });
    }

    let client;

    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT id FROM users
         WHERE LOWER(email) = LOWER($1)
            OR LOWER(username) = LOWER($2)
         LIMIT 1`,
        [email, username]
      );

      if (existing.rowCount) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error: "البريد الإلكتروني أو اسم المستخدم مستخدم مسبقًا."
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const inserted = await client.query(
        `INSERT INTO users
         (username, email, password_hash, email_verified, is_admin)
         VALUES ($1, $2, $3, FALSE, FALSE)
         RETURNING id`,
        [username, email, passwordHash]
      );

      const userId = inserted.rows[0].id;
      const code = createCode();
      const codeHash = hashValue(code);

      await client.query(
        `INSERT INTO email_verification_codes
         (user_id, code_hash, expires_at, attempts, last_sent_at)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 0, NOW())`,
        [userId, codeHash]
      );

      await client.query("COMMIT");

      try {
        await sendEmail({
          to: email,
          subject: "رمز التحقق — Lunex Scripts",
          html: `
            <div style="font-family:Arial,sans-serif;direction:rtl;text-align:center">
              <h1>Lunex Scripts</h1>
              <p>مرحبًا ${escapeHtml(username)}، رمز التحقق الخاص بك:</p>
              <p style="font-size:32px;font-weight:bold;letter-spacing:8px">
                ${code}
              </p>
              <p>صلاحية الرمز 10 دقائق. لا تشاركه مع أحد.</p>
            </div>
          `
        });
      } catch {
        await pool.query(
          `DELETE FROM users
           WHERE id = $1 AND email_verified = FALSE`,
          [userId]
        );

        return res.status(502).json({
          error: "تعذر إرسال رمز التحقق. تحقق من إعدادات البريد وحاول مجددًا."
        });
      }

      return res.status(201).json({
        ok: true,
        message: "أرسلنا رمز التحقق إلى بريدك الإلكتروني."
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {}
      }

      console.error("Registration failed:", error.message);

      return res.status(500).json({
        error: "تعذر إنشاء الحساب."
      });
    } finally {
      if (client) client.release();
    }
  }
);

/* Email verification */

app.post(
  "/api/auth/verify-email",
  authLimiter,
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        error: "أدخل البريد ورمز التحقق المكوّن من 6 أرقام."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query(
        `SELECT id, email_verified
         FROM users
         WHERE LOWER(email) = LOWER($1)
         FOR UPDATE`,
        [email]
      );

      const user = userResult.rows[0];

      if (!user || user.email_verified) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "الرمز غير صالح أو انتهت صلاحيته."
        });
      }

      const codeResult = await client.query(
        `SELECT id, code_hash, attempts
         FROM email_verification_codes
         WHERE user_id = $1
           AND used_at IS NULL
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [user.id]
      );

      const record = codeResult.rows[0];

      if (!record || record.attempts >= 5) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "الرمز غير صالح أو انتهت صلاحيته."
        });
      }

      const matches = crypto.timingSafeEqual(
        Buffer.from(record.code_hash, "hex"),
        Buffer.from(hashValue(code), "hex")
      );

      if (!matches) {
        await client.query(
          `UPDATE email_verification_codes
           SET attempts = attempts + 1
           WHERE id = $1`,
          [record.id]
        );

        await client.query("COMMIT");

        return res.status(400).json({
          error: "رمز التحقق غير صحيح."
        });
      }

      await client.query(
        `UPDATE email_verification_codes
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      await client.query(
        `UPDATE users
         SET email_verified = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        message: "تم التحقق من البريد. يمكنك تسجيل الدخول."
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Email verification failed:", error.message);

      return res.status(500).json({
        error: "تعذر التحقق من الرمز."
      });
    } finally {
      client.release();
    }
  }
);

/* Resend verification code */

app.post(
  "/api/auth/resend-code",
  authLimiter,
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        error: "أدخل بريدك الإلكتروني."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT id, username, email_verified
         FROM users
         WHERE LOWER(email) = LOWER($1)
         FOR UPDATE`,
        [email]
      );

      const user = result.rows[0];

      if (!user || user.email_verified) {
        await client.query("ROLLBACK");

        return res.json({
          ok: true,
          message: "إذا كان الحساب بحاجة إلى التحقق، فستصل رسالة عند توفر الإرسال."
        });
      }

      const previous = await client.query(
        `SELECT last_sent_at
         FROM email_verification_codes
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [user.id]
      );

      if (previous.rows[0]) {
        const elapsed =
          Date.now() -
          new Date(previous.rows[0].last_sent_at).getTime();

        if (elapsed < 30_000) {
          await client.query("ROLLBACK");

          return res.status(429).json({
            error: "انتظر 30 ثانية قبل طلب رمز جديد.",
            retryAfter: Math.ceil((30_000 - elapsed) / 1000)
          });
        }
      }

      await client.query(
        `UPDATE email_verification_codes
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      const code = createCode();

      await client.query(
        `INSERT INTO email_verification_codes
         (user_id, code_hash, expires_at, attempts, last_sent_at)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 0, NOW())`,
        [user.id, hashValue(code)]
      );

      await client.query("COMMIT");

      await sendEmail({
        to: email,
        subject: "رمز التحقق الجديد — Lunex Scripts",
        html: `
          <div style="font-family:Arial,sans-serif;direction:rtl;text-align:center">
            <h1>Lunex Scripts</h1>
            <p>رمز التحقق الجديد:</p>
            <p style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p>
            <p>صلاحية الرمز 10 دقائق.</p>
          </div>
        `
      });

      return res.json({
        ok: true,
        message: "أرسلنا رمزًا جديدًا."
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Resend verification failed:", error.message);

      return res.status(502).json({
        error: "تعذر إرسال الرمز."
      });
    } finally {
      client.release();
    }
  }
);

/* Login */

app.post(
  "/api/auth/login",
  authLimiter,
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || typeof password !== "string") {
      return res.status(400).json({
        error: "أدخل البريد وكلمة المرور."
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, username, email, password_hash,
                email_verified
         FROM users
         WHERE LOWER(email) = LOWER($1)`,
        [email]
      );

      const user = result.rows[0];

      if (
        !user ||
        !(await bcrypt.compare(password, user.password_hash))
      ) {
        return res.status(401).json({
          error: "البريد أو كلمة المرور غير صحيحة."
        });
      }

      if (!user.email_verified) {
        return res.status(403).json({
          error: "تحقق من بريدك الإلكتروني أولًا."
        });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate(error =>
          error ? reject(error) : resolve()
        );
      });

      req.session.userId = String(user.id);

      await new Promise((resolve, reject) => {
        req.session.save(error =>
          error ? reject(error) : resolve()
        );
      });

      return res.json({
        ok: true,
        user: {
          id: String(user.id),
          username: user.username,
          email: user.email,
          isAdmin: adminEmails.has(user.email)
        }
      });
    } catch (error) {
      console.error("Login failed:", error.message);

      return res.status(500).json({
        error: "تعذر تسجيل الدخول."
      });
    }
  }
);

/* Current user */

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    id: String(req.user.id),
    username: req.user.username,
    email: req.user.email,
    isAdmin: req.isAdmin
  });
});

/* Logout */

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "تعذر تسجيل الخروج."
      });
    }

    res.clearCookie("lunex.sid");

    return res.json({
      ok: true
    });
  });
});

/* Password reset request */

app.post(
  "/api/auth/forgot-password",
  authLimiter,
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);

    const genericMessage =
      "إذا كان البريد مرتبطًا بحساب، فستصلك تعليمات الاستعادة عند توفر الإرسال.";

    if (!email) {
      return res.status(400).json({
        error: "أدخل بريدك الإلكتروني."
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, email_verified
         FROM users
         WHERE LOWER(email) = LOWER($1)`,
        [email]
      );

      const user = result.rows[0];

      if (user && user.email_verified) {
        const token = crypto.randomBytes(32).toString("hex");

        await pool.query(
          `UPDATE password_reset_tokens
           SET used_at = NOW()
           WHERE user_id = $1 AND used_at IS NULL`,
          [user.id]
        );

        await pool.query(
          `INSERT INTO password_reset_tokens
           (user_id, token_hash, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
          [user.id, hashValue(token)]
        );

        if (!appUrl) {
          throw new Error("APP_URL must be configured for password reset.");
        }

        const resetUrl =
          `${appUrl}/?reset=${encodeURIComponent(token)}`;

        await sendEmail({
          to: email,
          subject: "استعادة كلمة المرور — Lunex Scripts",
          html: `
            <div style="font-family:Arial,sans-serif;direction:rtl;text-align:center">
              <h1>Lunex Scripts</h1>
              <p>طلبت استعادة كلمة المرور.</p>
              <p><a href="${escapeHtml(resetUrl)}">إعادة تعيين كلمة المرور</a></p>
              <p>الرابط صالح لمدة 15 دقيقة، ويستخدم مرة واحدة.</p>
              <p>إذا لم تطلب الاستعادة، فتجاهل الرسالة.</p>
            </div>
          `
        });
      }

      return res.json({
        ok: true,
        message: genericMessage
      });
    } catch (error) {
      console.error("Password reset request failed:", error.message);

      return res.status(500).json({
        error: "تعذر معالجة طلب الاستعادة."
      });
    }
  }
);

/* Complete password reset */

app.post(
  "/api/auth/reset-password",
  authLimiter,
  async (req, res) => {
    const token = String(req.body?.token || "");
    const password = req.body?.password;
    const confirmPassword = req.body?.confirmPassword;

    if (
      !/^[a-f0-9]{64}$/.test(token) ||
      !validPassword(password) ||
      password !== confirmPassword
    ) {
      return res.status(400).json({
        error: "تحقق من الرابط وكلمة المرور الجديدة."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT id, user_id
         FROM password_reset_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()
         FOR UPDATE`,
        [hashValue(token)]
      );

      const reset = result.rows[0];

      if (!reset) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "رابط الاستعادة غير صالح أو منتهي."
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await client.query(
        `UPDATE users
         SET password_hash = $1, updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, reset.user_id]
      );

      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [reset.user_id]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        message: "تم تغيير كلمة المرور. سجّل الدخول من جديد."
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Password reset failed:", error.message);

      return res.status(500).json({
        error: "تعذر تغيير كلمة المرور."
      });
    } finally {
      client.release();
    }
  }
);

/* List scripts */

app.get("/api/scripts", requireAuth, async (req, res) => {
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
          [String(req.user.id)]
        );

    res.json({
      scripts: result.rows
    });
  } catch (error) {
    console.error("List scripts failed:", error.message);

    res.status(500).json({
      error: "تعذر تحميل السورسات."
    });
  }
});

/* Create script */

app.post("/api/scripts", requireAuth, async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const source =
    typeof req.body?.source === "string"
      ? req.body.source
      : "";

  if (!title || title.length > 80 || !source.trim()) {
    return res.status(400).json({
      error: "تحقق من اسم السورس والكود."
    });
  }

  if (source.length > 200_000) {
    return res.status(413).json({
      error: "الحد الأقصى للسورس 200 ألف حرف."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const publicId = createPublicId();

    const inserted = await client.query(
      `INSERT INTO scripts (public_id, owner_uid, title, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [publicId, String(req.user.id), title, source]
    );

    await client.query(
      `INSERT INTO access_events
       (script_id, actor_uid, event_type)
       VALUES ($1, $2, 'created')`,
      [inserted.rows[0].id, String(req.user.id)]
    );

    await client.query("COMMIT");

    res.status(201).json({
      publicId,
      title
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("Create script failed:", error.message);

    res.status(500).json({
      error: "تعذر حفظ السورس."
    });
  } finally {
    client.release();
  }
});

/* Get script */

app.get("/api/scripts/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, public_id, owner_uid, title, source,
              created_at, updated_at, enabled
       FROM scripts
       WHERE public_id = $1`,
      [req.params.id]
    );

    const script = result.rows[0];

    if (
      !script ||
      (!req.isAdmin &&
       script.owner_uid !== String(req.user.id))
    ) {
      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    res.json({ script });
  } catch (error) {
    console.error("Get script failed:", error.message);

    res.status(500).json({
      error: "تعذر فتح السورس."
    });
  }
});

/* Update script */

app.patch("/api/scripts/:id", requireAuth, async (req, res) => {
  const title =
    typeof req.body?.title === "string"
      ? req.body.title.trim()
      : null;

  const source =
    typeof req.body?.source === "string"
      ? req.body.source
      : null;

  const enabled =
    typeof req.body?.enabled === "boolean"
      ? req.body.enabled
      : null;

  if (title === null && source === null && enabled === null) {
    return res.status(400).json({
      error: "لا توجد تغييرات."
    });
  }

  if (title !== null && (!title || title.length > 80)) {
    return res.status(400).json({
      error: "اسم السورس غير صالح."
    });
  }

  if (
    source !== null &&
    (!source.trim() || source.length > 200_000)
  ) {
    return res.status(400).json({
      error: "الكود غير صالح أو تجاوز الحد المسموح."
    });
  }

  if (enabled !== null && !req.isAdmin) {
    return res.status(403).json({
      error: "تغيير حالة السورس مخصص للمشرف."
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

    if (
      !script ||
      (!req.isAdmin &&
       script.owner_uid !== String(req.user.id))
    ) {
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
      `UPDATE scripts SET ${fields.join(", ")}
       WHERE public_id = $${index}`,
      values
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Update script failed:", error.message);

    res.status(500).json({
      error: "تعذر تحديث السورس."
    });
  }
});

/* Delete script */

app.delete("/api/scripts/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM scripts
       WHERE public_id = $1
         AND ($2::boolean OR owner_uid = $3)
       RETURNING id`,
      [
        req.params.id,
        req.isAdmin,
        String(req.user.id)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "السورس غير موجود."
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete script failed:", error.message);

    res.status(500).json({
      error: "تعذر حذف السورس."
    });
  }
});

/* Admin event log */

app.get(
  "/api/admin/events",
  requireAuth,
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

      res.json({
        events: result.rows
      });
    } catch (error) {
      console.error("Load events failed:", error.message);

      res.status(500).json({
        error: "تعذر تحميل سجل الإدارة."
      });
    }
  }
);

/* Frontend */

app.use(express.static(path.join(__dirname, "../public")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  app.listen(port, "0.0.0.0", () => {
    console.log(`Lunex Scripts listening on ${port}`);
  });
}

module.exports = app;