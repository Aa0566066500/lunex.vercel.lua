import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
  authDomain: "REPLACE_WITH_FIREBASE_AUTH_DOMAIN",
  projectId: "REPLACE_WITH_FIREBASE_PROJECT_ID",
  appId: "REPLACE_WITH_FIREBASE_APP_ID"
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  themeToggle: $("#theme-toggle"),
  loginButton: $("#login-button"),
  createButton: $("#create-script-button"),
  closeEditor: $("#close-editor-button"),
  editorSection: $("#editor-section"),
  editorTitle: $("#editor-heading-title"),
  scriptForm: $("#script-form"),
  scriptTitle: $("#script-title"),
  scriptSlug: $("#script-slug"),
  scriptCode: $("#script-code"),
  copyCodeButton: $("#copy-code-button"),
  scriptsList: $("#scripts-list"),
  scriptCount: $("#script-count"),
  authNotice: $("#auth-notice"),
  toast: $("#toast")
};

let firebaseAuth = null;
let currentUser = null;
let editingScriptId = null;
let toastTimer = null;
let scripts = [];

const firebaseConfigured =
  firebaseConfig.apiKey !== "REPLACE_WITH_FIREBASE_API_KEY" &&
  firebaseConfig.authDomain !== "REPLACE_WITH_FIREBASE_AUTH_DOMAIN" &&
  firebaseConfig.projectId !== "REPLACE_WITH_FIREBASE_PROJECT_ID" &&
  firebaseConfig.appId !== "REPLACE_WITH_FIREBASE_APP_ID";

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3000);
}

function setLoading(button, loading, loadingText = "جارٍ التنفيذ...") {
  if (!button) return;

  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
  } else {
    button.textContent =
      button.dataset.originalText || button.textContent;

    button.disabled = false;
    delete button.dataset.originalText;
  }
}

function applyTheme(theme) {
  const dark = theme === "dark";

  document.documentElement.dataset.theme = dark ? "dark" : "light";

  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#101116" : "#ffffff");

  elements.themeToggle.setAttribute(
    "aria-label",
    dark ? "تفعيل الوضع الفاتح" : "تفعيل الوضع الداكن"
  );

  elements.themeToggle.title =
    dark ? "الوضع الفاتح" : "الوضع الداكن";

  elements.themeToggle.innerHTML = dark
    ? `<svg viewBox="0 0 24 24" aria-hidden="true">
         <circle cx="12" cy="12" r="4"></circle>
         <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"></path>
       </svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true">
         <path d="M20.2 15.4A8.6 8.6 0 0 1 8.6 3.8a8.7 8.7 0 1 0 11.6 11.6Z"></path>
       </svg>`;

  localStorage.setItem("lunex-theme", theme);
}

function initializeTheme() {
  const savedTheme = localStorage.getItem("lunex-theme");

  const preferredTheme =
    savedTheme ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");

  applyTheme(preferredTheme);
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (currentUser) {
    const token = await currentUser.getIdToken();
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`/api${path}`, {
    ...options,
    headers
  });

  const contentType = response.headers.get("content-type") || "";

  const result = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof result === "object" && result
        ? result.error || result.message
        : result;

    throw new Error(message || `فشل الطلب (${response.status})`);
  }

  return result;
}

function setAuthenticatedInterface(user) {
  currentUser = user;

  elements.loginButton.textContent = user
    ? "تسجيل الخروج"
    : "تسجيل الدخول";

  elements.createButton.disabled = !user;

  elements.authNotice.textContent = user
    ? `أهلًا ${user.displayName || user.email || ""}، هذه مساحة سورساتك.`
    : firebaseConfigured
      ? "سجّل الدخول لعرض سورساتك وإنشاء سورس جديد."
      : "يلزم إعداد Firebase أولًا لتفعيل تسجيل الدخول.";

  if (!user) {
    scripts = [];
    renderScripts();
    closeEditor();
  }
}

