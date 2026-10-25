
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";

import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDBKv4SEWioEMjIjawuQLs1nKxqYolTsvw",
    authDomain: "lunex-a085c.firebaseapp.com",
    projectId: "lunex-a085c",
    appId: "1:614659495740:web:5f3c762a7c9ee362807039"
};

const $ = id => document.getElementById(id);

const loginButton = $("login-button");
const logoutButton = $("logout-button");
const userStatus = $("user-status");
const newScriptButton = $("new-script-button");
const scriptForm = $("script-form");
const titleInput = $("script-title");
const sourceInput = $("script-source");
const cancelButton = $("cancel-script-button");
const scriptsList = $("scripts-list");
const message = $("message");
const yearElement = $("current-year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}

let auth = null;
let currentUser = null;
let scripts = [];
let editingId = null;
let busy = false;
let authCheckVersion = 0;

function showMessage(text, isError = false) {
    if (!message) return;

    message.textContent = text;
    message.style.color = isError ? "#ff7b89" : "";
}

function setBusy(value) {
    busy = value;

    if (loginButton) loginButton.disabled = value;
    if (logoutButton) logoutButton.disabled = value;
    if (newScriptButton) newScriptButton.disabled = value;
    if (cancelButton) cancelButton.disabled = value;

    const submitButton = scriptForm?.querySelector(
        'button[type="submit"], input[type="submit"]'
    );

    if (submitButton) submitButton.disabled = value;
}

async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };

    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    if (currentUser) {
        const token = await currentUser.getIdToken();
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
        ...options,
        headers
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            data.error ||
            data.message ||
            `حدث خطأ في الاتصال (${response.status})`
        );
    }

    return data;
}

function resetForm() {
    editingId = null;

    if (scriptForm) {
        scriptForm.reset();
        scriptForm.hidden = true;
    }

    if (titleInput) titleInput.disabled = false;
    if (sourceInput) sourceInput.disabled = false;

    showMessage("");
}

function showLoggedOut() {
    if (userStatus) {
        userStatus.textContent = "غير مسجل الدخول";
    }

    if (loginButton) loginButton.hidden = false;
    if (logoutButton) logoutButton.hidden = true;
    if (newScriptButton) newScriptButton.hidden = true;

    resetForm();
    scripts = [];

    if (scriptsList) scriptsList.replaceChildren();
}

function showLoggedIn(user) {
    if (userStatus) {
        userStatus.textContent =
            user.displayName || user.email || "تم تسجيل الدخول";
    }

    if (loginButton) loginButton.hidden = true;
    if (logoutButton) logoutButton.hidden = false;
    if (newScriptButton) newScriptButton.hidden = false;
}

function renderScripts() {
    if (!scriptsList) return;

    scriptsList.replaceChildren();

    if (scripts.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "ما عندك سورسات محفوظة حتى الآن.";
        empty.style.color = "#9292a6";
        scriptsList.append(empty);
        return;
    }

    for (const script of scripts) {
        const card = document.createElement("article");
        card.className = "script-card";

        const heading = document.createElement("h3");
        heading.textContent = script.title || "بدون اسم";

        const date = document.createElement("p");

        if (script.updated_at) {
            const parsedDate = new Date(script.updated_at);

            date.textContent = Number.isNaN(parsedDate.getTime())
                ? ""
                : `آخر تحديث: ${parsedDate.toLocaleString("ar-SA")}`;
        }

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.textContent = "عرض / تعديل";

        editButton.addEventListener("click", () => {
            openEditor(script);
        });

        card.append(heading, date, editButton);
        scriptsList.append(card);
    }
}

async function loadScripts() {
    showMessage("جاري تحميل السورسات...");

    try {
        const data = await api("/api/scripts");

        scripts = Array.isArray(data)
            ? data
            : Array.isArray(data.scripts)
                ? data.scripts
                : [];

        renderScripts();
        showMessage("");
    } catch (error) {
        showMessage(error.message || "تعذر تحميل السورسات.", true);
    }
}

