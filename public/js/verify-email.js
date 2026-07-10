/* Watch Together — Verify email page */
(function () {
    "use strict";
    const AUTH_BASE = "/api/auth";
    const pageContent  = document.getElementById("page-content");
    const stateLoading = document.getElementById("state-loading");
    const stateSuccess = document.getElementById("state-success");
    const stateError   = document.getElementById("state-error");
    const successMsg   = document.getElementById("success-msg");
    const errorMsg     = document.getElementById("error-msg");
    const resendForm   = document.getElementById("resend-form");
    const resendEmail  = document.getElementById("resend-email");
    const resendStatus = document.getElementById("resend-status");
    SkyBackground.start({
        onReady() {
            setTimeout(() => pageContent.classList.add("visible"), 300);
        },
        onReset() {
            pageContent.classList.remove("visible");
        },
    });
    function show(state, message) {
        stateLoading.hidden = state !== "loading";
        stateSuccess.hidden = state !== "success";
        stateError.hidden   = state !== "error";
        if (state === "success") successMsg.textContent = message;
        if (state === "error")   errorMsg.textContent   = message;
    }
    // ── Verify on load ──────────────────────────────────────────────
    (async function verify() {
        const token = new URLSearchParams(window.location.search).get("token");
        if (!token) {
            show("error", "No verification token found in the link.");
            return;
        }
        try {
            const res = await fetch(`${AUTH_BASE}/verify-email/${encodeURIComponent(token)}`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            const data = await res.json();
            if (res.ok) {
                show("success", data.message || "Email verified successfully!");
            } else {
                show("error", data.message || "Verification failed. The link may be invalid or expired.");
            }
        } catch {
            show("error", "An unexpected error occurred during verification.");
        }
    })();
    // ── Resend ──────────────────────────────────────────────────────
    resendForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        resendStatus.hidden = false;
        resendStatus.textContent = "Sending...";
        try {
            const res = await fetch(`${AUTH_BASE}/resend-verification`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: resendEmail.value }),
            });
            const data = await res.json();
            resendStatus.textContent = res.ok
                ? (data.message || "A new verification link has been sent!")
                : (data.message || "Failed to send verification link.");
        } catch {
            resendStatus.textContent = "Something went wrong. Please try again.";
        }
    });
})();