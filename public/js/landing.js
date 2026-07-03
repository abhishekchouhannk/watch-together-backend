/* ============================================
   Watch Together — Landing Page Controller
   ============================================
   Layer stack (back → front):
     sky → element (moon/sun + particles) → far clouds → near clouds → content
   Cloud sizing uses object-fit / background-size: cover for seamless
   full-viewport coverage. The loop is a SINGLE element with native
   background-repeat: repeat-x. JS mirrors the cover formula purely
   to know the tile's pixel width for the drift keyframe.
   Parallax timing: the near cloud layer starts shortly AFTER the far
   layer *starts* (not after it finishes) so both visibly move together.
   Theme elements: each time-of-day has a canvas-drawn pixel-art
   celestial body (moon or sun) with optional particle effects (stars).
   These sit at z-index 1 — behind both cloud layers — for natural
   atmospheric depth.
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
    skyFadeDelay:       150,
    contentFadeDelay:   450,
    farSlideDelay:      400,       // far cloud intro starts
    nearStaggerGap:     500,       // near starts this long AFTER far starts
    farSlideDuration:   2000,      // must match CSS transition for far
    nearSlideDuration:  1600,      // must match CSS transition for near
    loopActivateGap:    100,       // gap after a slide finishes before loop swap
    elementAnimateGap:  0,       // gap after both loops run before element enters
};
// ─── Drift speed (px / s) — constant across all viewport sizes ──────
const DRIFT_SPEED = { far: 18, near: 30 };
// ─── Theme element definitions ──────────────────────────────────────
//
// body.draw(ctx, canvasSize, pixelSize) renders the pixel-art shape.
// body.className maps to CSS that controls position, entrance, & glow.
// body.glowDelay (ms from entrance start) is when the glow kicks in.
// particles (optional) scatters animated dots (stars / sparkles).
const THEME_ELEMENTS = {
    morning: {
        body: {
            draw:       (ctx, s, p) => drawSun(ctx, s, p, "#FFF176", "#FFD93D"),
            canvasSize: 120,
            pixelSize:  4,
            className:  "sun-morning",
            glowDelay:  3200,
        },
        particles: null,
    },
    afternoon: {
        body: {
            draw:       (ctx, s, p) => drawSun(ctx, s, p, "#FFFDE7", "#FFF44F"),
            canvasSize: 140,
            pixelSize:  4,
            className:  "sun-afternoon",
            glowDelay:  2500,
        },
        particles: null,
    },
    evening: {
        body: {
            draw:       (ctx, s, p) => drawSun(ctx, s, p, "#FFB74D", "#FF8C42"),
            canvasSize: 110,
            pixelSize:  4,
            className:  "sun-evening",
            glowDelay:  1500,
        },
        particles: {
            count: 18, className: "star",
            yMax: 50, sizeMin: 1.5, sizeMax: 2.5,
            durationMin: 2.5, durationMax: 4.5,
        },
    },
    night: {
        body: {
            draw:       drawMoon,
            canvasSize: 100,
            pixelSize:  3,
            className:  "moon",
            glowDelay:  3200,
        },
        particles: {
            count: 30, className: "star",
            yMax: 55, sizeMin: 1.5, sizeMax: 3,
            durationMin: 2, durationMax: 4,
        },
    },
};
// ─── Asset path helper ──────────────────────────────────────────────
function themeAssets(themeName) {
    const base = `/assets/${themeName}`;
    return {
        sky: `${base}/sky.png`,
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
function getTimeOfDay() {
    const override = new URLSearchParams(window.location.search).get("theme");
    if (override && THEMES[override]) return override;
    const h = new Date().getHours();
    if (h >= 5  && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 20) return "evening";
    return "night";
}
function preloadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => reject(src);
        img.src = src;
    });
}
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─── Per-layer natural dimensions (filled after preload) ────────────
const layerNaturalSize = {
    far:  { width: 0, height: 0 },
    near: { width: 0, height: 0 },
};
async function preloadAllAssets(themeName) {
    const a = themeAssets(themeName);
    const entries = [
        ["sky",       a.sky],
        ["farLeft",   a.far.left],
        ["farRight",  a.far.right],
        ["farFull",   a.far.full],
        ["nearLeft",  a.near.left],
        ["nearRight", a.near.right],
        ["nearFull",  a.near.full],
    ];
    const results = await Promise.allSettled(
        entries.map(([, src]) => preloadImage(src))
    );
    const loaded = {};
    entries.forEach(([key], i) => {
        if (results[i].status === "fulfilled") loaded[key] = results[i].value;
    });
    if (loaded.farFull) {
        layerNaturalSize.far.width  = loaded.farFull.naturalWidth;
        layerNaturalSize.far.height = loaded.farFull.naturalHeight;
    }
    if (loaded.nearFull) {
        layerNaturalSize.near.width  = loaded.nearFull.naturalWidth;
        layerNaturalSize.near.height = loaded.nearFull.naturalHeight;
    }
    return loaded;
}
// ─── Canvas drawing — pixel-art celestial bodies ────────────────────
/**
 * Draw a pixelated moon with subtle craters.
 * Matches the original React PixelMoon component's rendering.
 */
