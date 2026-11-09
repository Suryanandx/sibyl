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