async function loginWithGoogle() {
  if (!firebaseAuth) {
    showToast("أكمل إعداد Firebase أولًا في ملف app.js.");
    return;
  }

  setLoading(elements.loginButton, true, "جارٍ تسجيل الدخول...");

  try {
    if (currentUser) {
      await signOut(firebaseAuth);
      showToast("تم تسجيل الخروج.");
    } else {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });

      await signInWithPopup(firebaseAuth, provider);
      showToast("تم تسجيل الدخول.");
    }
  } catch (error) {
    console.error("Authentication error:", error);

    showToast(
      error.code === "auth/popup-closed-by-user"
        ? "أُغلقت نافذة تسجيل الدخول."
        : "تعذّر تسجيل الدخول. تحقق من إعدادات Firebase."
    );
  } finally {
    setLoading(elements.loginButton, false);
  }
}

function openEditor(script = null) {
  if (!currentUser) {
    showToast("سجّل الدخول أولًا.");
    return;
  }

  editingScriptId = script?.id || null;

  elements.editorTitle.textContent = script
    ? "تعديل السورس"
    : "إنشاء سورس جديد";

  elements.scriptTitle.value = script?.title || "";
  elements.scriptSlug.value = script?.slug || "";
  elements.scriptCode.value = script?.source_code || "";

  elements.editorSection.hidden = false;

  elements.editorSection.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function closeEditor() {
  elements.editorSection.hidden = true;
  elements.scriptForm.reset();
  editingScriptId = null;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

function renderScripts() {
  elements.scriptsList.replaceChildren();

  elements.scriptCount.textContent = `${scripts.length} سورس`;

  if (!currentUser) {
    const empty = makeElement("div", "empty-state");

    const heading = makeElement("h3", "", "مساحة عملك بانتظارك");
    const paragraph = makeElement(
      "p",
      "",
      "سجّل الدخول للبدء بإضافة سورساتك."
    );

    empty.append(heading, paragraph);
    elements.scriptsList.append(empty);

    return;
  }

  if (scripts.length === 0) {
    const empty = makeElement("div", "empty-state");

    const heading = makeElement("h3", "", "ما عندك سورسات حتى الآن");
    const paragraph = makeElement(
      "p",
      "",
      "اضغط على إنشاء سورس جديد لإضافة أول مشروع."
    );

    empty.append(heading, paragraph);
    elements.scriptsList.append(empty);

    return;
  }

  for (const script of scripts) {
    const card = makeElement("article", "script-card");

    const heading = makeElement("h3", "", script.title);
    const slug = makeElement("p", "", `/${script.slug}`);
    const date = makeElement(
      "p",
      "",
      script.updated_at
        ? `آخر تحديث: ${new Date(script.updated_at).toLocaleDateString("ar-SA")}`
        : "سورس محفوظ"
    );

    const actions = makeElement("div", "script-card-actions");

    const editButton = makeElement(
      "button",
      "button button-secondary",
      "تعديل"
    );

    editButton.type = "button";
    editButton.addEventListener("click", () => openEditor(script));

    const copyButton = makeElement(
      "button",
      "button button-secondary",
      "نسخ الكود"
    );

    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      try {
        const fullScript = await apiRequest(
          `/scripts/${encodeURIComponent(script.id)}`
        );

        await navigator.clipboard.writeText(
          fullScript.source_code || ""
        );

        showToast("تم نسخ الكود.");
      } catch (error) {
        console.error(error);
        showToast("تعذّر جلب الكود أو نسخه.");
      }
    });

    const deleteButton = makeElement(
      "button",
      "button button-secondary",
      "حذف"
    );

    deleteButton.type = "button";
    deleteButton.addEventListener("click", () => deleteScript(script));

    actions.append(editButton, copyButton, deleteButton);
    card.append(heading, slug, date, actions);

    elements.scriptsList.append(card);
  }
}

