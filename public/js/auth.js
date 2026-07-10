/* ============================================
   Watch Together — Auth page (login / register / forgotPassword)
   Mirrors the old React AuthForm. API base is now RELATIVE since
   the frontend is served by the same Express app.
   ============================================ */
(function () {
    "use strict";
    const AUTH_BASE    = "/api/auth";
    const MESSAGE_TTL  = 3500;   // auto-clear messages (same as React)
    const VALID_MODES  = ["login", "register", "forgotPassword"];
    // sanitize headers to prevent invalid characters (ported from React)
    const safe = (str) =>
        str
            ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7F]/g, "")
            : "Unknown";
    // ── Elements ────────────────────────────────────────────────────
    const card        = document.getElementById("auth-card");
    const form        = document.getElementById("auth-form");
    const emailEl     = document.getElementById("email");
    const usernameEl  = document.getElementById("username");
    const passwordEl  = document.getElementById("password");
    const messageEl   = document.getElementById("form-message");
    const submitBtn   = document.getElementById("submit-btn");
    const submitLabel = document.getElementById("submit-label");
    const spinner     = document.getElementById("spinner");
    const brandBar    = document.getElementById("brand-bar");
    const pageContent = document.getElementById("page-content");
    // ── State ───────────────────────────────────────────────────────
    const params      = new URLSearchParams(window.location.search);
    const fromLanding = params.get("from") === "landing";
    let mode          = VALID_MODES.includes(params.get("mode")) ? params.get("mode") : "login";
    let isLoading     = false;
    let messageTimer  = null;
    let cachedLocation = null;   // avoid re-fetching geo on every submit
    const SUBMIT_LABELS = {
        login: "Sign In",
        register: "Create Account",
        forgotPassword: "Send Reset Link",
    };
    // ── Background ──────────────────────────────────────────────────
    SkyBackground.start({
        onReady() {
            setTimeout(() => pageContent.classList.add("visible"), 300);
            if (fromLanding) {
                brandBar.hidden = false;
                setTimeout(() => brandBar.classList.add("visible"), 500);
            }
        },
        onReset() {
            pageContent.classList.remove("visible");
            brandBar.classList.remove("visible");
        },
    });
    // ── Already logged in? → dashboard (ported from auth page) ──────
    (async function checkLoginStatus() {
        try {
            const res = await fetch(`${AUTH_BASE}/loggedIn`, {
                credentials: "include",
            });
            if (res.ok) {
                const data = await res.json();
                if (data.loggedIn) window.location.replace("/dashboard");
            }
        } catch {
            console.log("Not logged in");
        }
    })();
    // ── Mode handling ────────────────────────────────────────────────
    function setMode(newMode) {
        mode = newMode;
        card.dataset.mode = newMode;
        // Pills active state
        card.querySelectorAll(".pill").forEach((p) => {
            p.classList.toggle("active", p.dataset.setMode === newMode);
        });
        // Hidden inputs must be disabled so native validation skips them
        usernameEl.disabled = newMode !== "register";
        passwordEl.disabled = newMode === "forgotPassword";
        passwordEl.autocomplete =
            newMode === "register" ? "new-password" : "current-password";
        submitLabel.textContent = SUBMIT_LABELS[newMode];
        // Clear form + messages (same as React toggleMode)
        form.reset();
        clearMessage();
        // Keep URL in sync so refresh / share preserves the view
        const qs = new URLSearchParams();
        qs.set("mode", newMode);
        if (fromLanding) qs.set("from", "landing");
        history.replaceState(null, "", `/auth?${qs.toString()}`);
    }
    card.querySelectorAll("[data-set-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.dataset.setMode !== mode) setMode(btn.dataset.setMode);
        });
    });
    // ── Messages ────────────────────────────────────────────────────
    function showMessage(text, type) {
        clearTimeout(messageTimer);
        messageEl.textContent = text;
        messageEl.className = `form-message ${type}`;   // "error" | "success"
        messageEl.hidden = false;
        messageTimer = setTimeout(clearMessage, MESSAGE_TTL);
    }
    function clearMessage() {
        clearTimeout(messageTimer);
        messageEl.hidden = true;
        messageEl.textContent = "";
        messageEl.className = "form-message";
    }
    // ── Loading state ────────────────────────────────────────────────
    function setLoading(loading) {
        isLoading = loading;
        submitBtn.disabled = loading;
        spinner.hidden = !loading;
        submitLabel.textContent = loading ? "Processing..." : SUBMIT_LABELS[mode];
        [emailEl, usernameEl, passwordEl].forEach((el) => {
            // keep mode-based disabling intact
            if (loading) el.dataset.wasDisabled = el.disabled ? "1" : "";
            el.disabled = loading || el.dataset.wasDisabled === "1";
            if (!loading) delete el.dataset.wasDisabled;
        });
        // re-apply mode rules after unlock
        if (!loading) {
            usernameEl.disabled = mode !== "register";
            passwordEl.disabled = mode === "forgotPassword";
        }
    }
    // ── Device / location info (ported from React) ──────────────────
    async function getClientInfo() {
        const userAgent  = navigator.userAgent;
        const deviceType = /Mobi|Android/i.test(userAgent) ? "Mobile" : "Desktop";
        if (cachedLocation === null) {
            try {
                const locRes = await fetch("https://ipapi.co/json");
                if (locRes.ok) {
                    const locData = await locRes.json();
                    cachedLocation = `${locData.city}, ${locData.country_name}`;
                } else {
                    cachedLocation = "Unknown";
                }
            } catch (err) {
                console.warn("Location fetch failed:", err);
                cachedLocation = "Unknown";
            }
        }
        return { userAgent, deviceType, location: cachedLocation };
    }
    // ── Submit ──────────────────────────────────────────────────────
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (isLoading) return;
        setLoading(true);
        clearMessage();
        try {
            let endpoint = "";
            let body = {};
            const email    = emailEl.value;
            const username = usernameEl.value;
            const password = passwordEl.value;
            if (mode === "login") {
                endpoint = `${AUTH_BASE}/login`;
                body = { email, password };
            } else if (mode === "register") {
                endpoint = `${AUTH_BASE}/register`;
                body = { email, username, password };
            } else {
                endpoint = `${AUTH_BASE}/forgot-password`;
                body = { email };
            }
            console.log(endpoint);
            const info = await getClientInfo();
            console.log(info);
            const response = await fetch(endpoint, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                    "device-type": safe(info.deviceType),
                    "location":    safe(info.location),
                    "user-agent":  safe(info.userAgent),
                },
                body: JSON.stringify(body),
            });
            console.log(body);
            console.log(response);
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || "Request failed");
            }
            showMessage(data.message || "Request successful!", "success");
            // Only login/register continue to the dashboard.
            // (forgotPassword just shows the "email sent" message.)
            if (mode !== "forgotPassword") {
                setTimeout(() => { window.location.href = "/dashboard"; }, 1000);
            }
        } catch (error) {
            showMessage(error.message || "An error occurred. Please try again.", "error");
        } finally {
            setLoading(false);
        }
    });
    // ── Init ────────────────────────────────────────────────────────
    setMode(mode);
})();