function drawMoon(ctx, canvasSize, pixelSize) {
    const grid   = Math.floor(canvasSize / pixelSize);
    const center = grid / 2;
    const radius = grid / 2 - 0.5;
    const mainColor   = "#f5f3ce";
    const craterColor = "#e8e5b5";
    const craters = [
        { x: 0.35, y: 0.30, r: 0.08 },
        { x: 0.62, y: 0.45, r: 0.06 },
        { x: 0.42, y: 0.68, r: 0.07 },
        { x: 0.55, y: 0.25, r: 0.04 },
    ];
    for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
            const dist = Math.hypot(x - center, y - center);
            if (dist <= radius) {
                let color = mainColor;
                for (const c of craters) {
                    if (Math.hypot(x - c.x * grid, y - c.y * grid) <= c.r * grid) {
                        color = craterColor;
                        break;
                    }
                }
                ctx.fillStyle = color;
                ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize);
            }
        }
    }
}
/**
 * Draw a pixelated sun with a bright inner zone and warmer outer ring.
 */
function drawSun(ctx, canvasSize, pixelSize, innerColor, outerColor) {
    const grid        = Math.floor(canvasSize / pixelSize);
    const center      = grid / 2;
    const radius      = grid / 2 - 0.5;
    const innerRadius = radius * 0.55;
    for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
            const dist = Math.hypot(x - center, y - center);
            if (dist <= radius) {
                ctx.fillStyle = dist <= innerRadius ? innerColor : outerColor;
                ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize);
            }
        }
    }
}
// ─── Theme element creation & lifecycle ─────────────────────────────
let activeThemeElement = null;
/**
 * Build the celestial-body canvas + optional particle field for the
 * current theme, append them to #element-layer, and store an
 * animate() handle so the intro sequence can trigger the entrance.
 */
function createThemeElements(themeName) {
    const config = THEME_ELEMENTS[themeName];
    if (!config) return;
    const container = document.getElementById("element-layer");
    container.innerHTML = "";
    // ── Celestial body (canvas) ──
    const wrapper  = document.createElement("div");
    wrapper.className = `element-sprite ${config.body.className}`;
    const canvas = document.createElement("canvas");
    canvas.width  = config.body.canvasSize;
    canvas.height = config.body.canvasSize;
    config.body.draw(
        canvas.getContext("2d"),
        config.body.canvasSize,
        config.body.pixelSize,
    );
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    // ── Particles (stars / sparkles) ──
    let particleField = null;
    if (config.particles) {
        particleField = document.createElement("div");
        particleField.className = "particle-field";
        const pc = config.particles;
        for (let i = 0; i < pc.count; i++) {
            const dot = document.createElement("div");
            dot.className = `particle ${pc.className}`;
            dot.style.left = `${2 + Math.random() * 96}%`;
            dot.style.top  = `${2 + Math.random() * Math.max(pc.yMax - 2, 1)}%`;
            const size = pc.sizeMin + Math.random() * (pc.sizeMax - pc.sizeMin);
            dot.style.width  = `${size}px`;
            dot.style.height = `${size}px`;
            const dur = pc.durationMin + Math.random() * (pc.durationMax - pc.durationMin);
            dot.style.animationDuration = `${dur}s`;
            dot.style.animationDelay    = `${Math.random() * dur}s`;
            particleField.appendChild(dot);
        }
        container.appendChild(particleField);
    }
    // ── Public animate() — called by runIntro at the right moment ──
    const glowDelay = config.body.glowDelay;
    activeThemeElement = {
        animate() {
            // rAF ensures initial CSS state has been painted before we
            // add the class that triggers the transition.
            requestAnimationFrame(() => {
                wrapper.classList.add("animate-in");
                if (particleField) particleField.classList.add("visible");
            });
            setTimeout(() => wrapper.classList.add("glowing"), glowDelay);
        },
    };
}
/** Remove all dynamic element children and reset state. */
function clearThemeElements() {
    const container = document.getElementById("element-layer");
    if (container) container.innerHTML = "";
    activeThemeElement = null;
}
// ─── DOM setup ──────────────────────────────────────────────────────
function applyTheme(themeName) {
    const landing = document.getElementById("landing");
    landing.setAttribute("data-theme", themeName);
    document.getElementById("motto").textContent = THEMES[themeName].motto;
}
function setCloudSources(layerId, assets) {
    const layer = document.getElementById(layerId);
    layer.querySelector(".cloud-half.left").src  = assets.left;
    layer.querySelector(".cloud-half.right").src = assets.right;
    layer.querySelector(".cloud-scroll").style.backgroundImage =
        `url("${assets.full}")`;
}
function setSkySource(themeName) {
    document.getElementById("sky-image").src = themeAssets(themeName).sky;
}
/**
 * Compute the rendered "cover" tile width (px) for a cloud layer —
 * the same scale the browser applies via background-size: cover —
 * so the drift keyframe shifts by exactly one tile per cycle.
 */