async function loadScripts() {
  if (!currentUser) return;

  try {
    const result = await apiRequest("/scripts");

    scripts = Array.isArray(result)
      ? result
      : Array.isArray(result.scripts)
        ? result.scripts
        : [];

    renderScripts();
  } catch (error) {
    console.error("Loading scripts failed:", error);
    showToast("تعذّر تحميل السورسات. تحقق من الخادم وقاعدة البيانات.");
  }
}

async function saveScript(event) {
  event.preventDefault();

  if (!currentUser) {
    showToast("سجّل الدخول أولًا.");
    return;
  }

  const title = elements.scriptTitle.value.trim();
  const slug = elements.scriptSlug.value.trim();
  const source_code = elements.scriptCode.value;

  if (!title || !slug || !source_code.trim()) {
    showToast("عبّئ جميع الحقول.");
    return;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    showToast("اسم الرابط يجب أن يحتوي حروفًا إنجليزية أو أرقامًا أو - أو _ فقط.");
    return;
  }

  const submitButton = elements.scriptForm.querySelector(
    'button[type="submit"]'
  );

  setLoading(submitButton, true, "جارٍ الحفظ...");

  try {
    const payload = { title, slug, source_code };

    if (editingScriptId) {
      await apiRequest(`/scripts/${encodeURIComponent(editingScriptId)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    } else {
      await apiRequest("/scripts", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }

    showToast("تم حفظ السورس.");
    closeEditor();
    await loadScripts();
  } catch (error) {
    console.error("Saving script failed:", error);

    showToast(
      /slug|unique|duplicate/i.test(error.message)
        ? "اسم الرابط مستخدم أو غير صالح؛ اختر اسمًا آخر."
        : error.message || "تعذّر حفظ السورس."
    );
  } finally {
    setLoading(submitButton, false);
  }
}

async function deleteScript(script) {
  const confirmed = window.confirm(
    `هل أنت متأكد أنك تريد حذف السورس "${script.title}"؟`
  );

  if (!confirmed) return;

  try {
    await apiRequest(`/scripts/${encodeURIComponent(script.id)}`, {
      method: "DELETE"
    });

    showToast("تم حذف السورس.");
    await loadScripts();
  } catch (error) {
    console.error("Deleting script failed:", error);
    showToast("تعذّر حذف السورس.");
  }
}

async function copyEditorCode() {
  try {
    await navigator.clipboard.writeText(elements.scriptCode.value);
    showToast("تم نسخ الكود.");
  } catch {
    elements.scriptCode.focus();
    elements.scriptCode.select();

    showToast("حدّد الكود وانسخه يدويًا.");
  }
}

function initializeFirebase() {
  if (!firebaseConfigured) {
    console.warn(
      "Firebase is not configured. Google login is disabled."
    );

    setAuthenticatedInterface(null);
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);

    firebaseAuth = getAuth(app);

    onAuthStateChanged(firebaseAuth, async (user) => {
      setAuthenticatedInterface(user);

      if (user) {
        await loadScripts();
      }
    });
  } catch (error) {
    console.error("Firebase initialization failed:", error);
    showToast("تعذّر تشغيل Firebase. راجع الإعدادات.");
  }
}

elements.themeToggle.addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme;
  applyTheme(currentTheme === "dark" ? "light" : "dark");
});

elements.loginButton.addEventListener("click", loginWithGoogle);

elements.createButton.addEventListener("click", () => {
  openEditor();
});

elements.closeEditor.addEventListener("click", closeEditor);

elements.scriptForm.addEventListener("submit", saveScript);

elements.copyCodeButton.addEventListener("click", copyEditorCode);

elements.scriptSlug.addEventListener("input", () => {
  elements.scriptSlug.value = elements.scriptSlug.value.replace(
    /[^A-Za-z0-9_-]/g,
    ""
  );
});

initializeTheme();
initializeFirebase();
renderScripts();