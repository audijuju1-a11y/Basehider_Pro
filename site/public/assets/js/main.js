/* =============================================================================
   Aegishider 3.2.0 — landing page behaviour
   - renders the 38-part exploded assembly (hero + interactive stage)
   - scroll-driven explosion / chapter focus
   - layer selection, chips, atlas, copy buttons, counters, nav
   ========================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.remove("no-js");

  var BH = window.BH;
  if (!BH || !Array.isArray(BH.layers)) return;

  var params = new URLSearchParams(window.location.search);
  var STATIC = params.has("static");
  var FIXED_P = params.has("p") ? Math.max(0, Math.min(1, parseFloat(params.get("p")) || 0)) : null;
  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (STATIC) root.classList.add("is-static");

  var formatInt = function (n) { return String(n).padStart(2, "0"); };

  /* ---------------------------------------------------------------- helpers */
  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function partMarkup(layer) {
    switch (layer.type) {
      case "gear":
        return '<span class="disc"></span><span class="teeth"></span><span class="spokes"></span><span class="hub"></span><span class="screws"></span>';
      case "wheel":
        return '<span class="disc"></span><span class="spokes"></span><span class="rim"></span><span class="hub"></span>';
      case "ring":
        return '<span class="ring"></span><span class="hub hub--sm"></span>';
      case "bar":
        return '<span class="bar"></span>';
      case "coil":
        return '<span class="coil"></span><span class="bridge"></span>';
      case "glass":
        return '<span class="glass"></span>';
      case "jewel":
        return '<span class="jewel"></span>';
      default:
        return '<span class="disc"></span><span class="rim"></span><span class="hub"></span><span class="screws"></span>';
    }
  }

  function buildLayer(layer, index, total) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "layer layer--" + layer.type + " tone-" + layer.tone;
    btn.dataset.n = String(layer.n);
    btn.dataset.ch = layer.ch;
    // A very mild taper keeps the top of the stack slimmer without hiding rims.
    var taper = total > 1 ? 0.88 + 0.12 * (1 - index / (total - 1)) : 1;
    btn.style.setProperty("--d", (layer.r * 0.64 * taper).toFixed(2) + "%");
    btn.style.setProperty("--i", String(index));
    btn.style.setProperty("--dx", (layer.dx * 0.22).toFixed(1));
    btn.style.setProperty("--dy", (layer.dy * 0.22).toFixed(1));
    btn.style.setProperty("--rot", (layer.angle + ((layer.n * 47) % 360)) + "deg");
    if (layer.teeth) btn.style.setProperty("--teeth", String(13 + (layer.n % 7)));
    btn.setAttribute("aria-label", "ชั้น " + formatInt(layer.n) + " " + layer.code + " — " + layer.title);
    btn.innerHTML =
      '<span class="layer__edge" aria-hidden="true"></span>' +
      '<span class="part" aria-hidden="true">' + partMarkup(layer) + "</span>";
    return btn;
  }

  function decorative(kind, z, size) {
    var wrap = document.createElement("div");
    wrap.className = "layer layer--" + kind + " tone-brass";
    wrap.style.setProperty("--d", size + "%");
    wrap.style.setProperty("--i", String(z));
    wrap.setAttribute("aria-hidden", "true");
    if (kind === "dial") {
      wrap.innerHTML =
        '<span class="layer__edge" aria-hidden="true"></span>' +
        '<span class="part"><span class="dial"><span class="dial__ticks"></span>' +
        '<span class="hand hand--hour"></span><span class="hand hand--minute"></span>' +
        '<span class="dial__text"><b>AEGISHIDER</b><span>VISIBILITY GATE · 3.2.0</span></span></span></span>';
    } else if (kind === "crystal") {
      wrap.innerHTML = '<span class="layer__edge" aria-hidden="true"></span><span class="part"><span class="crystal"></span></span>';
    } else {
      wrap.className = "layer layer--base tone-dark";
      wrap.style.setProperty("--d", size + "%");
      wrap.style.setProperty("--i", String(z));
      wrap.innerHTML = '<span class="part"><span class="ring"></span><span class="hub hub--sm"></span></span>';
    }
    return wrap;
  }

  function buildAssembly(container, list, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment();
    if (!opts.hero) frag.appendChild(decorative("base", -2, 74));
    list.forEach(function (layer, index) { frag.appendChild(buildLayer(layer, index, list.length)); });
    var top = list.length; // z slots above the highest real layer
    frag.appendChild(decorative("dial", top + 1, opts.hero ? 46 : 44));
    frag.appendChild(decorative("crystal", top + 2, opts.hero ? 50 : 48));
    container.innerHTML = "";
    container.appendChild(frag);
    if (opts.hero) {
      container.setAttribute("aria-hidden", "true");
    } else {
      container.setAttribute("role", "group");
      container.setAttribute("aria-label", "กลไก 38 ชั้นแบบแยกชิ้นส่วน เลือกชิ้นส่วนเพื่ออ่านคำอธิบาย");
    }
  }

  /* --------------------------------------------------------------- hero art */
  var heroAssembly = document.getElementById("heroAssembly");
  if (heroAssembly) {
    var heroLayers = BH.layers.filter(function (l) { return l.hero; }).slice(0, 16);
    buildAssembly(heroAssembly, heroLayers, { hero: true });
  }

  /* ------------------------------------------------------------- stage setup */
  var stage = document.getElementById("stage");
  var assembly = document.getElementById("assembly");
  var anatomy = document.querySelector("[data-anatomy]");
  var stageInfo = document.getElementById("stageInfo");
  var stageReset = document.getElementById("stageReset");
  var stageChapterEl = document.getElementById("stageChapter");
  var stageChapterNameEl = document.getElementById("stageChapterName");
  var spreadMeter = document.getElementById("spreadMeter");
  var spreadPct = document.getElementById("spreadPct");
  var chapterEls = Array.prototype.slice.call(document.querySelectorAll(".chapter"));
  var selected = null;
  var activeChapterId = BH.chapters[0].id;

  if (assembly) buildAssembly(assembly, BH.layers, {});

  var layerNodes = assembly ? Array.prototype.slice.call(assembly.querySelectorAll(".layer[data-n]")) : [];
  var layerByN = new Map();
  layerNodes.forEach(function (node) { layerByN.set(Number(node.dataset.n), node); });

  function chapterMeta(id) {
    return BH.chapters.filter(function (c) { return c.id === id; })[0] || BH.chapters[0];
  }

  function setInfoDefault() {
    if (!stageInfo) return;
    stageInfo.innerHTML =
      '<div class="stage__info-head"><span class="stage__info-n">38 ชิ้นส่วน</span>' +
      '<span class="stage__info-code">4 ชุดกลไก</span></div>' +
      '<p class="stage__info-title">กดที่ชิ้นส่วนหรือรายการด้านขวา<br>เพื่ออ่านว่าชิ้นนั้นทำอะไร</p>' +
      '<p class="stage__info-desc">ตัวเลขทุกตัวในหน้านี้มาจากการวัดจริงบน Paper 1.21.4 ไม่ใช่ค่าประมาณ</p>';
    if (stageReset) stageReset.hidden = true;
  }

  function setInfoLayer(layer) {
    if (!stageInfo) return;
    var meta = chapterMeta(layer.ch);
    stageInfo.innerHTML =
      '<div class="stage__info-head"><span class="stage__info-n">ชั้นที่ ' + formatInt(layer.n) + " / 38</span>" +
      '<span class="stage__info-code">' + layer.code + " · " + meta.name + "</span></div>" +
      '<p class="stage__info-title">' + layer.title + "</p>" +
      '<p class="stage__info-desc">' + layer.desc + "</p>";
    if (stageReset) stageReset.hidden = false;
  }

  function updateChipStates() {
    document.querySelectorAll(".chip").forEach(function (chip) {
      var isActive = selected != null && Number(chip.dataset.layer) === selected;
      chip.classList.toggle("is-active", isActive);
      chip.setAttribute("aria-pressed", String(isActive));
    });
  }

  function selectLayer(n) {
    var layer = BH.layers.filter(function (l) { return l.n === n; })[0];
    if (!layer || !assembly) return;
    selected = n;
    assembly.classList.add("has-selection");
    layerNodes.forEach(function (node) {
      var nodeN = Number(node.dataset.n);
      node.classList.toggle("is-active", nodeN === n);
      node.classList.toggle("is-above", nodeN > n);
    });
    setInfoLayer(layer);
    updateChipStates();
    if (stageReset) stageReset.hidden = false;
  }

  function clearSelection() {
    selected = null;
    if (assembly) assembly.classList.remove("has-selection");
    layerNodes.forEach(function (node) { node.classList.remove("is-active", "is-above"); });
    setInfoDefault();
    updateChipStates();
  }

  layerNodes.forEach(function (node) {
    node.addEventListener("click", function (event) {
      event.stopPropagation();
      selectLayer(Number(node.dataset.n));
    });
    node.addEventListener("pointerenter", function () {
      if (selected == null) node.classList.add("is-hover");
    });
    node.addEventListener("pointerleave", function () { node.classList.remove("is-hover"); });
  });

  if (stage) {
    stage.addEventListener("click", function (event) {
      if (event.target.closest(".layer") || event.target.closest(".stage__foot")) return;
      clearSelection();
    });
  }
  if (stageReset) stageReset.addEventListener("click", clearSelection);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") clearSelection();
  });

  /* ------------------------------------------------------ chapter + chips UI */
  document.querySelectorAll("[data-chips]").forEach(function (list) {
    var chapterId = list.dataset.chips;
    (BH.layersByChapter[chapterId] || []).forEach(function (layer) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.layer = String(layer.n);
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML =
        '<span class="chip__n">' + formatInt(layer.n) + "</span>" +
        '<span class="chip__code">' + layer.code + "</span>" +
        '<span class="chip__title">' + layer.title + "</span>";
      btn.addEventListener("click", function () {
        selectLayer(layer.n);
        var node = layerByN.get(layer.n);
        if (node && window.innerWidth > 1020) node.focus({ preventScroll: true });
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  });

  /* --------------------------------------------------------------- atlas */
  var atlas = document.getElementById("atlasGroups");
  if (atlas) {
    BH.chapters.forEach(function (chapter) {
      var list = BH.layersByChapter[chapter.id] || [];
      var group = el("div", "atlas__group");
      group.innerHTML =
        '<div class="atlas__group-head">' +
        '<span class="mono">' + chapter.num + " — " + chapter.name + "</span>" +
        "<h3>" + chapter.title + "</h3>" +
        '<span class="atlas__count">' + list.length + " ชิ้นส่วน</span>" +
        "</div>" +
        '<div class="atlas__grid"></div>';
      var grid = group.querySelector(".atlas__grid");
      list.forEach(function (layer) {
        var card = el("article", "lcard lcard--" + layer.type + " tone-" + layer.tone);
        card.innerHTML =
          '<div class="lcard__top">' +
          '<span class="lcard__mini" aria-hidden="true"></span>' +
          '<span class="lcard__num">' + formatInt(layer.n) + "</span>" +
          '<span class="lcard__code">' + layer.code + "</span>" +
          "</div>" +
          "<h4>" + layer.title + "</h4>" +
          '<span class="lcard__spec">' + layer.spec + "</span>" +
          "<p>" + layer.desc + "</p>";
        grid.appendChild(card);
      });
      atlas.appendChild(group);
    });
  }

  /* ------------------------------------------------------------- scroll sync */
  var ticking = false;
  var lastChapterIndex = -1;

  function computeProgress() {
    if (!anatomy) return 0;
    var rect = anatomy.getBoundingClientRect();
    var total = rect.height - window.innerHeight;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(1, -rect.top / total));
  }

  function setSpread(p) {
    if (!assembly) return;
    var gap = 2.6 + p * 6.0;              // 2.6 → 8.6 px between layers (z)
    var spin = -26 + p * 44;              // rotate as it opens
    var tilt = 62 - p * 2;
    var scale = 1 - p * 0.03;
    assembly.style.setProperty("--gap", gap.toFixed(2));
    assembly.style.setProperty("--fanX", (p * 2.2).toFixed(2) + "px");
    assembly.style.setProperty("--fanY", (p * 0.8).toFixed(2) + "px");
    assembly.style.setProperty("--spin", spin.toFixed(1) + "deg");
    assembly.style.setProperty("--tiltX", tilt.toFixed(1) + "deg");
    assembly.style.setProperty("--asScale", scale.toFixed(3));
    if (spreadMeter) spreadMeter.style.width = (p * 100).toFixed(0) + "%";
    if (spreadPct) spreadPct.textContent = Math.round(p * 100) + "%";
  }

  function setActiveChapter(index) {
    if (index === lastChapterIndex) return;
    lastChapterIndex = index;
    var chapter = chapterEls[index];
    if (!chapter) return;
    activeChapterId = chapter.dataset.ch;
    chapterEls.forEach(function (el, i) { el.classList.toggle("is-active", i === index); });
    if (stageChapterEl) stageChapterEl.textContent = formatInt(index + 1);
    if (stageChapterNameEl) stageChapterNameEl.textContent = chapterMeta(activeChapterId).name;
    if (assembly) assembly.dataset.focusCh = activeChapterId;
  }

  function detectChapter() {
    if (!chapterEls.length) return 0;
    var mid = window.innerHeight * 0.46;
    var best = 0;
    var bestDist = Infinity;
    chapterEls.forEach(function (node, i) {
      var rect = node.getBoundingClientRect();
      var chapterMid = rect.top + rect.height / 2;
      var dist = Math.abs(chapterMid - mid);
      if (rect.bottom < 80 || rect.top > window.innerHeight - 40) dist += window.innerHeight;
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  function updateScrollUI() {
    ticking = false;
    var p = FIXED_P != null ? FIXED_P : computeProgress();
    if (!STATIC) setSpread(p);

    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var progress = document.getElementById("scrollProgress");
    if (progress) progress.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0) + "%";

    var head = document.getElementById("siteHead");
    if (head) head.classList.toggle("is-scrolled", window.scrollY > 12);

    if (!STATIC) setActiveChapter(detectChapter());
  }

  function requestScrollUpdate() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(updateScrollUI);
  }

  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  window.addEventListener("resize", requestScrollUpdate);

  if (STATIC) {
    setSpread(FIXED_P != null ? FIXED_P : 0.86);
    chapterEls.forEach(function (node) { node.classList.add("is-active"); });
    if (spreadMeter) spreadMeter.style.width = "86%";
    if (spreadPct) spreadPct.textContent = "86%";
  } else {
    updateScrollUI();
  }

  /* -------------------------------------------------------------- nav / menu */
  var nav = document.getElementById("primaryNav");
  var navToggle = document.getElementById("navToggle");
  function closeNav() {
    if (!nav) return;
    nav.classList.remove("is-open");
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "เปิดเมนู");
    }
  }
  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      var open = !nav.classList.contains("is-open");
      nav.classList.toggle("is-open", open);
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "ปิดเมนู" : "เปิดเมนู");
    });
    nav.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", closeNav); });
    document.addEventListener("click", function (event) {
      if (!nav.classList.contains("is-open")) return;
      if (event.target.closest("#primaryNav") || event.target.closest("#navToggle")) return;
      closeNav();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeNav();
    });
  }

  /* active nav link */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav a[href^='#']"));
  var sections = navLinks.map(function (link) {
    return document.querySelector(link.getAttribute("href"));
  });
  if ("IntersectionObserver" in window) {
    var navObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = "#" + entry.target.id;
        navLinks.forEach(function (link) {
          link.classList.toggle("is-active", link.getAttribute("href") === id);
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
    sections.forEach(function (section) { if (section) navObserver.observe(section); });
  }

  /* ---------------------------------------------------------------- reveal */
  if (!REDUCED && "IntersectionObserver" in window) {
    var targets = document.querySelectorAll(
      ".section-head, .compare__col, .feature, .pstat, .chart, .spike, .perf__notes, .step, .panel, .limit, .lcard, .spec, .dl-card, .qa, .scene, .gate, .config-card, .evidence, .glossary__item, .timeline__item"
    );
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    targets.forEach(function (node, i) {
      if (node.closest(".assembly")) return;
      node.classList.add("reveal");
      node.style.transitionDelay = Math.min(i % 8, 5) * 40 + "ms";
      revealObserver.observe(node);
    });
  }

  /* -------------------------------------------------------------- counters */
  function animateCounter(node) {
    var target = parseFloat(node.dataset.count);
    var decimals = parseInt(node.dataset.decimals || "0", 10);
    if (!isFinite(target)) return;
    var start = performance.now();
    var duration = 1100;
    function frame(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = (target * eased).toFixed(decimals);
      if (t < 1) requestAnimationFrame(frame);
      else node.textContent = target.toFixed(decimals);
    }
    requestAnimationFrame(frame);
  }
  if (!REDUCED && "IntersectionObserver" in window) {
    var counterObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      });
    }, { threshold: 0.6 });
    document.querySelectorAll("[data-count]").forEach(function (node) { counterObserver.observe(node); });
  }

  /* ------------------------------------------------------------ copy buttons */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  document.querySelectorAll("[data-copy-target]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      copyText(target.innerText).then(function () {
        var label = btn.querySelector("span");
        var original = label ? label.textContent : "";
        btn.classList.add("is-done");
        if (label) label.textContent = "คัดลอกแล้ว";
        window.setTimeout(function () {
          btn.classList.remove("is-done");
          if (label) label.textContent = original;
        }, 1800);
      }).catch(function () {
        if (btn.querySelector("span")) btn.querySelector("span").textContent = "คัดลอกไม่ได้";
      });
    });
  });

  /* ------------------------------------------------------ config preset tabs */
  var presetButtons = Array.prototype.slice.call(document.querySelectorAll("[data-preset]"));
  var presetPanels = Array.prototype.slice.call(document.querySelectorAll("[data-preset-panel]"));
  if (presetButtons.length && presetPanels.length) {
    presetButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        var target = button.dataset.preset;
        presetButtons.forEach(function (item) {
          var active = item === button;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-selected", String(active));
        });
        presetPanels.forEach(function (panel) {
          panel.hidden = panel.dataset.presetPanel !== target;
        });
      });
    });
  }

  /* ------------------------------------------------------ initial UI states */
  setInfoDefault();
  requestScrollUpdate();
})();
