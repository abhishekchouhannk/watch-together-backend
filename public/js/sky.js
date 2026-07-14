// imports
import { getTimeOfDay } from "./helpers/timeOfDay.js";

/* ============================================
   Watch Together — Shared Sky Background Engine
   ============================================
   Used by: landing, auth, reset-password, verify-email.
   Usage:
     SkyBackground.start({
         onThemeApplied(theme) {},  // theme name resolved & applied
         onReady() {},              // assets preloaded, intro starting
                                    //   → fade YOUR content in here
         onCloudsSettled() {},      // loops running, celestial body animating
         onReset() {},              // bfcache restore — clear page state
                                    //   (callbacks will re-fire after)
     });
   Required DOM (inside <main id="landing" class="landing">):
     <img class="sky-layer" id="sky-image">
     <div class="element-layer" id="element-layer"></div>
     <div class="cloud-layer" id="far-cloud-layer"  data-layer="far"> …intro/scroll… </div>
     <div class="cloud-layer" id="near-cloud-layer" data-layer="near">…intro/scroll… </div>
   ============================================ */
(function () {
    "use strict";
    const VALID_THEMES = ["morning", "afternoon", "evening", "night"];
    const TIMING = {
        skyFadeDelay:       150,
        farSlideDelay:      400,
        nearStaggerGap:     500,
        farSlideDuration:   2000,
        nearSlideDuration:  1600,
        loopActivateGap:    100,
        elementAnimateGap:  450,
    };
    const DRIFT_SPEED = { far: 18, near: 30 };
    const STAR_PROFILES = {
        morning: {
            distribution: { brightThreshold: 0.05, dimThreshold: 0.45 },
            bright: { size: [0.8, 1.8], opacity: [0.45, 0.65], twinkle: [0.004, 0.015] },
            dim:    { size: [0.3, 0.7], opacity: [0.15, 0.35], twinkle: [0.003, 0.012] },
            normal: { size: [0.4, 1.0], opacity: [0.25, 0.5],  twinkle: [0.004, 0.018] },
            colors: { bright: "#ffffff", dim: "#fce4ec", normal: "#fdf2f8" },
            glowRadius: 3.5,
        },
        evening: {
            distribution: { brightThreshold: 0.08, dimThreshold: 0.35 },
            bright: { size: [1.0, 2.2], opacity: [0.55, 0.75], twinkle: [0.005, 0.02] },
            dim:    { size: [0.3, 0.8], opacity: [0.2, 0.4],   twinkle: [0.004, 0.015] },
            normal: { size: [0.5, 1.3], opacity: [0.35, 0.55], twinkle: [0.005, 0.02] },
            colors: { bright: "#ffffff", dim: "#ede9fe", normal: "#f5f3ff" },
            glowRadius: 4,
        },
        night: {
            distribution: { brightThreshold: 0.12, dimThreshold: 0.30 },
            bright: { size: [1.2, 3.0], opacity: [0.6, 0.85], twinkle: [0.005, 0.025] },
            dim:    { size: [0.3, 0.9], opacity: [0.25, 0.5], twinkle: [0.004, 0.018] },
            normal: { size: [0.5, 1.6], opacity: [0.35, 0.65], twinkle: [0.005, 0.022] },
            colors: { bright: "#ffffff", dim: "#e0e7ff", normal: "#f3f4f6" },
            glowRadius: 4,
        },
    };
    const THEME_ELEMENTS = {
        morning: {
            body: {
                draw: (ctx, s, p) => drawSun(ctx, s, p, "#FFF176", "#FFD93D"),
                canvasSize: 120, pixelSize: 4, className: "sun-morning", glowDelay: 3200,
            },
            starrySky: { baseCount: 80, density: "sparse", starProfile: "morning", showShootingStars: false, starRegion: 0.55 },
        },
        afternoon: {
            body: {
                draw: (ctx, s, p) => drawSun(ctx, s, p, "#FFFDE7", "#FFF44F"),
                canvasSize: 140, pixelSize: 4, className: "sun-afternoon", glowDelay: 2500,
            },
            starrySky: null,
        },
        evening: {
            body: {
                draw: (ctx, s, p) => drawSun(ctx, s, p, "#FFB74D", "#FF8C42"),
                canvasSize: 110, pixelSize: 4, className: "sun-evening", glowDelay: 1500,
            },
            starrySky: { baseCount: 80, density: "normal", starProfile: "evening", showShootingStars: false, starRegion: 0.60 },
        },
        night: {
            body: {
                draw: drawMoon,
                canvasSize: 100, pixelSize: 3, className: "moon", glowDelay: 3200,
            },
            starrySky: { baseCount: 80, density: "dense", starProfile: "night", showShootingStars: true, starRegion: 0.65 },
        },
    };
    // ─── Root / scoped DOM lookups ──────────────────────────────────
    // The engine no longer assumes #landing. Any container works as long
    // as it holds .sky-layer, .element-layer and the two .cloud-layer's.
    let rootEl  = null;  // container of the sky layers
    let themeEl = null;  // element that receives data-theme
    function resolveEl(target) {
        if (!target) return null;
        return typeof target === "string" ? document.querySelector(target) : target;
    }
    function skyImage()      { return rootEl && rootEl.querySelector(".sky-layer"); }
    function elementLayer()  { return rootEl && rootEl.querySelector(".element-layer"); }
    function cloudLayer(key) {
        return rootEl && rootEl.querySelector(`.cloud-layer[data-layer="${key}"]`);
    }
    // ─── Asset helpers ──────────────────────────────────────────────
    function themeAssets(themeName) {
        const base = `/assets/${themeName}`;
        return {
            sky: `${base}/sky.png`,
            far:  { left: `${base}/farLayer/left.png`,  right: `${base}/farLayer/right.png`,  full: `${base}/farLayer/full.png`  },
            near: { left: `${base}/nearLayer/left.png`, right: `${base}/nearLayer/right.png`, full: `${base}/nearLayer/full.png` },
        };
    }
    function preloadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload  = () => resolve(img);
            img.onerror = () => reject(src);
            img.src = src;
        });
    }
    function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
    function rand(min, max) { return min + Math.random() * (max - min); }
    const layerNaturalSize = {
        far:  { width: 0, height: 0 },
        near: { width: 0, height: 0 },
    };
    async function preloadAllAssets(themeName) {
        const a = themeAssets(themeName);
        const entries = [
            ["sky", a.sky],
            ["farLeft", a.far.left], ["farRight", a.far.right], ["farFull", a.far.full],
            ["nearLeft", a.near.left], ["nearRight", a.near.right], ["nearFull", a.near.full],
        ];
        const results = await Promise.allSettled(entries.map(([, src]) => preloadImage(src)));
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
    // ─── Pixel-art celestial bodies ─────────────────────────────────
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
    // ─── Starry sky system ──────────────────────────────────────────
    let starrySkyState = null;
    function createStar(x, y, profile) {
        const r    = Math.random();
        const dist = profile.distribution;
        const type =
            r < dist.brightThreshold ? "bright"
          : r < dist.dimThreshold    ? "dim"
          :                            "normal";
        const spec = profile[type];
        const baseSize    = rand(spec.size[0],    spec.size[1]);
        const baseOpacity = rand(spec.opacity[0], spec.opacity[1]);
        return {
            x, y, type, baseSize, baseOpacity,
            currentSize:    baseSize,
            currentOpacity: baseOpacity,
            twinkleSpeed:   rand(spec.twinkle[0], spec.twinkle[1]),
            twinklePhase:   Math.random() * Math.PI * 2,
        };
    }
    function sizeStarCanvas(canvas) {
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth;
        const h = window.innerHeight;
        canvas.width  = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width  = w + "px";
        canvas.style.height = h + "px";
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        return { ctx, w, h };
    }
    function initStarrySky(container, config) {
        const canvas = document.createElement("canvas");
        canvas.className = "starry-sky-canvas";
        container.appendChild(canvas);
        const { ctx, w, h } = sizeStarCanvas(canvas);
        const profile = STAR_PROFILES[config.starProfile];
        const densityMult =
            config.density === "sparse" ? 0.6
          : config.density === "dense"  ? 1.5
          : 1;
        const count       = Math.floor(config.baseCount * densityMult);
        const region      = config.starRegion || 0.65;
        const starRegionH = h * region;
        const stars = [];
        for (let i = 0; i < count; i++) {
            stars.push(createStar(Math.random() * w, Math.random() * starRegionH, profile));
        }
        starrySkyState = {
            canvas, ctx, cssW: w, cssH: h, stars,
            shootingStars: [], config, profile,
            animId: null, shootingTimerId: null,
            coveredW: w, coveredSH: starRegionH,
            density: count / (w * starRegionH || 1),
            region,
        };
    }
    function expandStarField() {
        const st = starrySkyState;
        if (!st) return;
        const newW  = st.cssW;
        const newSH = st.cssH * st.region;
        if (newW <= st.coveredW && newSH <= st.coveredSH) return;
        const rightW     = Math.max(0, newW - st.coveredW);
        const bottomH    = Math.max(0, newSH - st.coveredSH);
        const rightArea  = rightW * newSH;
        const bottomArea = st.coveredW * bottomH;
        const totalArea  = rightArea + bottomArea;
        if (totalArea <= 0) return;
        const newCount = Math.max(1, Math.round(st.density * totalArea));
        for (let i = 0; i < newCount; i++) {
            let x, y;
            if (rightArea > 0 && bottomArea > 0) {
                if (Math.random() < rightArea / totalArea) {
                    x = st.coveredW + Math.random() * rightW;
                    y = Math.random() * newSH;
                } else {
                    x = Math.random() * st.coveredW;
                    y = st.coveredSH + Math.random() * bottomH;
                }
            } else if (rightArea > 0) {
                x = st.coveredW + Math.random() * rightW;
                y = Math.random() * newSH;
            } else {
                x = Math.random() * newW;
                y = st.coveredSH + Math.random() * bottomH;
            }
            st.stars.push(createStar(x, y, st.profile));
        }
        st.coveredW  = Math.max(st.coveredW, newW);
        st.coveredSH = Math.max(st.coveredSH, newSH);
    }
    function resizeStarrySky() {
        if (!starrySkyState) return;
        const { ctx, w, h } = sizeStarCanvas(starrySkyState.canvas);
        starrySkyState.ctx  = ctx;
        starrySkyState.cssW = w;
        starrySkyState.cssH = h;
        expandStarField();
    }
    function drawStarrySkyFrame(isStatic) {
        const st = starrySkyState;
        if (!st) return;
        const { ctx, cssW, cssH, profile } = st;
        const glowR  = profile.glowRadius;
        const colors = profile.colors;
        ctx.clearRect(0, 0, cssW, cssH);
        for (const s of st.stars) {
            if (s.x < -4 || s.x > cssW + 4 || s.y < -4 || s.y > cssH + 4) continue;
            if (!isStatic) {
                s.twinklePhase += s.twinkleSpeed;
                const tf = (Math.sin(s.twinklePhase) + 1) / 2;
                s.currentOpacity = s.baseOpacity * (0.3 + tf * 0.7);
                s.currentSize    = s.baseSize    * (0.8 + tf * 0.2);
            }
            ctx.save();
            if (s.type === "bright") {
                const r = s.currentSize * glowR;
                const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
                g.addColorStop(0,   `rgba(255,255,255,${s.currentOpacity * 0.8})`);
                g.addColorStop(0.5, `rgba(200,220,255,${s.currentOpacity * 0.3})`);
                g.addColorStop(1,   "rgba(200,220,255,0)");
                ctx.fillStyle = g;
                ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
            }
            ctx.globalAlpha = s.currentOpacity;
            ctx.fillStyle   = colors[s.type];
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.currentSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        if (!isStatic) {
            for (let i = st.shootingStars.length - 1; i >= 0; i--) {
                const ss = st.shootingStars[i];
                ss.progress += ss.speed;
                if (ss.progress >= 1) { st.shootingStars.splice(i, 1); continue; }
                drawShootingStar(ctx, ss);
            }
        }
    }
    function drawShootingStar(ctx, ss) {
        const easedDist = (1 - Math.pow(1 - ss.progress, 3)) * 280;
        const hx = ss.startX + Math.cos(ss.angle) * easedDist;
        const hy = ss.startY + Math.sin(ss.angle) * easedDist;
        const trail = Math.min(easedDist, ss.trailLen);
        const tx = hx - Math.cos(ss.angle) * trail;
        const ty = hy - Math.sin(ss.angle) * trail;
        const fade = ss.progress < 0.7 ? 1 : 1 - (ss.progress - 0.7) / 0.3;
        if (fade <= 0) return;
        ctx.save();
        ctx.lineCap = "round";
        const g1 = ctx.createLinearGradient(tx, ty, hx, hy);
        g1.addColorStop(0, "rgba(255,255,255,0)");
        g1.addColorStop(1, `rgba(255,255,255,${0.4 * fade})`);
        ctx.strokeStyle = g1;
        ctx.lineWidth   = 3;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        const g2 = ctx.createLinearGradient(tx, ty, hx, hy);
        g2.addColorStop(0, "rgba(255,255,255,0)");
        g2.addColorStop(1, `rgba(255,255,255,${0.8 * fade})`);
        ctx.strokeStyle = g2;
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        const hr = 4;
        const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr * 3);
        glow.addColorStop(0,   `rgba(255,255,255,${0.9 * fade})`);
        glow.addColorStop(0.4, `rgba(200,220,255,${0.4 * fade})`);
        glow.addColorStop(1,   "rgba(200,220,255,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(hx, hy, hr * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function startStarrySkyAnimation() {
        if (!starrySkyState) return;
        starrySkyState.canvas.classList.add("visible");
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            drawStarrySkyFrame(true);
            return;
        }
        function loop() {
            if (!starrySkyState) return;
            drawStarrySkyFrame(false);
            starrySkyState.animId = requestAnimationFrame(loop);
        }
        starrySkyState.animId = requestAnimationFrame(loop);
        if (starrySkyState.config.showShootingStars) {
            scheduleShootingStar();
        }
    }
    function scheduleShootingStar() {
        if (!starrySkyState) return;
        function attempt() {
            const st = starrySkyState;
            if (!st) return;
            if (Math.random() > 0.5) {
                st.shootingStars.push({
                    startX:   st.cssW * 0.2 + Math.random() * st.cssW * 0.6,
                    startY:   Math.random() * st.cssH * 0.3,
                    angle:    Math.PI / 4 + (Math.random() - 0.5) * 0.5,
                    speed:    1 / 90,
                    trailLen: 80 + Math.random() * 40,
                    progress: 0,
                });
            }
            st.shootingTimerId = setTimeout(attempt, 2000 + Math.random() * 1000);
        }
        starrySkyState.shootingTimerId = setTimeout(attempt, 3000 + Math.random() * 5000);
    }
    function destroyStarrySky() {
        if (!starrySkyState) return;
        if (starrySkyState.animId != null)          cancelAnimationFrame(starrySkyState.animId);
        if (starrySkyState.shootingTimerId != null) clearTimeout(starrySkyState.shootingTimerId);
        starrySkyState = null;
    }
    // ─── Theme elements ─────────────────────────────────────────────
    let activeThemeElement = null;
    function createThemeElements(themeName) {
        const config = THEME_ELEMENTS[themeName];
        if (!config) return;
        destroyStarrySky();
        const container = elementLayer();
        if (!container) return;
        container.innerHTML = "";
        if (config.starrySky) initStarrySky(container, config.starrySky);
        const wrapper = document.createElement("div");
        wrapper.className = `element-sprite ${config.body.className}`;
        const bodyCanvas = document.createElement("canvas");
        bodyCanvas.width  = config.body.canvasSize;
        bodyCanvas.height = config.body.canvasSize;
        config.body.draw(bodyCanvas.getContext("2d"), config.body.canvasSize, config.body.pixelSize);
        wrapper.appendChild(bodyCanvas);
        container.appendChild(wrapper);
        const glowDelay = config.body.glowDelay;
        activeThemeElement = {
            animate() {
                if (starrySkyState) startStarrySkyAnimation();
                requestAnimationFrame(() => wrapper.classList.add("animate-in"));
                setTimeout(() => wrapper.classList.add("glowing"), glowDelay);
            },
        };
    }
    function clearThemeElements() {
        destroyStarrySky();
        const container = elementLayer();
        if (container) container.innerHTML = "";
        activeThemeElement = null;
    }
    // ─── DOM setup ──────────────────────────────────────────────────
    function applyTheme(themeName) {
        (themeEl || rootEl).setAttribute("data-theme", themeName);
    }
    function setCloudSources(layerKey, assets) {
        const layer = cloudLayer(layerKey);
        if (!layer) return;
        layer.querySelector(".cloud-half.left").src  = assets.left;
        layer.querySelector(".cloud-half.right").src = assets.right;
        layer.querySelector(".cloud-scroll").style.backgroundImage = `url("${assets.full}")`;
    }
    function setSkySource(themeName) {
        const img = skyImage();
        if (img) img.src = themeAssets(themeName).sky;
    }
    function updateTileMetrics(layerKey) {
        const layerEl = cloudLayer(layerKey);
        if (!layerEl) return;
        const scroll = layerEl.querySelector(".cloud-scroll");
        const { width: naturalW, height: naturalH } = layerNaturalSize[layerKey];
        if (!naturalW || !naturalH) return;
        const cW = layerEl.clientWidth  || window.innerWidth;
        const cH = layerEl.clientHeight || window.innerHeight;
        const scale      = Math.max(cW / naturalW, cH / naturalH);
        const tileWidth  = naturalW * scale;
        const tileHeight = naturalH * scale;
        const initialX   = (cW - tileWidth) / 2;
        scroll.style.setProperty("--tile-width", `${tileWidth}px`);
        scroll.style.setProperty("--initial-x",  `${initialX}px`);
        scroll.style.animationDuration = `${tileWidth / DRIFT_SPEED[layerKey]}s`;
        layerEl.querySelectorAll(".cloud-half").forEach((el) => {
            el.style.width  = `${tileWidth}px`;
            el.style.height = `${tileHeight}px`;
            el.style.left   = `${initialX}px`;
            el.style.top    = "auto";
            el.style.right  = "auto";
            el.style.bottom = "0";
            el.style.setProperty("--off-x", el.classList.contains("left") ? `${-cW}px` : `${cW}px`);
        });
    }
    function updateAllTileMetrics() {
        if (!rootEl) return;
        updateTileMetrics("far");
        updateTileMetrics("near");
    }
    // ─── Intro orchestration ────────────────────────────────────────
    let activeOptions = {};
    async function runIntro(themeName) {
        const sky     = skyImage();
        const farLyr  = cloudLayer("far");
        const nearLyr = cloudLayer("near");
        if (!sky || !farLyr || !nearLyr) return;
        await Promise.all([preloadAllAssets(themeName), delay(150)]);
        updateAllTileMetrics();
        if (typeof activeOptions.onReady === "function") activeOptions.onReady();
        /* Fast path for app pages (dashboard / room): skip the cinematic
           cloud reveal, go straight to the drifting loops. */
        if (activeOptions.intro === false) {
            sky.classList.add("visible");
            activateLoop(farLyr);
            activateLoop(nearLyr);
            if (activeThemeElement) activeThemeElement.animate();
            if (typeof activeOptions.onCloudsSettled === "function") {
                activeOptions.onCloudsSettled();
            }
            return;
        }
        setTimeout(() => sky.classList.add("visible"), TIMING.skyFadeDelay);
        const farStart  = TIMING.farSlideDelay;
        const nearStart = farStart + TIMING.nearStaggerGap;
        const farEnd    = farStart  + TIMING.farSlideDuration;
        const nearEnd   = nearStart + TIMING.nearSlideDuration;
        setTimeout(() => slideIn(farLyr),       farStart);
        setTimeout(() => slideIn(nearLyr),      nearStart);
        setTimeout(() => activateLoop(farLyr),  farEnd  + TIMING.loopActivateGap);
        setTimeout(() => activateLoop(nearLyr), nearEnd + TIMING.loopActivateGap);
        const bothDone = Math.max(farEnd, nearEnd) + TIMING.loopActivateGap;
        setTimeout(() => {
            if (activeThemeElement) activeThemeElement.animate();
            if (typeof activeOptions.onCloudsSettled === "function") {
                activeOptions.onCloudsSettled();
            }
        }, bothDone + TIMING.elementAnimateGap);
    }
    function slideIn(layerEl) {
        if (!layerEl) return;
        layerEl.querySelectorAll(".cloud-half").forEach((el) =>
            el.classList.add("slide-in"),
        );
    }
    function activateLoop(layerEl) {
        if (!layerEl) return;
        const intro  = layerEl.querySelector(".cloud-intro");
        const scroll = layerEl.querySelector(".cloud-scroll");
        if (intro)  intro.style.display = "none";
        if (scroll) scroll.classList.add("active", "scrolling");
    }
    function resetAnimations() {
        if (!rootEl) return;
        const sky = skyImage();
        if (sky) sky.classList.remove("visible");
        clearThemeElements();
        rootEl.querySelectorAll(".cloud-layer").forEach((layer) => {
            const intro = layer.querySelector(".cloud-intro");
            if (intro) {
                intro.style.display = "";
                intro.querySelectorAll(".cloud-half").forEach((h) => {
                    h.classList.remove("slide-in");
                    h.removeAttribute("style");
                });
            }
            const scroll = layer.querySelector(".cloud-scroll");
            scroll.classList.remove("active", "scrolling");
            scroll.style.removeProperty("--initial-x");
            scroll.style.removeProperty("--tile-width");
        });
    }
    // ─── Resize handling ────────────────────────────────────────────
    let resizeTimer = null;
    function onWindowResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            updateAllTileMetrics();
            resizeStarrySky();
        }, 150);
    }
    // ─── Public API ─────────────────────────────────────────────────
    /**
     * start({
     *   root:        "#landing" | "#sky-root" | HTMLElement,  // default "#landing"
     *   themeTarget: document.documentElement | selector,     // default = root
     *   theme:       "night",        // optional override, else time-of-day
     *   intro:       true | false,   // false = skip reveal, straight to loops
     *   onThemeApplied(theme) {},
     *   onReady() {},
     *   onCloudsSettled() {},
     *   onReset() {},
     * })
     */
    function start(options = {}) {
        activeOptions = options || {};
        rootEl = resolveEl(activeOptions.root) || document.getElementById("landing");
        if (!rootEl) {
            console.warn("[SkyBackground] root element not found — sky disabled.");
            return null;
        }
        themeEl = resolveEl(activeOptions.themeTarget) || rootEl;
        const theme = VALID_THEMES.indexOf(activeOptions.theme) !== -1
            ? activeOptions.theme
            : getTimeOfDay();
        applyTheme(theme);
        if (typeof activeOptions.onThemeApplied === "function") {
            activeOptions.onThemeApplied(theme);
        }
        setSkySource(theme);
        const assets = themeAssets(theme);
        setCloudSources("far",  assets.far);
        setCloudSources("near", assets.near);
        createThemeElements(theme);
        runIntro(theme);
        return theme;
    }
    window.SkyBackground = { start, getTimeOfDay, TIMING };
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("pageshow", (e) => {
        if (e.persisted && rootEl) {
            resetAnimations();
            if (typeof activeOptions.onReset === "function") activeOptions.onReset();
            start(activeOptions);
        }
    });
})();