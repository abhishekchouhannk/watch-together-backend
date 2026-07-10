/* Watch Together — Reset password page */
(function () {
    "use strict";
    const AUTH_BASE = "/api/auth";
    const pageContent = document.getElementById("page-content");
    const resetForm   = document.getElementById("reset-form");
    const noTokenMsg  = document.getElementById("no-token-msg");
    const messageEl   = document.getElementById("form-message");
    const passwordEl  = document.getElementById("password");
    const confirmEl   = document.getElementById("confirm-password");
    const submitBtn   = document.getElementById("submit-btn");
    const submitLabel = document.getElementById("submit-label");
    const spinner     = document.getElementById("spinner");
    SkyBackground.start({
        onReady() {
            setTimeout(() => pageContent.classList.add("visible"), 300);
        },
        onReset() {
            pageContent.classList.remove("visible");
        },
    });
    // Token comes from the path: /reset-password/<token>
    // (Express serves this same HTML for both /reset-password and
    //  /reset-password/:token — we detect which one we're on here.)
    const segments = window.location.pathname.split("/").filter(Boolean);
    const token = segments.length >= 2 ? decodeURIComponent(segments[1]) : null;
    if (!token) {
        noTokenMsg.hidden = false;        // "Please use the link from your email."
    } else {
        resetForm.hidden = false;
    }
    function showMessage(text, type) {
        messageEl.textContent = text;
        messageEl.className = `form-message ${type}`;
        messageEl.hidden = false;
    }
    function setLoading(loading) {
        submitBtn.disabled = loading;
        spinner.hidden = !loading;
        submitLabel.textContent = loading ? "Resetting..." : "Reset Password";
    }
    resetForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (passwordEl.value !== confirmEl.value) {
            showMessage("Passwords do not match.", "error");
            return;
        }
        setLoading(true);
        messageEl.hidden = true;
        try {
            const res = await fetch(`${AUTH_BASE}/reset-password/${encodeURIComponent(token)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: passwordEl.value }),
            });
            const data = await res.json();
            if (data.success) {
                showMessage("Password reset successfully! Redirecting to login...", "success");
                resetForm.hidden = true;
                setTimeout(() => { window.location.href = "/login"; }, 3000);
            } else {
                showMessage(data.message || "Failed to reset password.", "error");
                setLoading(false);
            }
        } catch (err) {
            console.error("Reset password error:", err);
            showMessage("Something went wrong. Please try again.", "error");
            setLoading(false);
        }
    });
})();