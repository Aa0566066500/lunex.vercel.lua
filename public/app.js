"use strict";

const $ = (selector) => document.querySelector(selector);

const state = {
  user: null,
  scripts: [],
  editingId: null,
  busy: false
};

const elements = {
  auth: $("#auth-section"),
  dashboard: $("#dashboard-section"),
  loginForm: $("#login-form"),
  registerForm: $("#register-form"),
  verifyForm: $("#verify-form"),
  forgotForm: $("#forgot-form"),
  resetForm: $("#reset-form"),
  scriptForm: $("#script-form"),
  scriptsList: $("#scripts-list"),
  message: $("#auth-message") || $("#message"),
  scriptMessage: $("#script-message"),
  status: $("#user-status")
};

function setMessage(element, message, type = "") {
  if (!element) return;

  element.textContent = message;
  element.className = "message";

  if (type) element.classList.add(type);
  element.hidden = !message;
}

function showMessage(message, type = "") {
  setMessage(elements.message, message, type);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const contentType = response.headers.get("content-type") || "";
  let data = {};

  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    const text = await response.text();
    data = { error: text || "حدث خطأ غير متوقع." };
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || "تعذر تنفيذ الطلب.");
  }

  return data;
}

function showSection(section) {
  if (elements.auth) {
    elements.auth.hidden = section !== "auth";
  }

  if (elements.dashboard) {
    elements.dashboard.hidden = section !== "dashboard";
  }
}

function showAuthForm(formName) {
  const forms = [
    elements.loginForm,
    elements.registerForm,
    elements.verifyForm,
    elements.forgotForm,
    elements.resetForm
  ];

  forms.forEach((form) => {
    if (form) form.hidden = true;
  });

  const selected = {
    login: elements.loginForm,
    register: elements.registerForm,
    verify: elements.verifyForm,
    forgot: elements.forgotForm,
    reset: elements.resetForm
  }[formName];

  if (selected) selected.hidden = false;
  showMessage("");
}

function setBusy(form, busy) {
  if (!form) return;

  form.querySelectorAll('button[type="submit"]').forEach((button) => {
    button.disabled = busy;
  });
}

function getValue(form, name) {
  return String(new FormData(form).get(name) || "").trim();
}

function getPassword(form, name = "password") {
  return String(new FormData(form).get(name) || "");
}

function validatePassword(password) {
  return (
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /^[A-Za-z0-9]+$/.test(password)
  );
}

