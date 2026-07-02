/* ============================================
   Watch Together — Landing Page Controller
   ============================================
   Layer stack (back → front):
     sky → far clouds → near clouds → content → element (moon)
   Reveal sequence (sequential, so every layer gets noticed):
     1. Sky fades in
     2. Content fades in
     3. Far-layer clouds merge in (slower, larger sprites)
     4. Near-layer clouds merge in (after far finishes, slightly faster)
     5. Element (moon/etc) fades in last, on top of everything
   Test any theme with:  ?theme=morning | afternoon | evening | night
   ============================================ */
// ─── Theme configuration ────────────────────────────────────────────
const THEMES = {
    morning: {
        name: "morning",
        motto: "Start your day watching together, anywhere.",
    },
    afternoon: {
        name: "afternoon",
        motto: "Take a break and watch together, anywhere.",
    },
    evening: {
        name: "evening",
        motto: "Unwind and watch together, anywhere.",
    },
    night: {
        name: "night",
        motto: "Movie nights made simple — together, anywhere.",
    },
};
// ─── Timing constants (ms) ──────────────────────────────────────────
// Durations for cloud transitions MUST match the CSS transition-duration
// values for .cloud-half (far = 1000ms, near = 800ms).
const TIMING = {
    skyFadeDelay: 150,
    contentFadeDelay: 450,
    farSlideDelay: 400,
    farSlideDuration: 1000,
    farToNearGap: -400,        // pause after far finishes, before near starts
    nearSlideDuration: 200,   // duration for near cloud slide
    loopActivateGap: 800,     // gap after a slide finishes before swapping to loop
    elementFadeGap: 450,      // gap after near loop activates before moon appears
};
// ─── Asset path helper ──────────────────────────────────────────────
function themeAssets(themeName) {
    const base = `/assets/${themeName}`;
    return {
        sky: `${base}/sky.png`,
        element: `${base}/element.png`,
        far: {
            left: `${base}/farLayer/left.png`,
            right: `${base}/farLayer/right.png`,
            full: `${base}/farLayer/full.png`,
        },
        near: {
            left: `${base}/nearLayer/left.png`,
            right: `${base}/nearLayer/right.png`,
            full: `${base}/nearLayer/full.png`,
        },
    };
}
// ─── Utilities ──────────────────────────────────────────────────────
function getTimeOfDay() {
    const override = new URLSearchParams(window.location.search).get("theme");
    if (override && THEMES[override]) return override;
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 20) return "evening";
    return "night";
}
function preloadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(src);
        img.onerror = () => reject(src);
        img.src = src;
    });
}
function preloadAllAssets(themeName) {
    const a = themeAssets(themeName);
    const urls = [
        a.sky,
        a.element,
        a.far.left, a.far.right, a.far.full,
        a.near.left, a.near.right, a.near.full,
    ];
    return Promise.allSettled(urls.map(preloadImage));
}
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─── DOM setup ──────────────────────────────────────────────────────
function applyTheme(themeName) {
    const landing = document.getElementById("landing");
    landing.setAttribute("data-theme", themeName);
    document.getElementById("motto").textContent = THEMES[themeName].motto;
}
function setCloudSources(layerId, assets) {
    const layer = document.getElementById(layerId);
    layer.querySelector(".cloud-half.left").src = assets.left;
    layer.querySelector(".cloud-half.right").src = assets.right;
    layer.querySelectorAll(".cloud-full").forEach((img) => {
        img.src = assets.full;
    });
}
function setStaticSources(themeName) {
    const assets = themeAssets(themeName);
    document.getElementById("sky-image").src = assets.sky;
    document.getElementById("element-image").src = assets.element;
}
// ─── Animation orchestration ────────────────────────────────────────
async function runIntro(themeName) {
    const sky = document.getElementById("sky-image");
    const element = document.getElementById("element-image");
    const content = document.getElementById("content");
    const farLayer = document.getElementById("far-cloud-layer");
    const nearLayer = document.getElementById("near-cloud-layer");
    // Preload everything, with a small minimum delay so the
    // bg-color isn't replaced the instant the page paints.
    await Promise.all([preloadAllAssets(themeName), delay(150)]);
    // ① Sky fades in
    setTimeout(() => sky.classList.add("visible"), TIMING.skyFadeDelay);
    // ② Content fades in
    setTimeout(() => content.classList.add("visible"), TIMING.contentFadeDelay);
    // ③ Far clouds slide in
    const farStart = TIMING.farSlideDelay;
    const farEnd = farStart + TIMING.farSlideDuration;
    setTimeout(() => slideIn(farLayer), farStart);
    setTimeout(() => activateLoop(farLayer), farEnd + TIMING.loopActivateGap);
    // ④ Near clouds slide in — only once far has finished merging,
    //    so the user clearly sees each layer arrive in turn.
    const nearStart = farEnd + TIMING.farToNearGap;
    const nearEnd = nearStart + TIMING.nearSlideDuration;
    setTimeout(() => slideIn(nearLayer), nearStart);
    setTimeout(() => activateLoop(nearLayer), nearEnd + TIMING.loopActivateGap);
    // ⑤ Element (moon/etc) fades in last, on top of everything
    const elementStart = nearEnd + TIMING.loopActivateGap + TIMING.elementFadeGap;
    setTimeout(() => element.classList.add("visible"), elementStart);
}
function slideIn(layerEl) {
    layerEl.querySelectorAll(".cloud-half").forEach((el) => {
        el.classList.add("slide-in");
    });
}
function activateLoop(layerEl) {
    const intro = layerEl.querySelector(".cloud-intro");
    const scroll = layerEl.querySelector(".cloud-scroll");
    scroll.classList.add("active", "scrolling");
    intro.style.display = "none";
}
function resetAnimations() {
    document.getElementById("sky-image").classList.remove("visible");
    document.getElementById("element-image").classList.remove("visible");
    document.getElementById("content").classList.remove("visible");
    document.querySelectorAll(".cloud-layer").forEach((layer) => {
        const intro = layer.querySelector(".cloud-intro");
        intro.style.display = "";
        intro.querySelectorAll(".cloud-half").forEach((h) => {
            h.classList.remove("slide-in");
        });
        const scroll = layer.querySelector(".cloud-scroll");
        scroll.classList.remove("active", "scrolling");
    });
}
// ─── Boot ───────────────────────────────────────────────────────────
function init() {
    const time = getTimeOfDay();
    applyTheme(time);
    setStaticSources(time);
    const assets = themeAssets(time);
    setCloudSources("far-cloud-layer", assets.far);
    setCloudSources("near-cloud-layer", assets.near);
    runIntro(time);
}
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
        resetAnimations();
        init();
    }
});