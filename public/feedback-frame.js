/*
 * Mayfly feedback helper. Mayfly adds this to a preview page only when the page is shown inside Mayfly's review
 * page (/review/...). It draws the numbered comment pins and lets a reviewer drag a box over a spot. It never sees
 * comment text, names or links: the review page keeps those and only sends pin positions here.
 * Opened on its own (not in a frame), it does nothing.
 */
(function () {
  "use strict";
  if (window.parent === window || window.__mayflyFeedback) return;
  window.__mayflyFeedback = true;

  // The review page is Mayfly itself, the same address this page was served from.
  var MAYFLY = location.origin;
  var parts = location.pathname.split("/"); // ["", "p", owner, name, pr, ...rest]
  if (parts[1] !== "p" || parts.length < 5) return;

  function pagePath() {
    var rest = "/" + location.pathname.split("/").slice(5).join("/");
    return rest + location.search;
  }

  function send(message) {
    message.mayfly = "feedback";
    try {
      window.parent.postMessage(message, MAYFLY);
    } catch (e) {}
  }

  var host = document.createElement("mayfly-feedback");
  host.setAttribute("style", "all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;");
  var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box}" +
    ".layer{position:absolute;left:0;top:0;width:0;height:0;font:600 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif}" +
    ".pin{position:absolute;display:grid;place-items:center;width:28px;height:28px;margin:-14px 0 0 -14px;padding:0;border:2px solid #fff;border-radius:999px 999px 999px 4px;background:#4f46e5;color:#fff;font:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(15,23,42,.35);transition:transform .12s}" +
    ".pin:hover,.pin[data-on]{transform:scale(1.15)}" +
    ".pin[data-old]{background:#64748b}" +
    ".pin:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}" +
    ".box{position:absolute;border:2px solid #4f46e5;border-radius:6px;background:rgba(79,70,229,.10);pointer-events:none;opacity:0;transition:opacity .15s}" +
    ".box[data-on]{opacity:1}" +
    ".box[data-draft]{opacity:1;border-style:dashed;background:rgba(79,70,229,.14)}" +
    "@keyframes flash{0%,100%{box-shadow:0 0 0 0 rgba(79,70,229,.0)}50%{box-shadow:0 0 0 10px rgba(79,70,229,.25)}}" +
    ".box[data-flash]{animation:flash .6s ease-in-out 2}" +
    ".cover{position:fixed;inset:0;display:none;cursor:crosshair;touch-action:none;background:rgba(15,23,42,.06)}" +
    ".cover[data-on]{display:block}" +
    ".drag{position:fixed;border:2px dashed #4f46e5;border-radius:6px;background:rgba(79,70,229,.14);pointer-events:none;display:none}" +
    ".hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);max-width:calc(100vw - 24px);padding:10px 14px;border-radius:999px;background:#0f172a;color:#fff;font:500 13px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 6px 20px rgba(15,23,42,.3);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    "@media (prefers-reduced-motion:reduce){.pin,.box{transition:none}.box[data-flash]{animation:none}}" +
    "</style>" +
    '<div class="layer"></div>' +
    '<div class="cover"><div class="drag"></div><div class="hint">Drag over the part that needs changing, or tap a spot. Esc cancels.</div></div>';

  var layer = root.querySelector(".layer");
  var cover = root.querySelector(".cover");
  var drag = root.querySelector(".drag");
  var pins = [];
  var draft = null;

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function el(tag, cls) {
    var node = document.createElement(tag);
    node.className = cls;
    return node;
  }

  function place(node, x, y, w, h) {
    node.style.left = x + "px";
    node.style.top = y + "px";
    if (w !== undefined) {
      node.style.width = Math.max(w, 0) + "px";
      node.style.height = Math.max(h, 0) + "px";
    }
  }

  function draw(active) {
    layer.textContent = "";
    pins.forEach(function (pin) {
      var point = pin.w < 4 && pin.h < 4;
      var box = el("div", "box");
      place(box, point ? pin.x - 18 : pin.x, point ? pin.y - 18 : pin.y, point ? 36 : pin.w, point ? 36 : pin.h);
      box.setAttribute("data-box", pin.id);
      var button = el("button", "pin");
      button.type = "button";
      button.textContent = String(pin.n);
      button.setAttribute("aria-label", "Comment " + pin.n);
      if (pin.old) button.setAttribute("data-old", "");
      place(button, Math.max(14, pin.x), Math.max(14, pin.y));
      if (pin.id === active) {
        button.setAttribute("data-on", "");
        box.setAttribute("data-on", "");
      }
      button.addEventListener("mouseenter", function () { box.setAttribute("data-on", ""); });
      button.addEventListener("mouseleave", function () { if (pin.id !== active) box.removeAttribute("data-on"); });
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        send({ type: "pick", id: pin.id });
      });
      layer.appendChild(box);
      layer.appendChild(button);
    });
    if (draft) {
      var d = el("div", "box");
      var tiny = draft.w < 4 && draft.h < 4;
      place(d, tiny ? draft.x - 18 : draft.x, tiny ? draft.y - 18 : draft.y, tiny ? 36 : draft.w, tiny ? 36 : draft.h);
      d.setAttribute("data-draft", "");
      layer.appendChild(d);
    }
  }

  function focusPin(id) {
    var pin = null;
    pins.forEach(function (item) { if (item.id === id) pin = item; });
    if (!pin) return;
    draw(id);
    var top = Math.max(0, pin.y - window.innerHeight / 3);
    var left = Math.max(0, pin.x - window.innerWidth / 3);
    try {
      window.scrollTo({ top: top, left: left, behavior: "smooth" });
    } catch (e) {
      window.scrollTo(left, top);
    }
    var box = layer.querySelector('[data-box="' + id + '"]');
    if (box) {
      box.removeAttribute("data-flash");
      void box.offsetWidth;
      box.setAttribute("data-flash", "");
    }
  }

  // ---- marking a spot ----
  var start = null;
  function setMode(on) {
    mount();
    if (on) cover.setAttribute("data-on", "");
    else cover.removeAttribute("data-on");
    drag.style.display = "none";
    start = null;
  }

  cover.addEventListener("pointerdown", function (event) {
    if (event.button !== undefined && event.button > 0) return;
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    try { cover.setPointerCapture(event.pointerId); } catch (e) {}
    place(drag, start.x, start.y, 0, 0);
    drag.style.display = "block";
  });
  cover.addEventListener("pointermove", function (event) {
    if (!start) return;
    var x = Math.min(start.x, event.clientX);
    var y = Math.min(start.y, event.clientY);
    place(drag, x, y, Math.abs(event.clientX - start.x), Math.abs(event.clientY - start.y));
  });
  cover.addEventListener("pointerup", function (event) {
    if (!start) return;
    var x = Math.min(start.x, event.clientX);
    var y = Math.min(start.y, event.clientY);
    var w = Math.abs(event.clientX - start.x);
    var h = Math.abs(event.clientY - start.y);
    if (w < 8 && h < 8) {
      // A tap marks a point.
      x = start.x;
      y = start.y;
      w = 0;
      h = 0;
    }
    var area = {
      x: Math.round(x + window.scrollX),
      y: Math.round(y + window.scrollY),
      w: Math.round(w),
      h: Math.round(h),
    };
    setMode(false);
    draft = area;
    draw(null);
    send({ type: "area", x: area.x, y: area.y, w: area.w, h: area.h, viewportWidth: window.innerWidth, path: pagePath() });
  });
  document.addEventListener(
    "keydown",
    function (event) {
      if (event.key === "Escape" && cover.hasAttribute("data-on")) {
        setMode(false);
        send({ type: "cancel" });
      }
    },
    true,
  );

  // ---- messages from the review page ----
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== MAYFLY) return;
    var data = event.data;
    if (!data || data.mayfly !== "feedback") return;
    mount();
    if (data.type === "pins" && Array.isArray(data.pins)) {
      pins = data.pins
        .filter(function (pin) { return pin && typeof pin.id === "string"; })
        .map(function (pin) {
          return { id: pin.id, n: Number(pin.n) || 0, x: Number(pin.x) || 0, y: Number(pin.y) || 0, w: Number(pin.w) || 0, h: Number(pin.h) || 0, old: Boolean(pin.old) };
        });
      if (!data.keepDraft) draft = null;
      draw(typeof data.active === "string" ? data.active : null);
    } else if (data.type === "mode") {
      setMode(Boolean(data.on));
    } else if (data.type === "focus" && typeof data.id === "string") {
      focusPin(data.id);
    } else if (data.type === "clear-draft") {
      draft = null;
      draw(null);
    }
  });

  // ---- tell the review page which page this is, now and after in-page navigation ----
  var lastPath = null;
  function announce() {
    var path = pagePath();
    if (path === lastPath) return;
    lastPath = path;
    send({ type: "ready", path: path, title: String(document.title || "").slice(0, 200) });
  }
  function boot() {
    mount();
    lastPath = null;
    announce();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  setInterval(announce, 500);
})();
