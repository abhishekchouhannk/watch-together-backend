/* Watch Together — Landing page glue (background lives in sky.js) */
(function () {
    "use strict";
    const MOTTOS = {
        morning:   "Start your day watching together, anywhere.",
        afternoon: "Take a break and watch together, anywhere.",
        evening:   "Unwind and watch together, anywhere.",
        night:     "Movie nights made simple — together, anywhere.",
    };
    const CONTENT_FADE_DELAY = 450; // matches old contentFadeDelay
    function boot() {
        const content = document.getElementById("content");
        SkyBackground.start({
            onThemeApplied(theme) {
                document.getElementById("motto").textContent = MOTTOS[theme];
            },
            onReady() {
                setTimeout(() => content.classList.add("visible"), CONTENT_FADE_DELAY);
            },
            onReset() {
                content.classList.remove("visible");
            },
        });
        document.getElementById("btn-start").addEventListener("click", () => {
            window.location.href = "/auth?mode=login&from=landing";
        });
        document.getElementById("btn-learn").addEventListener("click", () => {
            window.location.href = "/auth?mode=register&from=landing";
        });
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
