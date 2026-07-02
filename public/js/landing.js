/* ============================================
   Watch Together — Landing Page Controller
   ============================================
   Layer stack (back → front):
     sky → far clouds → near clouds → content → element (moon)
   Cloud sizing strategy ("window onto a landscape"):
     - Each cloud tile's pixel size is derived ONLY from the
       layer's HEIGHT and the image's natural aspect ratio —
       never from the viewport's width.
     - The looping layer uses native CSS `background-repeat: repeat-x`,
       which tiles perfectly at ANY container width, even narrower
       than a single tile — eliminating the seam bug entirely.
     - Drift speed is expressed in px/sec and converted to an
       animation-duration based on the actual tile width, so
       clouds appear to move at a constant real-world speed
       regardless of screen size.
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
    farSlideDelay: 700,
    farSlideDuration: 2000,   // must match CSS .cloud-half transition for far
    farToNearGap: 250,
    nearSlideDuration: 1600,  // must match CSS .cloud-half transition for near
    loopActivateGap: 100,
    elementFadeGap: 450,
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
/** Preload an image and resolve with the actual <img> element
 *  (so we can read naturalWidth / naturalHeight). */
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
// ─── Preload everything, capturing cloud dimensions ──────────────────
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
    // Capture natural pixel dimensions (left/right/full share the
    // same canvas size, so "full" is a reliable reference).
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
    // Looping layer now uses a CSS background-image (native repeat-x)
    const scroll = layer.querySelector(".cloud-scroll");
    scroll.style.backgroundImage = `url("${assets.full}")`;
}
function setStaticSources(themeName) {
    const assets = themeAssets(themeName);
    document.getElementById("sky-image").src = assets.sky;
    document.getElementById("element-image").src = assets.element;
}
/**
 * Compute and apply the tile width (px) + animation duration for a
 * looping cloud layer, based ONLY on the layer's current height and
 * the image's natural aspect ratio. Call again on resize.
 */
function updateTileMetrics(layerId, layerKey) {
    const layerEl = document.getElementById(layerId);
    const scroll = layerEl.querySelector(".cloud-scroll");
    const { width: naturalW, height: naturalH } = layerNaturalSize[layerKey];
    if (!naturalW || !naturalH) return;
    const containerHeight = layerEl.clientHeight || window.innerHeight;
    const tileWidth = naturalW * (containerHeight / naturalH);
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
    // Tile metrics depend on natural image size — compute now that
    // preloading has populated layerNaturalSize.
    updateAllTileMetrics();
    setTimeout(() => sky.classList.add("visible"), TIMING.skyFadeDelay);
    setTimeout(() => content.classList.add("visible"), TIMING.contentFadeDelay);
    const farStart = TIMING.farSlideDelay;
    const farEnd = farStart + TIMING.farSlideDuration;
    setTimeout(() => slideIn(farLayer), farStart);
    setTimeout(() => activateLoop(farLayer), farEnd + TIMING.loopActivateGap);
    const nearStart = farEnd + TIMING.farToNearGap;
    const nearEnd = nearStart + TIMING.nearSlideDuration;
    setTimeout(() => slideIn(nearLayer), nearStart);
    setTimeout(() => activateLoop(nearLayer), nearEnd + TIMING.loopActivateGap);
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
// ─── Resize handling ────────────────────────────────────────────────
// Only the layer's HEIGHT affects tile size, so we only need to
// recompute when height changes (e.g. orientation change, dev-tools
// resize). A debounce keeps this cheap.
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