function updateTileMetrics(layerId, layerKey) {
    const layerEl = document.getElementById(layerId);
    const scroll  = layerEl.querySelector(".cloud-scroll");
    const { width: naturalW, height: naturalH } = layerNaturalSize[layerKey];
    if (!naturalW || !naturalH) return;
    const cW = layerEl.clientWidth  || window.innerWidth;
    const cH = layerEl.clientHeight || window.innerHeight;
    const scale     = Math.max(cW / naturalW, cH / naturalH);
    const tileWidth = naturalW * scale;
    scroll.style.setProperty("--tile-width", `${tileWidth}px`);
    scroll.style.animationDuration = `${tileWidth / DRIFT_SPEED[layerKey]}s`;
}
function updateAllTileMetrics() {
    updateTileMetrics("far-cloud-layer",  "far");
    updateTileMetrics("near-cloud-layer", "near");
}
// ─── Animation orchestration ────────────────────────────────────────
async function runIntro(themeName) {
    const sky     = document.getElementById("sky-image");
    const content = document.getElementById("content");
    const farLyr  = document.getElementById("far-cloud-layer");
    const nearLyr = document.getElementById("near-cloud-layer");
    await Promise.all([preloadAllAssets(themeName), delay(150)]);
    updateAllTileMetrics();
    // Sky + content fade in
    setTimeout(() => sky.classList.add("visible"),     TIMING.skyFadeDelay);
    setTimeout(() => content.classList.add("visible"), TIMING.contentFadeDelay);
    // Parallax cloud intro — near starts shortly after far *starts*
    const farStart  = TIMING.farSlideDelay;
    const nearStart = farStart + TIMING.nearStaggerGap;
    const farEnd    = farStart  + TIMING.farSlideDuration;
    const nearEnd   = nearStart + TIMING.nearSlideDuration;
    setTimeout(() => slideIn(farLyr),       farStart);
    setTimeout(() => slideIn(nearLyr),      nearStart);
    setTimeout(() => activateLoop(farLyr),  farEnd  + TIMING.loopActivateGap);
    setTimeout(() => activateLoop(nearLyr), nearEnd + TIMING.loopActivateGap);
    // Theme element enters once both cloud loops are running
    const bothDone = Math.max(farEnd, nearEnd) + TIMING.loopActivateGap;
    setTimeout(() => {
        if (activeThemeElement) activeThemeElement.animate();
    }, bothDone + TIMING.elementAnimateGap);
}
function slideIn(layerEl) {
    layerEl.querySelectorAll(".cloud-half").forEach((el) =>
        el.classList.add("slide-in"),
    );
}
function activateLoop(layerEl) {
    layerEl.querySelector(".cloud-intro").style.display = "none";
    const scroll = layerEl.querySelector(".cloud-scroll");
    scroll.classList.add("active", "scrolling");
}
function resetAnimations() {
    document.getElementById("sky-image").classList.remove("visible");
    document.getElementById("content").classList.remove("visible");
    clearThemeElements();
    document.querySelectorAll(".cloud-layer").forEach((layer) => {
        const intro = layer.querySelector(".cloud-intro");
        intro.style.display = "";
        intro.querySelectorAll(".cloud-half").forEach((h) =>
            h.classList.remove("slide-in"),
        );
        const scroll = layer.querySelector(".cloud-scroll");
        scroll.classList.remove("active", "scrolling");
    });
}
// ─── Resize handling ────────────────────────────────────────────────
let resizeTimer = null;
function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateAllTileMetrics, 150);
}
// ─── Boot ───────────────────────────────────────────────────────────
function init() {
    const time = getTimeOfDay();
    applyTheme(time);
    setSkySource(time);
    const assets = themeAssets(time);
    setCloudSources("far-cloud-layer",  assets.far);
    setCloudSources("near-cloud-layer", assets.near);
    createThemeElements(time);   // builds canvas + particles (hidden)
    runIntro(time);              // orchestrates the full entrance
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