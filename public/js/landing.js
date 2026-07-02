/* ============================================
   Watch Together — Landing Page Controller
   ============================================
   Layer stack (back → front):
     sky → far clouds → near clouds → content → element (moon)
   Cloud sizing: object-fit/background-size: cover — guarantees full
   viewport coverage (no edge gaps) with zero distortion. The loop
   uses a SINGLE element with native background-repeat: repeat-x,
   so there's no flex-child rounding seam. JS mirrors the exact same
   "cover" scale formula purely to know the tile's pixel width, so
   the drift animation resets after precisely one tile.
   Parallax timing: near layer starts shortly AFTER the far layer
   *starts* (not after it finishes) so both visibly move together.
   ============================================ */
// ─── Theme configuration ────────────────────────────────────────────
const THEMES = {
    morning:   { motto: "Start your day watching together, anywhere." },
    afternoon: { motto: "Take a break and watch together, anywhere." },
    evening:   { motto: "Unwind and watch together, anywhere." },
    night:     { motto: "Movie nights made simple — together, anywhere." },
};
// ─── Timing constants (ms) ──────────────────────────────────────────
const TIMING = {
    skyFadeDelay: 150,
    contentFadeDelay: 450,
    farSlideDelay: 700,        // far layer starts sliding at this point
    nearStaggerGap: 120,       // near starts this long AFTER far starts (parallax feel)
    farSlideDuration: 2000,    // must match CSS .cloud-half transition for far
    nearSlideDuration: 1600,   // must match CSS .cloud-half transition for near
    loopActivateGap: 100,      // gap after a slide finishes before swapping to loop
    elementFadeGap: 450,       // gap after both loops are active before moon appears
};
// ─── Drift speed (pixels per second) — constant across all screens ──
const DRIFT_SPEED = {
    far: 18,
    near: 30,
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
        img.onload = () => resolve(img);
        img.onerror = () => reject(src);
        img.src = src;
    });
}
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─── Per-layer natural dimensions (filled in after preload) ─────────
const layerNaturalSize = {
    far: { width: 0, height: 0 },
    near: { width: 0, height: 0 },
};
async function preloadAllAssets(themeName) {
    const a = themeAssets(themeName);
    const entries = [
        ["sky", a.sky],
        ["element", a.element],
        ["farLeft", a.far.left],
        ["farRight", a.far.right],
        ["farFull", a.far.full],
        ["nearLeft", a.near.left],
        ["nearRight", a.near.right],
        ["nearFull", a.near.full],
    ];
    const results = await Promise.allSettled(
        entries.map(([, src]) => preloadImage(src))
    );
    const loaded = {};
    entries.forEach(([key], i) => {
        if (results[i].status === "fulfilled") {
            loaded[key] = results[i].value;
        }
    });
    if (loaded.farFull) {
        layerNaturalSize.far.width = loaded.farFull.naturalWidth;
        layerNaturalSize.far.height = loaded.farFull.naturalHeight;
    }
    if (loaded.nearFull) {
        layerNaturalSize.near.width = loaded.nearFull.naturalWidth;
        layerNaturalSize.near.height = loaded.nearFull.naturalHeight;
    }
    return loaded;
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
    const scroll = layer.querySelector(".cloud-scroll");
    scroll.style.backgroundImage = `url("${assets.full}")`;
}
function setStaticSources(themeName) {
    const assets = themeAssets(themeName);
    document.getElementById("sky-image").src = assets.sky;
    document.getElementById("element-image").src = assets.element;
}
/**
 * Compute the rendered "cover" tile width (px) for a layer — i.e.
 * the exact same scale the browser applies via object-fit/background-
 * size: cover — then use it to drive the drift animation's distance
 * and duration (so speed stays constant across screen sizes).
 */
function updateTileMetrics(layerId, layerKey) {
    const layerEl = document.getElementById(layerId);
    const scroll = layerEl.querySelector(".cloud-scroll");
    const { width: naturalW, height: naturalH } = layerNaturalSize[layerKey];
    if (!naturalW || !naturalH) return;
    const containerWidth = layerEl.clientWidth || window.innerWidth;
    const containerHeight = layerEl.clientHeight || window.innerHeight;
    // Same formula as CSS "cover": scale by whichever axis needs more
    const scale = Math.max(
        containerWidth / naturalW,
        containerHeight / naturalH
    );
    const tileWidth = naturalW * scale;
    scroll.style.setProperty("--tile-width", `${tileWidth}px`);
    const speed = DRIFT_SPEED[layerKey];
    const duration = tileWidth / speed;
    scroll.style.animationDuration = `${duration}s`;
}
function updateAllTileMetrics() {
    updateTileMetrics("far-cloud-layer", "far");
    updateTileMetrics("near-cloud-layer", "near");
}
// ─── Animation orchestration ────────────────────────────────────────
async function runIntro(themeName) {
    const sky = document.getElementById("sky-image");
    const element = document.getElementById("element-image");
    const content = document.getElementById("content");
    const farLayer = document.getElementById("far-cloud-layer");
    const nearLayer = document.getElementById("near-cloud-layer");
    await Promise.all([preloadAllAssets(themeName), delay(150)]);
    updateAllTileMetrics();
    setTimeout(() => sky.classList.add("visible"), TIMING.skyFadeDelay);
    setTimeout(() => content.classList.add("visible"), TIMING.contentFadeDelay);
    // Parallax: near starts shortly AFTER far starts — not after far ends.
    const farStart = TIMING.farSlideDelay;
    const nearStart = farStart + TIMING.nearStaggerGap;
    const farEnd = farStart + TIMING.farSlideDuration;
    const nearEnd = nearStart + TIMING.nearSlideDuration;
    setTimeout(() => slideIn(farLayer), farStart);
    setTimeout(() => slideIn(nearLayer), nearStart);
    setTimeout(() => activateLoop(farLayer), farEnd + TIMING.loopActivateGap);
    setTimeout(() => activateLoop(nearLayer), nearEnd + TIMING.loopActivateGap);
    const bothDone = Math.max(farEnd, nearEnd) + TIMING.loopActivateGap;
    setTimeout(() => element.classList.add("visible"), bothDone + TIMING.elementFadeGap);
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
// ─── Resize handling ────────────────────────────────────────────────
// "cover" scaling depends on BOTH width and height, so recompute on
// any resize (debounced).
let resizeTimer = null;
function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateAllTileMetrics, 150);
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
window.addEventListener("resize", onWindowResize);
window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
        resetAnimations();
        init();
    }
});