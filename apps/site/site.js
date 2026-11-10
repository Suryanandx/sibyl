// Sibyl landing page: theme toggle, install tabs, copy buttons, lazy looping clips.
(function () {
  "use strict";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Theme: follows the system until the visitor picks one. */
  function isDark() {
    var t = root.dataset.theme;
    return t ? t === "dark" : media.matches;
  }
  var toggle = document.querySelector(".themeToggle");
  function syncToggle() {
    if (toggle) toggle.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("sibyl-site-theme", next); } catch (e) { /* storage may be blocked */ }
      syncToggle();
    });
  }
  if (media.addEventListener) media.addEventListener("change", syncToggle);
  syncToggle();

  /* Products menu (disclosure pattern) and the phone menu. */
  var menuBtn = document.querySelector(".menuBtn");
  var menuPanel = menuBtn ? document.getElementById(menuBtn.getAttribute("aria-controls")) : null;
  var navEl = document.querySelector(".nav");
  var menuToggle = document.querySelector(".menuToggle");
  var wide = window.matchMedia("(min-width: 900px)");
  function setProducts(open, focusBtn) {
    if (!menuBtn || !menuPanel) return;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    menuPanel.hidden = !open;
    if (!open && focusBtn) menuBtn.focus();
  }
  function setPhoneMenu(open) {
    if (!navEl || !menuToggle) return;
    navEl.classList.toggle("open", open);
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (!open) setProducts(false);
  }
  if (menuBtn && menuPanel) {
    menuBtn.addEventListener("click", function () { setProducts(menuBtn.getAttribute("aria-expanded") !== "true"); });
    menuPanel.addEventListener("focusout", function (e) {
      if (wide.matches && e.relatedTarget && !menuBtn.parentElement.contains(e.relatedTarget)) setProducts(false);
    });
  }
  if (menuToggle) menuToggle.addEventListener("click", function () { setPhoneMenu(!navEl.classList.contains("open")); });
  document.addEventListener("click", function (e) {
    if (menuBtn && wide.matches && !menuBtn.parentElement.contains(e.target)) setProducts(false);
    var link = e.target.closest && e.target.closest(".navLinks a");
    if (link) { setProducts(false); setPhoneMenu(false); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (menuBtn && menuBtn.getAttribute("aria-expanded") === "true") { setProducts(false, true); return; }
    if (navEl && navEl.classList.contains("open")) { setPhoneMenu(false); menuToggle.focus(); }
  });
  if (wide.addEventListener) wide.addEventListener("change", function () { setPhoneMenu(false); });

  /* Hairline under the nav once the page scrolls. */
  var nav = document.querySelector(".nav");
  function onScroll() { if (nav) nav.classList.toggle("scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* Tabs (WAI-ARIA pattern: arrows move between tabs). */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function select(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { select(tab); });
    tab.addEventListener("keydown", function (e) {
      var j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      var next = tabs[(j + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });

  /* Copy buttons. */
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentElement.querySelector("code");
      var text = code ? code.textContent : "";
      var done = function (label) {
        btn.textContent = label;
        setTimeout(function () { btn.textContent = "Copy"; }, 1800);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done("Copied"); }, function () { done("Select and copy"); });
      } else {
        var range = document.createRange();
        range.selectNodeContents(code);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand("copy"); done("Copied"); } catch (e) { done("Select and copy"); }
      }
    });
  });

  /* Clips load only when close to view, and play only while visible.
     With reduced motion they show the poster and native controls instead. */
  var videos = Array.prototype.slice.call(document.querySelectorAll("video.lazyVideo"));
  function load(v) {
    if (v.dataset.loaded) return;
    v.dataset.loaded = "1";
    v.querySelectorAll("source[data-src]").forEach(function (s) { s.src = s.dataset.src; });
    v.load();
  }
  /* Product index: mark the section being read. */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc ol ol a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var tocIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        tocLinks.forEach(function (a) { a.removeAttribute("aria-current"); });
        var a = byId[entry.target.id];
        if (a) a.setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    Object.keys(byId).forEach(function (id) { var el = document.getElementById(id); if (el) tocIo.observe(el); });
  }

  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    videos.forEach(function (v) { v.controls = true; v.preload = "none"; v.querySelectorAll("source[data-src]").forEach(function (s) { s.src = s.dataset.src; }); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var v = entry.target;
      if (entry.isIntersecting) {
        load(v);
        var p = v.play();
        if (p && p.catch) p.catch(function () { v.controls = true; });
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, { rootMargin: "200px 0px" });
  /* The hero's painted loop waits for the page to finish loading; the poster shows first. */
  function start() { videos.forEach(function (v) { io.observe(v); }); }
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();

// Landing extras: hero film sound, reveal on scroll, the printing receipt and the hero contour shader.
(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasIO = "IntersectionObserver" in window;

  /* Hero film: muted by default (browsers only autoplay muted). Sound on restarts it with the voiceover. */
  var film = document.querySelector(".heroFilm");
  var soundBtn = document.querySelector(".soundBtn");
  if (film && soundBtn) {
    soundBtn.addEventListener("click", function () {
      var on = film.muted;
      film.querySelectorAll("source[data-src]").forEach(function (s) { if (!s.src) s.src = s.dataset.src; });
      if (!film.dataset.loaded) { film.dataset.loaded = "1"; film.load(); }
      film.muted = !on;
      if (on) { film.currentTime = 0; var p = film.play(); if (p && p.catch) p.catch(function () { film.controls = true; }); }
      soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
      soundBtn.textContent = on ? "Sound off" : "Sound on";
    });
  }

  /* Sections fade up once as they enter. Without JS or with reduced motion, nothing is hidden. */
  if (!reduce && hasIO) {
    var targets = document.querySelectorAll("main > section:not(.hero), .chapter, .footCta");
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -12% 0px" });
    Array.prototype.forEach.call(targets, function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight) return;   // already on screen: leave it be
      el.classList.add("reveal"); rio.observe(el);
    });
  }

  /* The receipt feeds out of its slot the first time it is seen. */
  var receipt = document.querySelector(".receiptWrap");
  if (receipt && !reduce && hasIO) {
    receipt.classList.add("printing");
    var pio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { receipt.classList.add("printed"); pio.disconnect(); } });
    }, { threshold: 0.35 });
    pio.observe(receipt);
  }

  /* Hero shader: slow contour lines, like a map of the painted hills. WebGL 1, no libraries. */
  var cv = document.querySelector(".heroShader");
  if (!cv) return;
  var gl = cv.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return;
  var vs = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var fs = [
    "precision mediump float;uniform vec2 r;uniform float t;uniform vec3 c;",
    "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}",
    "float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);",
    " return mix(mix(h(i),h(i+vec2(1,0)),u.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x),u.y);}",
    "float fb(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*n(p);p=p*1.9+vec2(1.7,9.2);a*=.45;}return v;}",
    "void main(){vec2 uv=gl_FragCoord.xy/r.y;",
    " float f=fb(uv*.9+vec2(t*.014,-t*.009));",
    " float k=f*15.;float d=abs(fract(k)-.5);",
    " float px=15.*.9/r.y;",                       /* about one line width per pixel row */
    " float line=1.-smoothstep(px*.35,px*1.1,d);",
    " float a=line*.3;gl_FragColor=vec4(c*a,a);}"
  ].join("\n");
  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
  var pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
  gl.useProgram(pr);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uR = gl.getUniformLocation(pr, "r"), uT = gl.getUniformLocation(pr, "t"), uC = gl.getUniformLocation(pr, "c");
  function accent() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().replace("#", "");
    if (v.length === 3) v = v.split("").map(function (x) { return x + x; }).join("");
    var i = parseInt(v, 16); return isNaN(i) ? [0.35, 0.42, 0.36] : [(i >> 16 & 255) / 255, (i >> 8 & 255) / 255, (i & 255) / 255];
  }
  function size() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
  }
  var t0 = performance.now(), visible = true, raf = 0, last = 0;
  function draw(now) {
    size();
    var col = accent();
    gl.uniform2f(uR, cv.width, cv.height); gl.uniform1f(uT, reduce ? 20 : (now - t0) / 1000 + 20); gl.uniform3f(uC, col[0], col[1], col[2]);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function loop(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    if (now - last > 33) { last = now; draw(now); }        /* ~30 fps is plenty for something this slow */
    raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf && !reduce) raf = requestAnimationFrame(loop); }
  draw(performance.now()); cv.classList.add("on");
  if (reduce) { window.addEventListener("resize", function () { draw(performance.now()); }); }
  else {
    if (hasIO) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) kick(); }).observe(cv);
    document.addEventListener("visibilitychange", kick);
    kick();
  }
  /* Repaint in the new accent colour when the theme flips. */
  new MutationObserver(function () { draw(performance.now()); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
