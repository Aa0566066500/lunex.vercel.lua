
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
    authDomain: "REPLACE_WITH_FIREBASE_AUTH_DOMAIN",
    projectId: "REPLACE_WITH_FIREBASE_PROJECT_ID",
    appId: "REPLACE_WITH_FIREBASE_APP_ID"
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

$("current-year").textContent = new Date().getFullYear();

let auth = null;
let currentUser = null;
let scripts = [];
let editingId = null;
let busy = false;

const configured = Object.values(firebaseConfig).every(
    value => value && !value.startsWith("REPLACE_WITH_")
);

function showMessage(text, isError = false) {
    message.textContent = text;
    message.style.color = isError ? "#ff7b89" : "";
}

function setBusy(value) {
    busy = value;
    loginButton.disabled = value;
    logoutButton.disabled = value;
    newScriptButton.disabled = value;
}

async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };

    if (options.body) {
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
        throw new Error(data.error || `حدث خطأ (${response.status})`);
    }

    return data;
}

function showLoggedOut() {
    userStatus.textContent = "غير مسجل الدخول";
    loginButton.hidden = false;
    logoutButton.hidden = true;
    newScriptButton.hidden = true;
    scriptForm.hidden = true;
    scriptsList.replaceChildren();
}

function showLoggedIn(user) {
    userStatus.textContent = user.displayName || user.email || "تم تسجيل الدخول";
    loginButton.hidden = true;
    logoutButton.hidden = false;
    newScriptButton.hidden = false;
}

function resetForm() {
    editingId = null;
    scriptForm.reset();
    scriptForm.hidden = true;
    titleInput.disabled = false;
    sourceInput.disabled = false;
    showMessage("");
}

function renderScripts() {
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
        heading.textContent = script.title;

        const date = document.createElement("p");
        date.textContent = script.updated_at
            ? `آخر تحديث: ${new Date(script.updated_at).toLocaleString("ar-SA")}`
            : "";

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.textContent = "عرض / تعديل";
        editButton.addEventListener("click", () => openEditor(script));

        card.append(heading, date, editButton);
        scriptsList.append(card);
    }
}

async function loadScripts() {
    showMessage("جاري تحميل السورسات...");

    try {
        const data = await api("/api/scripts");
        scripts = Array.isArray(data) ? data : data.scripts || [];
        renderScripts();
        showMessage("");
    } catch (error) {
        showMessage(error.message, true);
    }
}

function openEditor(script = null) {
    editingId = script?.public_id || null;

    titleInput.value = script?.title || "";
    sourceInput.value = script?.source || "";

    scriptForm.hidden = false;
    showMessage("");

    titleInput.focus();
}

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

newScriptButton.addEventListener("click", () => openEditor());

cancelButton.addEventListener("click", resetForm);

scriptForm.addEventListener("submit", async event => {
    event.preventDefault();

    if (busy) return;

    const title = titleInput.value.trim();
    const source = sourceInput.value;

    if (!title || !source.trim()) {
        showMessage("اكتب اسم السورس والكود أولًا.", true);
        return;
    }

    setBusy(true);
    showMessage("جاري حفظ السورس...");

    try {
        if (editingId) {
            await api(`/api/scripts/${encodeURIComponent(editingId)}`, {
                method: "PATCH",
                body: JSON.stringify({ title, source })
            });
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
        showMessage(error.message, true);
    } finally {
        setBusy(false);
    }
});

async function startApp() {
    if (!configured) {
        showLoggedOut();
        showMessage(
            "أضف إعدادات Firebase الصحيحة داخل app.js لتفعيل تسجيل الدخول.",
            true
        );
        loginButton.disabled = true;
        return;
    }

    try {
        const app = initializeApp(firebaseConfig);
        auth = getAuth(app);

        onAuthStateChanged(auth, async user => {
            currentUser = user;

            if (!user) {
                showLoggedOut();
                return;
            }

            showLoggedIn(user);

            try {
                await api("/api/me");
                await loadScripts();
            } catch (error) {
                showMessage(error.message, true);
            }
        });
    } catch (error) {
        showMessage(`تعذر تشغيل Firebase: ${error.message}`, true);
    }
}

startApp();