async function openEditor(script = null) {
    if (busy) return;

    try {
        showMessage("");

        let selectedScript = null;

        if (script?.public_id) {
            showMessage("جاري تحميل السورس...");

            const data = await api(
                `/api/scripts/${encodeURIComponent(script.public_id)}`
            );

            if (!data?.script) {
                throw new Error("تعذر الحصول على بيانات السورس من السيرفر.");
            }

            selectedScript = data.script;
        } else if (script) {
            selectedScript = script;
        }

        editingId = selectedScript?.public_id || null;

        titleInput.value = selectedScript?.title || "";
        sourceInput.value = selectedScript?.source || "";

        scriptForm.hidden = false;
        showMessage("");
        titleInput.focus();
    } catch (error) {
        showMessage(error.message || "تعذر فتح السورس.", true);
    }
}

if (loginButton) {
    loginButton.addEventListener("click", async () => {
        if (!auth || busy) return;

        setBusy(true);

        try {
            const provider = new GoogleAuthProvider();
            await signInWithPopup(auth, provider);
        } catch (error) {
            showMessage(`تعذر تسجيل الدخول: ${error.message}`, true);
        } finally {
            setBusy(false);
        }
    });
}

if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
        if (!auth || busy) return;

        setBusy(true);

        try {
            await signOut(auth);
            currentUser = null;
            scripts = [];
            showLoggedOut();
            showMessage("تم تسجيل الخروج.");
        } catch (error) {
            showMessage(error.message, true);
        } finally {
            setBusy(false);
        }
    });
}

if (newScriptButton) {
    newScriptButton.addEventListener("click", () => {
        if (!busy) openEditor();
    });
}

if (cancelButton) {
    cancelButton.addEventListener("click", () => {
        if (!busy) resetForm();
    });
}

if (scriptForm) {
    scriptForm.addEventListener("submit", async event => {
        event.preventDefault();

        if (busy) return;

        if (!currentUser) {
            showMessage("سجّل الدخول أولًا.", true);
            return;
        }

        const title = titleInput.value.trim();
        const source = sourceInput.value;

        if (!title || !source.trim()) {
            showMessage("اكتب اسم السورس والكود أولًا.", true);
            return;
        }

        if (title.length > 80) {
            showMessage("اسم السورس يجب ألا يتجاوز 80 حرفًا.", true);
            return;
        }

        if (source.length > 200000) {
            showMessage("الكود يتجاوز الحد المسموح به.", true);
            return;
        }

        setBusy(true);
        showMessage("جاري حفظ السورس...");

        try {
            if (editingId) {
                await api(
                    `/api/scripts/${encodeURIComponent(editingId)}`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({ title, source })
                    }
                );
            } else {
                await api("/api/scripts", {
                    method: "POST",
                    body: JSON.stringify({ title, source })
                });
            }

            resetForm();
            await loadScripts();
            showMessage("تم حفظ السورس بنجاح.");
        } catch (error) {
            showMessage(error.message || "تعذر حفظ السورس.", true);
        } finally {
            setBusy(false);
        }
    });
}

async function startApp() {
    try {
        const app = initializeApp(firebaseConfig);
        auth = getAuth(app);

        onAuthStateChanged(auth, async user => {
            const version = ++authCheckVersion;
            currentUser = user;

            if (!user) {
                showLoggedOut();
                return;
            }

            showLoggedIn(user);

            try {
                await api("/api/me");

                if (
                    version !== authCheckVersion ||
                    !currentUser ||
                    currentUser.uid !== user.uid
                ) {
                    return;
                }

                await loadScripts();
            } catch (error) {
                if (version !== authCheckVersion) return;

                showMessage(error.message || "تعذر التحقق من حسابك.", true);
            }
        });
    } catch (error) {
        showMessage(`تعذر تشغيل Firebase: ${error.message}`, true);
    }
}

startApp();
