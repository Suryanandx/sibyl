// Sibyl docs: client-side search over search-index.json (built by scripts/build-docs.mjs) and "On this page" highlighting.
(function () {
  "use strict";

  /* Search: the index loads on first use. Results are ranked by where the words appear. */
  var input = document.getElementById("docs-search");
  var list = document.getElementById("docs-search-results");
  var index = null;
  var loading = null;
  var active = -1;

  function load() {
    if (index || loading) return loading;
    loading = fetch("search-index.json")
      .then(function (r) { return r.json(); })
      .then(function (data) { index = data; return data; })
      .catch(function () { index = []; });
    return loading;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function highlight(text, words) {
    var out = escapeHtml(text);
    words.forEach(function (w) {
      if (w.length < 2) return;
      out = out.replace(new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>");
    });
    return out;
  }
  function snippet(text, words) {
    var lower = text.toLowerCase();
    var at = -1;
    words.some(function (w) { at = lower.indexOf(w); return at >= 0; });
    var start = Math.max(0, at - 50);
    var s = text.slice(start, start + 150);
    return (start > 0 ? "…" : "") + s + (start + 150 < text.length ? "…" : "");
  }
  function search(q) {
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || !index) return [];
    var scored = [];
    index.forEach(function (e) {
      var h = e.h.toLowerCase(), p = e.p.toLowerCase(), x = e.x.toLowerCase();
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i], s = 0;
        if (h.indexOf(w) >= 0) s += 6;
        if (p.indexOf(w) >= 0) s += 3;
        if (x.indexOf(w) >= 0) s += 1;
        if (!s) return; // every word must match somewhere
        score += s;
      }
      if (h === q.toLowerCase()) score += 10;
      scored.push({ e: e, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 12).map(function (r) { return r.e; });
  }
  function render() {
    var q = input.value.trim();
    active = -1;
    if (!q) { close(); return; }
    var results = search(q);
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    list.innerHTML = results.length
      ? results.map(function (e, i) {
          return '<li role="option" id="sr-' + i + '" aria-selected="false"><a href="' + e.u + '"><span class="rTitle">' + highlight(e.h, words) + '</span><span class="rPage">' + escapeHtml(e.p) + "</span>" +
            (e.x ? '<span class="rText">' + highlight(snippet(e.x, words), words) + "</span>" : "") + "</a></li>";
        }).join("")
      : '<li class="empty">No results for “' + escapeHtml(q) + "”.</li>";
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function move(delta) {
    var items = list.querySelectorAll('[role="option"]');
    if (!items.length) return;
    if (active >= 0) items[active].setAttribute("aria-selected", "false");
    active = (active + delta + items.length) % items.length;
    items[active].setAttribute("aria-selected", "true");
    items[active].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", items[active].id);
  }
  if (input && list) {
    input.addEventListener("focus", load);
    input.addEventListener("input", function () { (load() || Promise.resolve()).then(render); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") {
        var items = list.querySelectorAll('[role="option"] a');
        var target = items[active >= 0 ? active : 0];
        if (target) { e.preventDefault(); window.location.href = target.getAttribute("href"); }
      } else if (e.key === "Escape") { close(); }
    });
    document.addEventListener("click", function (e) { if (!input.parentElement.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
    });
  }

  /* On this page: mark the heading being read. */
  var links = Array.prototype.slice.call(document.querySelectorAll(".docsToc a"));
  if (links.length && "IntersectionObserver" in window) {
    var byId = {};
    links.forEach(function (a) { byId[decodeURIComponent(a.getAttribute("href").slice(1))] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.removeAttribute("aria-current"); });
        var a = byId[entry.target.id];
        if (a) a.setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-10% 0px -80% 0px" });
    Object.keys(byId).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
