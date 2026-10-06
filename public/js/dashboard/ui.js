/* public/js/dashboard/ui.js — small helpers shared by the dashboard modules */
"use strict";

export const $ = (id) => document.getElementById(id);

/* escapes quotes too — safe inside attributes (the old div.textContent trick wasn't) */
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const fmtNum = (n) => new Intl.NumberFormat().format(Number(n) || 0);

export function toast(msg, type = "success") {
  const wrap = $("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add("hiding");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export function timeAgo(ds) {
  if (!ds) return "";
  const diff = Math.floor((Date.now() - new Date(ds).getTime()) / 1000);
  if (Number.isNaN(diff) || diff < 0) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
  return new Date(ds).toLocaleDateString();
}

/** JSON fetch: 401 → login; non-2xx → Error{status,data} with the server's message. */
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/";
    throw Object.assign(new Error("auth"), { auth: true, status: 401 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || data.message || "Request failed (" + res.status + ")"),
      { status: res.status, data });
  }
  return data;
}

let locks = 0;
export function lockScroll(on) {
  locks = Math.max(0, locks + (on ? 1 : -1));
  document.body.style.overflow = locks ? "hidden" : "";
}

export function trapTab(e, root) {
  const els = [...root.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !root.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}