function validateUsername(username) {
  return /^[A-Za-z0-9_]{3,30}$/.test(username);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getTheme() {
  return document.documentElement.dataset.theme || "light";
}

function updateThemeButton() {
  const button = $("#theme-toggle");
  if (!button) return;

  const dark = getTheme() === "dark";

  button.setAttribute(
    "aria-label",
    dark ? "تفعيل الوضع الأبيض" : "تفعيل الوضع الأسود"
  );

  button.setAttribute("title", dark ? "الوضع الأبيض" : "الوضع الأسود");
}

function initTheme() {
  let savedTheme = "light";

  try {
    savedTheme = localStorage.getItem("lunex-theme") || "light";
  } catch {
    // نستخدم الوضع الأبيض إذا كان التخزين غير متاح.
  }

  document.documentElement.dataset.theme =
    savedTheme === "dark" ? "dark" : "light";

  updateThemeButton();

  $("#theme-toggle")?.addEventListener("click", () => {
    const nextTheme = getTheme() === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = nextTheme;

    try {
      localStorage.setItem("lunex-theme", nextTheme);
    } catch {
      // يظل تغيير الثيم فعالًا خلال الجلسة الحالية.
    }

    updateThemeButton();
  });
}

function updateAccountUI() {
  const loggedIn = Boolean(state.user);

  showSection(loggedIn ? "dashboard" : "auth");

  if (elements.status) {
    elements.status.textContent = loggedIn
      ? state.user.username
      : "غير مسجل الدخول";
  }

  const loginButton = $("#login-button");
  const logoutButton = $("#logout-button");

  if (loginButton) loginButton.hidden = loggedIn;
  if (logoutButton) logoutButton.hidden = !loggedIn;
}

function renderScripts() {
  const container = elements.scriptsList;
  if (!container) return;

  container.replaceChildren();

  if (!state.scripts.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const heading = document.createElement("h3");
    heading.textContent = "ما عندك سكربتات محفوظة حتى الآن";

    const description = document.createElement("p");
    description.textContent = "أنشئ أول سكربت واحفظه في حسابك.";

    empty.append(heading, description);
    container.append(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "scripts-grid";

  state.scripts.forEach((script) => {
    const card = document.createElement("article");
    card.className = "script-card";

    const title = document.createElement("h3");
    title.textContent = script.title || "سكربت بدون عنوان";

    const updated = document.createElement("p");
    updated.textContent = script.updated_at
      ? `آخر تحديث: ${new Date(script.updated_at).toLocaleString("ar-SA")}`
      : "";

    const preview = document.createElement("pre");
    preview.textContent = String(script.source || "").slice(0, 1200);

    const actions = document.createElement("div");
    actions.className = "button-row";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "تعديل";
    editButton.addEventListener("click", () => editScript(script));

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "secondary-button";
    copyButton.textContent = "نسخ الكود";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(script.source || ""));
        setMessage(elements.scriptMessage, "تم نسخ الكود.", "success");
      } catch {
        setMessage(
          elements.scriptMessage,
          "تعذر النسخ تلقائيًا. افتح السكربت وانسخ النص يدويًا.",
          "error"
        );
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "secondary-button";
    deleteButton.textContent = "حذف";
    deleteButton.addEventListener("click", () => deleteScript(script));

    actions.append(editButton, copyButton, deleteButton);
    card.append(title, updated, preview, actions);
    grid.append(card);
  });

  container.append(grid);
}

async function loadScripts() {
  const result = await api("/api/scripts");
  state.scripts = Array.isArray(result.scripts) ? result.scripts : [];
  renderScripts();
}

function editScript(script) {
  state.editingId = script.id;

  const title = $("#script-title");
  const source = $("#script-source");

  if (title) title.value = script.title || "";
  if (source) source.value = script.source || "";

  if (elements.scriptForm) {
    elements.scriptForm.hidden = false;
    elements.scriptForm.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

  const submitButton = elements.scriptForm?.querySelector(
    'button[type="submit"]'
  );

  if (submitButton) submitButton.textContent = "حفظ التعديلات";
}

function resetScriptForm() {
  state.editingId = null;
  elements.scriptForm?.reset();

  if (elements.scriptForm) elements.scriptForm.hidden = true;

  const submitButton = elements.scriptForm?.querySelector(
    'button[type="submit"]'
  );

  if (submitButton) submitButton.textContent = "حفظ السكربت";

  setMessage(elements.scriptMessage, "");
}

async function deleteScript(script) {
  if (!confirm(`هل أنت متأكد من حذف "${script.title}"؟`)) return;

  try {
    await api(`/api/scripts/${encodeURIComponent(script.id)}`, {
      method: "DELETE"
    });

    await loadScripts();
    setMessage(elements.scriptMessage, "تم حذف السكربت.", "success");
  } catch (error) {
    setMessage(elements.scriptMessage, error.message, "error");
  }
}

async function handleRegister(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const username = getValue(form, "username");
  const email = getValue(form, "email").toLowerCase();
  const password = getPassword(form);
  const confirmPassword = getPassword(form, "confirmPassword");

  if (!validateUsername(username)) {
    showMessage(
      "اسم المستخدم يجب أن يكون من 3 إلى 30 حرفًا، ويحتوي على أحرف إنجليزية أو أرقام أو _ فقط.",
      "error"
    );
    return;
  }

  if (!validateEmail(email)) {
    showMessage("أدخل بريدًا إلكترونيًا صحيحًا.", "error");
    return;
  }

  if (!validatePassword(password)) {
    showMessage(
      "كلمة المرور يجب أن تكون 8 أحرف على الأقل، وتحتوي على حرف كبير وحرف صغير ورقم، دون رموز أو مسافات.",
      "error"
    );
    return;
  }

  if (password !== confirmPassword) {
    showMessage("كلمتا المرور غير متطابقتين.", "error");
    return;
  }

  setBusy(form, true);
  showMessage("جارٍ إنشاء الحساب وإرسال رمز التحقق...");

  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, email, password })
    });

    const verifyEmail = $("#verify-email");
    if (verifyEmail) verifyEmail.value = email;

    showAuthForm("verify");
    showMessage("أرسلنا رمز التحقق إلى بريدك إذا نجح إرسال الرسالة.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(form, false);
  }
}

async function handleVerify(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const email = getValue(form, "email").toLowerCase();
  const code = getValue(form, "code");

  if (!/^\d{6}$/.test(code)) {
    showMessage("رمز التحقق يجب أن يتكون من 6 أرقام.", "error");
    return;
  }

  setBusy(form, true);
  showMessage("جارٍ التحقق من الرمز...");

  try {
    await api("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ email, code })
    });

    showAuthForm("login");

    const loginEmail = $("#login-email");
    if (loginEmail) loginEmail.value = email;

    showMessage("تم التحقق من البريد. تقدر تسجل الدخول الآن.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(form, false);
  }
}

