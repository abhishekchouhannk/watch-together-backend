/* ============================================
   Watch Together — Landing Page Controller
   ============================================
   Animation sequence:
   ┌──────────┬─────────────────────────────────────────┐
   │ 0 ms     │ Background gradient visible              │
   │ 300 ms   │ Content (title/motto/buttons) fades up   │
   │ wait…    │ Cloud images finish preloading            │
   │ +0 ms    │ Far-layer halves slide in from edges      │
   │ +300 ms  │ Near-layer halves slide in from edges     │
   │ +2200 ms │ Halves are in place → swap to scroll loop │
   │ ∞        │ Clouds drift left-to-right forever        │
   └──────────┴─────────────────────────────────────────┘
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
// ─── Asset path helper ──────────────────────────────────────────────
function cloudAssets(themeName) {
    const base = `/assets/${themeName}`;
    return {
        far: {
            left:  `${base}/farLayer/left.png`,
            right: `${base}/farLayer/right.png`,
            full:  `${base}/farLayer/full.png`,
        },
        near: {
            left:  `${base}/nearLayer/left.png`,
            right: `${base}/nearLayer/right.png`,
            full:  `${base}/nearLayer/full.png`,
        },
    };
}
// ─── Utilities ──────────────────────────────────────────────────────
/** Detect current time-of-day (or honour ?theme= override). */
function getTimeOfDay() {
    const override = new URLSearchParams(window.location.search).get("theme");
    if (override && THEMES[override]) return override;
    const h = new Date().getHours();
    if (h >= 5  && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 20) return "evening";
    return "night";
}
/** Preload a single image; resolves with its src. */
function preloadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(src);
        img.onerror = () => reject(src);
        img.src = src;
    });
}
/** Preload every cloud image for a theme.  Never rejects. */
function preloadAllClouds(themeName) {
    const a = cloudAssets(themeName);
    const urls = [
        a.far.left, a.far.right, a.far.full,
        a.near.left, a.near.right, a.near.full,
    ];
    return Promise.allSettled(urls.map(preloadImage));
}
// ─── DOM setup ──────────────────────────────────────────────────────
/** Set the data-theme attribute and populate text. */
function applyTheme(themeName) {
    const landing = document.getElementById("landing");
    landing.setAttribute("data-theme", themeName);
    document.getElementById("motto").textContent = THEMES[themeName].motto;
}
/** Point every <img> inside a cloud layer at the right asset. */
function setCloudSources(layerId, assets) {
    const layer = document.getElementById(layerId);
    // intro halves
    layer.querySelector(".cloud-half.left").src  = assets.left;
    layer.querySelector(".cloud-half.right").src = assets.right;
    // scroll full copies
    layer.querySelectorAll(".cloud-full").forEach((img) => {
        img.src = assets.full;
    });
}
// ─── Animation orchestration ────────────────────────────────────────
/**
 * Kick off the full intro sequence.
 *
 * Content fades in immediately (no dependency on images).
 * Cloud slide-in waits until images are preloaded.
 */
async function runIntro(themeName) {
    const content   = document.getElementById("content");
    const farLayer  = document.getElementById("far-cloud-layer");
    const nearLayer = document.getElementById("near-cloud-layer");
    // ① Fade content in (doesn't need images)
    setTimeout(() => content.classList.add("visible"), 300);
    // ② Wait for cloud images + a minimum delay so content shows first
    await Promise.all([
        preloadAllClouds(themeName),
        delay(600),
    ]);
    // ③ Slide in far-layer halves
    slideIn(farLayer);
    // ④ Stagger: slide in near-layer halves 300 ms later
    setTimeout(() => slideIn(nearLayer), 300);
    // ⑤ After the longest slide-in finishes, swap to the scroll loop
    //    Far-layer transition: 2 s  → done at 0 + 2000 = 2000 ms
    //    Near-layer transition: 1.6 s → done at 300 + 1600 = 1900 ms
    //    We wait 2200 ms (small buffer) then swap both.
    setTimeout(() => {
        activateLoop(farLayer);
        activateLoop(nearLayer);
    }, 2200);
}
/** Trigger the CSS transition that moves halves to translateX(0). */
function slideIn(layerEl) {
    layerEl.querySelectorAll(".cloud-half").forEach((el) => {
        el.classList.add("slide-in");
    });
}
/**
 * Instant swap from intro halves → scroll loop.
 *
 * Because left.png + right.png == full.png (pixel-perfect),
 * the swap is invisible. We then start the infinite drift.
 */
function activateLoop(layerEl) {
    const intro  = layerEl.querySelector(".cloud-intro");
    const scroll = layerEl.querySelector(".cloud-scroll");
    // single-frame swap: show scroll, hide intro
    scroll.classList.add("active", "scrolling");
    intro.style.display = "none";
}
/** Reset everything so the intro can re-run (e.g. on theme change). */
function resetAnimations() {
    const content = document.getElementById("content");
    content.classList.remove("visible");
    document.querySelectorAll(".cloud-layer").forEach((layer) => {
        // reset intro
        const intro = layer.querySelector(".cloud-intro");
        intro.style.display = "";
        intro.querySelectorAll(".cloud-half").forEach((h) => {
            h.classList.remove("slide-in");
        });
        // reset scroll
        const scroll = layer.querySelector(".cloud-scroll");
        scroll.classList.remove("active", "scrolling");
    });
}
// ─── Element layer placeholder ──────────────────────────────────────
/**
 * Inject theme-specific animated elements (birds, blimp, stars…).
 * Stub — you'll fill this in for each theme later.
 */
function setupElements(themeName) {
    const el = document.getElementById("element-layer");
    el.innerHTML = ""; // clear previous theme's elements
    // TODO: switch (themeName) → create & append animated SVGs / elements
}
// ─── Helpers ────────────────────────────────────────────────────────
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─── Boot ───────────────────────────────────────────────────────────
function init() {
    const time = getTimeOfDay();
    // 1. Apply visual theme (instant — just CSS vars + text)
    applyTheme(time);
    // 2. Wire up cloud image sources
    const assets = cloudAssets(time);
    setCloudSources("far-cloud-layer",  assets.far);
    setCloudSources("near-cloud-layer", assets.near);
    // 3. Prepare element layer
    setupElements(time);
    // 4. Run the animated intro
    runIntro(time);
}
// Handle initial load & back-forward cache
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