async function handleResendCode(event) {
  event?.preventDefault();

  const form = elements.verifyForm;
  const email = getValue(form, "email").toLowerCase();

  if (!validateEmail(email)) {
    showMessage("أدخل البريد الإلكتروني أولًا.", "error");
    return;
  }

  try {
    await api("/api/auth/resend-code", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    showMessage("إذا كان الحساب يحتاج إلى تحقق، فستصلك رسالة جديدة.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function handleLogin(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const email = getValue(form, "email").toLowerCase();
  const password = getPassword(form);

  if (!validateEmail(email) || !password) {
    showMessage("أدخل البريد الإلكتروني وكلمة المرور.", "error");
    return;
  }

  setBusy(form, true);
  showMessage("جارٍ تسجيل الدخول...");

  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    state.user = result.user || null;
    updateAccountUI();
    await loadScripts();
    showMessage("");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(form, false);
  }
}

async function handleForgot(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const email = getValue(form, "email").toLowerCase();

  if (!validateEmail(email)) {
    showMessage("أدخل بريدًا إلكترونيًا صحيحًا.", "error");
    return;
  }

  setBusy(form, true);
  showMessage("جارٍ إرسال التعليمات...");

  try {
    await api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    showMessage(
      "إذا كان البريد مسجلًا، فستصلك رسالة تحتوي على تعليمات إعادة تعيين كلمة المرور.",
      "success"
    );
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(form, false);
  }
}

async function handleReset(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const password = getPassword(form);
  const confirmPassword = getPassword(form, "confirmPassword");
  const token = new URLSearchParams(location.search).get("reset");

  if (!token) {
    showMessage("رابط إعادة التعيين غير مكتمل. افتح الرابط الموجود في البريد.", "error");
    return;
  }

  if (!validatePassword(password)) {
    showMessage(
      "كلمة المرور يجب أن تكون 8 أحرف على الأقل، وتشمل حرفًا كبيرًا وصغيرًا ورقمًا.",
      "error"
    );
    return;
  }

  if (password !== confirmPassword) {
    showMessage("كلمتا المرور غير متطابقتين.", "error");
    return;
  }

  setBusy(form, true);
  showMessage("جارٍ تغيير كلمة المرور...");

  try {
    await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password })
    });

    history.replaceState({}, "", location.pathname);

    showAuthForm("login");
    showMessage("تم تغيير كلمة المرور. سجل الدخول بكلمتك الجديدة.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(form, false);
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // ننهي واجهة المستخدم محليًا حتى لو فشل الطلب.
  }

  state.user = null;
  state.scripts = [];
  updateAccountUI();
  showAuthForm("login");
}

async function handleScriptSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const title = getValue(form, "title");
  const source = getValue(form, "source");

  if (!title || !source) {
    setMessage(elements.scriptMessage, "اكتب اسم السكربت والكود.", "error");
    return;
  }

  setBusy(form, true);

  try {
    if (state.editingId !== null) {
      await api(`/api/scripts/${encodeURIComponent(state.editingId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title, source })
      });
    } else {
      await api("/api/scripts", {
        method: "POST",
        body: JSON.stringify({ title, source })
      });
    }

    resetScriptForm();
    await loadScripts();
    setMessage(elements.scriptMessage, "تم حفظ السكربت بنجاح.", "success");
  } catch (error) {
    setMessage(elements.scriptMessage, error.message, "error");
  } finally {
    setBusy(form, false);
  }
}

function bindNavigation() {
  $("#login-button")?.addEventListener("click", () => {
    showAuthForm("login");
    showSection("auth");
  });

  $("#logout-button")?.addEventListener("click", handleLogout);

  $("#show-register")?.addEventListener("click", () => showAuthForm("register"));
  $("#show-login")?.addEventListener("click", () => showAuthForm("login"));
  $("#show-forgot")?.addEventListener("click", () => showAuthForm("forgot"));
  $("#back-to-login")?.addEventListener("click", () => showAuthForm("login"));
  $("#back-to-login-from-reset")?.addEventListener("click", () => showAuthForm("login"));

  $("#resend-code")?.addEventListener("click", handleResendCode);

  $("#new-script-button")?.addEventListener("click", () => {
    resetScriptForm();

    if (elements.scriptForm) {
      elements.scriptForm.hidden = false;
      elements.scriptForm.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }

    $("#script-title")?.focus();
  });

  $("#cancel-script-button")?.addEventListener("click", resetScriptForm);
}

function bindForms() {
  elements.loginForm?.addEventListener("submit", handleLogin);
  elements.registerForm?.addEventListener("submit", handleRegister);
  elements.verifyForm?.addEventListener("submit", handleVerify);
  elements.forgotForm?.addEventListener("submit", handleForgot);
  elements.resetForm?.addEventListener("submit", handleReset);
  elements.scriptForm?.addEventListener("submit", handleScriptSubmit);
}

async function init() {
  initTheme();
  bindNavigation();
  bindForms();

  const year = $("#current-year");
  if (year) year.textContent = String(new Date().getFullYear());

  const resetToken = new URLSearchParams(location.search).get("reset");

  if (resetToken) {
    showAuthForm("reset");
  } else {
    showAuthForm("login");
  }

  try {
    const result = await api("/api/me");

    if (result.user) {
      state.user = result.user;
      updateAccountUI();
      await loadScripts();
    } else {
      updateAccountUI();
    }
  } catch {
    state.user = null;
    updateAccountUI();
  }
}

document.addEventListener("DOMContentLoaded", init);