// ==UserScript==
// @name         PKU 课表美化与期末安排
// @namespace    local.pku.exam.timeline
// @version      0.2.5
// @description  美化北大门户课表，生成可编辑期末安排，并支持 Wakeup CSV 导出。
// @match        https://portal.pku.edu.cn/publicQuery/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_RAW = "pkuExamUserscript.rawCoursePayload";
  const STORAGE_EDIT = "pkuExamUserscript.edits";
  const STORAGE_THEME = "pkuExamUserscript.themeMode";
  const PERIOD_TIME = {
    "上午": "08:30-10:30",
    "下午": "14:00-16:00",
    "晚上": "18:30-20:30"
  };
  const PERIOD_ORDER = {"上午": 1, "下午": 2, "晚上": 3};
  const ASSESSMENT_OPTIONS = ["待补", "期末考试", "论文", "大作业", "随堂考试"];

  let exams = [];
  let rawPayloadText = localStorage.getItem(STORAGE_RAW) || "";
  let scheduledCollapsed = false;
  let pendingCollapsed = false;
  let mounted = false;
  let themeMode = localStorage.getItem(STORAGE_THEME) || "system";
  const mediaTheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function capturePayload(url, payloadText) {
    if (!payloadText || !String(url || "").includes("getCourseInfo.do")) return;
    rawPayloadText = payloadText;
    localStorage.setItem(STORAGE_RAW, payloadText);
    localStorage.setItem("pkuExamUserscript.lastCapturedAt", new Date().toISOString());
    parseAndRender();
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input && input.url;
      if (String(url || response.url || "").includes("getCourseInfo.do")) {
        response.clone().text().then((text) => capturePayload(url || response.url, text)).catch(() => {});
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__pkuExamUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function patchedSend() {
    if (String(this.__pkuExamUrl || "").includes("getCourseInfo.do")) {
      this.addEventListener("load", () => {
        try {
          capturePayload(this.__pkuExamUrl, this.responseText);
        } catch {
          // Ignore non-text responses.
        }
      });
    }
    return originalSend.apply(this, arguments);
  };

  function ready(callback) {
    if (document.body) callback();
    else document.addEventListener("DOMContentLoaded", callback, {once: true});
  }

  ready(() => {
    mount();
    applyTheme(themeMode);
    if (mediaTheme) {
      const onSystemThemeChange = () => {
        if (themeMode === "system") applyTheme("system");
      };
      if (typeof mediaTheme.addEventListener === "function") mediaTheme.addEventListener("change", onSystemThemeChange);
      else if (typeof mediaTheme.addListener === "function") mediaTheme.addListener(onSystemThemeChange);
    }
    parseAndRender();
    alignPortalChrome();
    enhanceCourseTable();
    new MutationObserver(() => {
      alignPortalChrome();
      enhanceCourseTable();
    }).observe(document.body, {childList: true, subtree: true});
  });

  function mount() {
    if (mounted) return;
    mounted = true;
    document.documentElement.classList.add("pku-exam-userscript-ready");
    const style = document.createElement("style");
    style.textContent = css();
    document.head.appendChild(style);

    const toolbar = document.createElement("div");
    toolbar.id = "pku-exam-toolbar";
    toolbar.innerHTML = `
      <div class="pku-app-brand">
        <span class="pku-brand-mark">北</span>
        <span class="pku-brand-text">
          <strong>课表助手</strong>
          <small>PKU Course Planner</small>
        </span>
      </div>
        <div class="pku-app-actions">
          <button type="button" id="pku-export-wakeup-csv" class="pku-toolbar-command">导出 CSV</button>
          <div id="pku-view-switch" class="pku-view-switch" role="group" aria-label="视图切换" data-view="table">
          <span class="pku-view-thumb" aria-hidden="true"></span>
          <button type="button" data-view="table" class="is-active">课表</button>
          <button type="button" data-view="exam">期末安排</button>
        </div>
        <div id="pku-theme-switch" class="pku-theme-switch" role="group" aria-label="颜色模式">
          <span class="pku-theme-thumb" aria-hidden="true"></span>
          <button type="button" data-theme-mode="system" title="跟随显示屏">屏</button>
          <button type="button" data-theme-mode="light" title="浅色模式">浅</button>
          <button type="button" data-theme-mode="dark" title="深色模式">深</button>
        </div>
      </div>
    `;
    document.body.insertBefore(toolbar, document.body.firstChild);

    const panel = document.createElement("section");
    panel.id = "pku-exam-panel";
    panel.innerHTML = `
      <aside class="pku-editor">
        <header class="pku-panel-head">
          <h1>期末安排</h1>
          <div class="pku-panel-actions">
            <button type="button" id="pku-refresh-from-table">重新读取</button>
            <button type="button" id="pku-export-timeline">导出图片</button>
          </div>
        </header>
        <p id="pku-exam-note">打开或刷新课表后，脚本会自动读取课程数据。</p>
        <div class="pku-stats">
          <div><strong id="pku-total">0</strong><span>课程</span></div>
          <div><strong id="pku-ready">0</strong><span>已排</span></div>
          <div><strong id="pku-missing">0</strong><span>待补</span></div>
        </div>
        <div id="pku-edit-list"></div>
      </aside>
      <main class="pku-preview">
        <div id="pku-timeline" class="pku-timeline"></div>
      </main>
    `;
    document.body.appendChild(panel);

    const courseRoot = document.createElement("main");
    courseRoot.id = "pku-course-grid-root";
    courseRoot.innerHTML = `<div class="pku-course-loading">打开或刷新课表后，将自动生成课表。</div>`;
    document.body.insertBefore(courseRoot, panel);

    toolbar.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });
    toolbar.querySelectorAll("[data-theme-mode]").forEach((button) => {
      button.addEventListener("click", () => applyTheme(button.dataset.themeMode));
    });
    panel.querySelector("#pku-refresh-from-table").addEventListener("click", parseAndRender);
    panel.querySelector("#pku-export-timeline").addEventListener("click", exportTimelineImage);
    toolbar.querySelector("#pku-export-wakeup-csv").addEventListener("click", exportWakeupCsv);
  }

  function setView(view) {
    document.body.classList.toggle("pku-exam-view", view === "exam");
    const switcher = document.querySelector("#pku-view-switch");
    if (switcher) switcher.dataset.view = view === "exam" ? "exam" : "table";
    document.querySelectorAll("#pku-exam-toolbar [data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === view);
    });
  }

  function applyTheme(mode) {
    themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
    localStorage.setItem(STORAGE_THEME, themeMode);
    const active = activeTheme();
    document.documentElement.dataset.pkuExamTheme = active;
    document.documentElement.dataset.pkuExamThemeMode = themeMode;
    const switcher = document.querySelector("#pku-theme-switch");
    if (switcher) {
      switcher.dataset.mode = themeMode;
      switcher.querySelectorAll("[data-theme-mode]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.themeMode === themeMode);
        button.setAttribute("aria-pressed", String(button.dataset.themeMode === themeMode));
      });
    }
    document.querySelectorAll(".pku-beautified-course-cell").forEach(applyCourseCellTheme);
    document.querySelectorAll(".pku-json-course-cell").forEach(applyJsonCourseCellTheme);
  }

  function activeTheme() {
    if (themeMode === "light" || themeMode === "dark") return themeMode;
    return mediaTheme && mediaTheme.matches ? "dark" : "light";
  }

  function enhanceCourseTable() {
    const courseTables = new Set();
    document.querySelectorAll("td, .el-table__cell, .cell").forEach((cell) => {
      if (cell.classList.contains("cell") && cell.closest("td, th")) return;
      const text = cell.textContent || "";
      if (text.includes("上课信息") || text.includes("考试信息")) {
        rememberCourseCellColors(cell);
        cell.classList.add("pku-beautified-course-cell");
        beautifyCourseCellContent(cell);
        applyCourseCellTheme(cell);
        const table = cell.closest("table");
        if (table) courseTables.add(table);
      }
      if (/^\s*(一|二|三|四|五|六|日|天)\s*$/.test(text)) {
        cell.classList.add("pku-week-head");
        const table = cell.closest("table");
        if (table) courseTables.add(table);
      }
    });
    courseTables.forEach((table) => {
      table.classList.add("pku-course-table");
      const columns = table.querySelectorAll("col");
      columns.forEach((column, index) => {
        column.style.width = index === 0 ? "44px" : "calc((100% - 44px) / 7)";
      });
      let parent = table.parentElement;
      for (let depth = 0; parent && depth < 9; depth += 1) {
        parent.classList.add("pku-course-table-shell");
        parent = parent.parentElement;
      }
      const pageRoot = table.closest(".publicQuery, .el-main, .main, .content, .container, [class*='content'], [class*='container']");
      if (pageRoot) pageRoot.classList.add("pku-course-wide-root");
    });
  }

  function alignPortalChrome() {
    const markers = ["北京大学校内信息门户", "[退出]", "退出"];
    document.querySelectorAll("body *").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const text = (node.textContent || "").trim();
      if (!text || text.length > 80 || !markers.some((marker) => text.includes(marker))) return;
      let parent = node;
      for (let depth = 0; parent && parent !== document.body && depth < 6; depth += 1) {
        const width = parent.getBoundingClientRect().width;
        if (width > 320 && width < window.innerWidth * 0.92) {
          parent.classList.add("pku-portal-wide-content");
          const shell = findCompactShell(parent);
          if (shell) shell.classList.add("pku-portal-chrome-shell");
          break;
        }
        parent = parent.parentElement;
      }
    });
    document.querySelectorAll("select").forEach((select) => {
      const text = (select.textContent || "").trim();
      if (/学年|学期/.test(text)) select.classList.add("pku-term-select");
    });
    document.querySelectorAll("img").forEach((image) => {
      const parent = image.parentElement;
      if (!parent) return;
      const text = (parent.textContent || "").trim();
      if (text.includes("我的课表") || image.getBoundingClientRect().width > 36) {
        parent.classList.add("pku-course-title-strip");
      }
    });
    document.querySelectorAll("body *").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const text = (node.textContent || "").trim();
      if (text !== "我的课表") return;
      node.classList.add("pku-course-title-strip");
      const shell = findCompactShell(node);
      if (shell) shell.classList.add("pku-course-title-strip");
    });
  }

  function findCompactShell(node) {
    let current = node;
    let candidate = node;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      const rect = current.getBoundingClientRect();
      if (rect.height > 0 && rect.height < 180 && rect.width > window.innerWidth * 0.5) candidate = current;
      current = current.parentElement;
    }
    return candidate;
  }

  function beautifyCourseCellContent(cell) {
    const target = cell.querySelector(":scope > .cell") || cell;
    if (!cell.dataset.pkuOriginalHtml) cell.dataset.pkuOriginalHtml = target.innerHTML;
    if (target.dataset.pkuStructured === "1") return;
    const entries = parseCourseDisplayEntries(cell.dataset.pkuOriginalHtml);
    if (!entries.length) return;
    target.dataset.pkuStructured = "1";
    target.classList.add("pku-course-content");
    target.innerHTML = entries.map(renderCourseDisplayEntry).join("");
  }

  function parseCourseDisplayEntries(html) {
    const lines = stripHtmlToLines(html);
    const entries = [];
    let current = null;
    lines.forEach((line) => {
      if (line.startsWith("上课信息")) {
        if (!current) current = {name: ""};
        current.classInfo = parseClassDisplayLine(line);
        return;
      }
      if (line.startsWith("考试信息")) {
        if (!current) current = {name: ""};
        current.examInfo = parseExamDisplayLine(line);
        entries.push(current);
        current = null;
        return;
      }
      if (current && current.name) entries.push(current);
      current = {name: normalizeCourseName(line), classInfo: {}, examInfo: {}};
    });
    if (current && current.name) entries.push(current);
    return mergeCourseDisplayEntries(entries.filter((entry) => entry.name || entry.classInfo.raw || entry.examInfo.raw));
  }

  function parseClassDisplayLine(line) {
    const raw = String(line || "").replace(/^上课信息[:：]\s*/, "").trim();
    const [beforeRemark, remark = ""] = raw.split(/\s+备注[:：]\s*/);
    const teacherMatch = beforeRemark.match(/\s+教师[:：]\s*(.*)$/);
    const teacher = teacherMatch ? teacherMatch[1].trim() : "";
    const beforeTeacher = teacherMatch ? beforeRemark.slice(0, teacherMatch.index).trim() : beforeRemark.trim();
    const match = beforeTeacher.match(/^(.+?周)(?:\s+(每周|单周|双周))?\s*(.*)$/);
    return {
      raw,
      weeks: match ? match[1].trim() : "",
      parity: match ? match[2].trim() : "",
      room: match ? match[3].trim() : beforeTeacher,
      teacher,
      remark: remark.trim()
    };
  }

  function parseExamDisplayLine(line) {
    const raw = String(line || "").replace(/^考试信息[:：]\s*/, "").trim();
    if (!raw) return {};
    const match = raw.match(/^(\d{8})\s+(星期[一二三四五六日天])\s+(上午|下午|晚上)(?:\s+(.+))?$/);
    if (!match) return {raw};
    const [, date, weekday, period, place = ""] = match;
    return {raw, date: dateFromRaw(date), weekday, period, place: place.trim()};
  }

  function renderCourseDisplayEntry(entry) {
    const infos = entry.classInfos && entry.classInfos.length ? entry.classInfos : [entry.classInfo || {}];
    const mainInfo = infos[0] || {};
    const exam = entry.examInfo || {};
    const scheduleParts = scheduleDisplayParts(infos);
    const room = mainInfo.room || "";
    const teacher = mainInfo.teacher || "";
    const remark = mainInfo.remark || "";
    const scheduleHtml = scheduleParts.map((part) => `<span class="${part.className}">${escapeHtml(part.text)}</span>`).join("<i>/</i>");
    const examTime = exam.date || exam.period ? [exam.date, exam.period].filter(Boolean).join(" ") : "";
    return `
      <section class="pku-course-entry">
        ${entry.name ? `<strong class="pku-course-name">${escapeHtml(entry.name)}</strong>` : ""}
        ${scheduleHtml ? renderCourseDetail("时间", scheduleHtml, "is-time") : ""}
        ${room ? renderCourseDetail("地点", escapeHtml(room), "") : ""}
        ${teacher ? renderCourseDetail("教师", escapeHtml(teacher), "") : ""}
        ${examTime ? renderCourseDetail("期末考试时间", escapeHtml(examTime), "is-exam") : ""}
        ${exam.place ? renderCourseDetail("期末考试地点", escapeHtml(exam.place), "is-exam") : ""}
        ${remark ? renderCourseDetail("备注", escapeHtml(remark), "") : ""}
      </section>
    `;
  }

  function renderCourseDetail(label, valueHtml, className = "") {
    return `
      <div class="pku-course-detail ${className}">
        <b>${escapeHtml(label)}：</b>
        <span>${valueHtml}</span>
      </div>
    `;
  }

  function mergeCourseDisplayEntries(entries) {
    const groups = [];
    entries.forEach((entry) => {
      const info = entry.classInfo || {};
      const key = [entry.name || "", info.room || "", info.teacher || "", (entry.examInfo || {}).raw || ""].join("|");
      const group = groups.find((item) => item.key === key);
      if (group) {
        if (!group.entry.classInfo.remark && info.remark) group.entry.classInfo.remark = info.remark;
        group.entry.classInfos.push(info);
        return;
      }
      groups.push({key, entry: {...entry, classInfos: info.raw ? [info] : []}});
    });
    return groups.map((group) => {
      group.entry.classInfos = compactClassInfos(group.entry.classInfos);
      return group.entry;
    });
  }

  function compactClassInfos(infos) {
    const items = infos.filter((info) => info && (info.weeks || info.parity || info.raw));
    return items.filter((info, index) => {
      const range = weekRange(info.weeks);
      if (!range) return true;
      return !items.some((other, otherIndex) => {
        if (otherIndex === index || other.parity !== "每周") return false;
        const otherRange = weekRange(other.weeks);
        return otherRange && otherRange.start <= range.start && otherRange.end >= range.end;
      });
    });
  }

  function scheduleDisplayParts(infos) {
    const compact = compactClassInfos(infos);
    const byRange = new Map();
    compact.forEach((info) => {
      const key = info.weeks || "";
      if (!byRange.has(key)) byRange.set(key, []);
      byRange.get(key).push(info.parity || "每周");
    });
    const parts = [];
    byRange.forEach((parities, weeks) => {
      const unique = [...new Set(parities)];
      if (unique.includes("每周")) {
        parts.push({text: `${weeks}${weeks ? " · " : ""}每周`, className: ""});
        return;
      }
      unique.forEach((parity) => {
        parts.push({text: `${weeks}${weeks ? " · " : ""}${parity}`, className: parityClass(parity)});
      });
    });
    return parts;
  }

  function weekRange(value) {
    const match = String(value || "").match(/(\d+)\s*-\s*(\d+)周/);
    if (!match) return null;
    return {start: Number(match[1]), end: Number(match[2])};
  }

  function parityClass(parity) {
    if (parity === "单周") return "is-odd-week";
    if (parity === "双周") return "is-even-week";
    return "";
  }

  function rememberCourseCellColors(cell) {
    if (cell.dataset.pkuOriginalBg && cell.dataset.pkuOriginalColor) return;
    const style = getComputedStyle(cell);
    cell.dataset.pkuOriginalBg = readAuthoredBackground(cell) || style.backgroundColor || "";
    cell.dataset.pkuOriginalColor = readAuthoredColor(cell) || style.color || "";
  }

  function applyCourseCellTheme(cell) {
    rememberCourseCellColors(cell);
    const originalBg = parseColor(cell.dataset.pkuOriginalBg);
    const originalColor = parseColor(cell.dataset.pkuOriginalColor);
    cell.classList.toggle("is-course-conflict", isConflictCourseColor(originalBg, originalColor));
    if (activeTheme() === "dark") {
      const palette = darkCoursePalette(originalBg, originalColor);
      const bg = palette.bg;
      const text = palette.fg;
      cell.style.setProperty("--pku-cell-bg", rgbCss(bg));
      cell.style.setProperty("--pku-cell-fg", text);
      cell.style.setProperty("--pku-cell-border", "rgba(213, 189, 161, 0.22)");
      return;
    }
    if (usefulCourseColor(originalBg)) cell.style.setProperty("--pku-cell-bg", rgbCss(originalBg));
    else cell.style.removeProperty("--pku-cell-bg");
    if (originalColor) cell.style.setProperty("--pku-cell-fg", rgbCss(originalColor));
    else cell.style.removeProperty("--pku-cell-fg");
    cell.style.removeProperty("--pku-cell-border");
  }

  function darkCoursePalette(originalBg, originalColor) {
    const source = usefulCourseColor(originalBg) || usefulCourseColor(originalColor);
    if (!source) return {bg: {r: 36, g: 24, b: 18}, fg: "#FFF0DF"};
    const hsl = rgbToHsl(source);
    const chroma = Math.max(source.r, source.g, source.b) - Math.min(source.r, source.g, source.b);
    const saturation = chroma < 18 ? 0.12 : Math.min(0.68, Math.max(0.26, hsl.s * 0.82));
    let bg = hslToRgb({h: hsl.h, s: saturation, l: 0.22});
    if (relativeLuminance(bg) < 0.025) bg = hslToRgb({h: hsl.h, s: saturation, l: 0.26});
    const semanticAccent = originalColor && isRedLike(originalColor) ? "#FF7878" : null;
    const accentRgb = semanticAccent ? parseHex(semanticAccent) : null;
    const fg = accentRgb && contrastRatio(accentRgb, bg) >= 4.5 ? semanticAccent : bestTextOn(bg);
    return {bg, fg};
  }

  function bestTextOn(bg) {
    return contrastRatio(bg, {r: 255, g: 240, b: 223}) >= 4.5 ? "#FFF0DF" : "#18110D";
  }

  function usefulCourseColor(rgb) {
    if (!rgb || rgb.a === 0 || rgbIsNearlyWhite(rgb)) return null;
    const hsl = rgbToHsl(rgb);
    if (hsl.l < 0.06 || hsl.l > 0.96) return null;
    return rgb;
  }

  function isConflictCourseColor(bg, fg) {
    return fg && isRedLike(fg) && (!bg || rgbIsNearlyWhite(bg));
  }

  function readAuthoredBackground(cell) {
    return readStyleColor(cell, "background-color");
  }

  function readAuthoredColor(cell) {
    return readStyleColor(cell, "color");
  }

  function readStyleColor(cell, property) {
    const style = cell.getAttribute("style") || "";
    const pattern = new RegExp(`${property}\\s*:\\s*([^;]+)`, "i");
    const match = style.match(pattern);
    if (!match || match[1].trim().startsWith("var(")) return "";
    const value = match[1].trim();
    return parseColor(value) ? value : "";
  }

  function parseColor(value) {
    return parseRgb(value) || parseHex(value);
  }

  function parseRgb(value) {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => part.trim());
    const rgb = {
      r: clampColor(Number.parseFloat(parts[0])),
      g: clampColor(Number.parseFloat(parts[1])),
      b: clampColor(Number.parseFloat(parts[2])),
      a: parts[3] === undefined ? 1 : Number.parseFloat(parts[3])
    };
    return Number.isFinite(rgb.r + rgb.g + rgb.b) ? rgb : null;
  }

  function parseHex(value) {
    const hex = String(value || "").replace("#", "").trim();
    if (!/^[\da-f]{6}$/i.test(hex)) return null;
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }

  function clampColor(value) {
    return Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)));
  }

  function rgbIsNearlyWhite(rgb) {
    return rgb.r > 238 && rgb.g > 238 && rgb.b > 238;
  }

  function isRedLike(rgb) {
    return rgb.r > 170 && rgb.g < 90 && rgb.b < 90;
  }

  function rgbCss(rgb) {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }

  function rgbToHsl(rgb) {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return {h, s, l};
  }

  function hslToRgb(hsl) {
    let r;
    let g;
    let b;
    if (hsl.s === 0) {
      r = hsl.l;
      g = hsl.l;
      b = hsl.l;
    } else {
      const hue2rgb = (p, q, t) => {
        let next = t;
        if (next < 0) next += 1;
        if (next > 1) next -= 1;
        if (next < 1 / 6) return p + (q - p) * 6 * next;
        if (next < 1 / 2) return q;
        if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
        return p;
      };
      const q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
      const p = 2 * hsl.l - q;
      r = hue2rgb(p, q, hsl.h + 1 / 3);
      g = hue2rgb(p, q, hsl.h);
      b = hue2rgb(p, q, hsl.h - 1 / 3);
    }
    return {r: clampColor(r * 255), g: clampColor(g * 255), b: clampColor(b * 255)};
  }

  function relativeLuminance(rgb) {
    const channel = (value) => {
      const next = value / 255;
      return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrastRatio(a, b) {
    const light = Math.max(relativeLuminance(a), relativeLuminance(b));
    const dark = Math.min(relativeLuminance(a), relativeLuminance(b));
    return (light + 0.05) / (dark + 0.05);
  }

  function parseAndRender() {
    if (!mounted) return;
    const note = document.querySelector("#pku-exam-note");
    try {
      exams = rawPayloadText ? mergeEdits(parsePortalPayload(rawPayloadText)) : [];
      if (note) {
        note.textContent = rawPayloadText
          ? "已从当前门户课表读取数据。地点未固定的考试会显示为地点待定，可在左侧补全。"
          : "尚未读取到课表数据。请刷新课表或切换学期/周次。";
      }
    } catch (error) {
      exams = [];
      if (note) note.textContent = `捕获到课表响应，但解析失败：${error.message}`;
    }
    render();
    renderCourseGrid();
  }

  function stripHtmlToLines(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "").replace(/<br\s*\/?>/gi, "\n");
    return template.content.textContent.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  function normalizeCourseName(name) {
    return String(name || "").replace(/\(主\)|（主）/g, "").replace(/\s+/g, " ").trim();
  }

  function parseTeacher(line) {
    const match = String(line || "").match(/教师[:：]\s*(.*)$/);
    if (!match) return "";
    return match[1].replace(/\s*备注[:：].*$/, "").replace(/\s+/g, " ").trim();
  }

  function dateFromRaw(raw) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  function weekdayFromDate(date) {
    if (!date) return "";
    const day = new Date(`${date}T00:00:00`);
    if (Number.isNaN(day.getTime())) return "";
    return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][day.getDay()];
  }

  function parseExamLine(line) {
    const text = String(line || "").replace(/^考试信息[:：]\s*/, "").trim();
    if (!text) return {};
    const match = text.match(/^(\d{8})\s+(星期[一二三四五六日天])\s+(上午|下午|晚上)(?:\s+(.+))?$/);
    if (!match) return {assessment: "期末考试", rawExamText: text};
    const [, rawDate, weekday, period, location = ""] = match;
    return {
      assessment: "期末考试",
      date: dateFromRaw(rawDate),
      weekday,
      period,
      time: PERIOD_TIME[period] || "",
      location: location.trim(),
      rawExamText: text
    };
  }

  function newExam(name = "") {
    const item = {
      id: "",
      enabled: true,
      name,
      teacher: "",
      assessment: "待补",
      date: "",
      weekday: "",
      period: "",
      time: "",
      location: "",
      rawExamText: ""
    };
    item.id = stableId(item);
    return item;
  }

  function stableId(item) {
    return [item.name || "", item.teacher || "", item.rawExamText || "", item.date || "", item.period || ""].join("|");
  }

  function parseCourseHtml(html) {
    const lines = stripHtmlToLines(html);
    const parsed = [];
    let current = null;
    for (const line of lines) {
      if (line.startsWith("上课信息")) {
        if (current) current.teacher = parseTeacher(line);
        continue;
      }
      if (line.startsWith("考试信息")) {
        if (!current) current = newExam("");
        Object.assign(current, parseExamLine(line));
        current.id = stableId(current);
        parsed.push(current);
        current = null;
        continue;
      }
      if (current && current.name && !current.date && !current.location) parsed.push(current);
      current = newExam(normalizeCourseName(line));
    }
    if (current && current.name) parsed.push(current);
    return parsed.filter((item) => item.name);
  }

  function collectCourseCells(value, cells = []) {
    if (!value) return cells;
    if (Array.isArray(value)) {
      value.forEach((item) => collectCourseCells(item, cells));
      return cells;
    }
    if (typeof value === "object") {
      if (typeof value.courseName === "string" && value.courseName.trim()) cells.push(value.courseName);
      Object.values(value).forEach((item) => collectCourseCells(item, cells));
    }
    return cells;
  }

  function parsePortalPayload(payloadText) {
    const payload = JSON.parse(payloadText);
    return dedupe(collectCourseCells(payload).flatMap(parseCourseHtml));
  }

  function renderCourseGrid() {
    const root = document.querySelector("#pku-course-grid-root");
    if (!root) return;
    if (!rawPayloadText) {
      document.body.classList.remove("pku-json-table-view");
      root.innerHTML = `<div class="pku-course-loading">尚未读取到课表数据。请刷新课表或切换学期。</div>`;
      return;
    }
    try {
      const payload = JSON.parse(rawPayloadText);
      const rows = Array.isArray(payload.course) ? payload.course : [];
      if (!rows.length) throw new Error("course 数组为空");
      document.body.classList.add("pku-json-table-view");
      root.innerHTML = `
        <section class="pku-json-table-panel">
          <header class="pku-json-table-head">
            <div>
              <h1>课程表</h1>
              <p>课程、考试安排与导出工具</p>
            </div>
          </header>
          <div class="pku-json-table-wrap">
            ${renderCourseGridTable(rows)}
          </div>
        </section>
      `;
      root.querySelectorAll(".pku-json-course-cell").forEach(applyJsonCourseCellTheme);
      requestAnimationFrame(decorateSparseCourseCells);
    } catch (error) {
      document.body.classList.remove("pku-json-table-view");
      root.innerHTML = `<div class="pku-course-loading">课表数据解析失败：${escapeHtml(error.message)}</div>`;
    }
  }

  function renderCourseGridTable(rows) {
    const days = [
      ["mon", "一"],
      ["tue", "二"],
      ["wed", "三"],
      ["thu", "四"],
      ["fri", "五"],
      ["sat", "六"],
      ["sun", "日"]
    ];
    const skip = new Set();
    const body = rows.map((row, rowIndex) => {
      const period = periodLabel(row.timeNum, rowIndex);
      const cells = days.map(([key]) => {
        const skipKey = `${rowIndex}:${key}`;
        if (skip.has(skipKey)) return "";
        const cell = row[key] || {};
        const html = String(cell.courseName || "").trim();
        if (!html) return `<td class="pku-json-empty"></td>`;
        const span = identicalSpan(rows, rowIndex, key, html, cell.sty || "", skip);
        const entries = parseCourseDisplayEntries(html);
        const bg = cssColorFromStyle(cell.sty || "");
        const conflict = /<font[^>]+red|color\s*=\s*['"]?red/i.test(html);
        return `
          <td rowspan="${span}" class="pku-json-course-cell ${conflict ? "is-course-conflict" : ""}" data-pku-deco-key="${escapeAttr(`${rowIndex}:${key}:${html}`)}" ${bg ? `data-pku-bg="${escapeAttr(bg)}" style="--pku-cell-bg:${escapeAttr(bg)}"` : ""}>
            <div class="pku-course-content">${entries.map(renderCourseDisplayEntry).join("")}</div>
          </td>
        `;
      }).join("");
      return `<tr><th class="pku-json-period">${escapeHtml(period)}</th>${cells}</tr>`;
    }).join("");
    return `
      <table class="pku-json-table">
        <thead><tr><th></th>${days.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function exportWakeupCsv() {
    if (!rawPayloadText) {
      window.alert("尚未读取到课表数据，请先刷新课表页面。");
      return;
    }
    try {
      const payload = JSON.parse(rawPayloadText);
      const rows = Array.isArray(payload.course) ? payload.course : [];
      const records = buildWakeupRecords(rows);
      if (!records.length) {
        window.alert("没有可导出的课程。");
        return;
      }
      const headers = ["课程名称", "星期", "开始节数", "结束节数", "老师", "地点", "周数"];
      const csv = [headers, ...records.map((record) => headers.map((header) => record[header] || "无"))]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n");
      const blob = new Blob([`\uFEFF${csv}`], {type: "text/csv;charset=utf-8"});
      downloadBlob(blob, `wakeup-course-${dateKey(new Date())}.csv`);
    } catch (error) {
      window.alert(`导出 CSV 失败：${error.message}`);
    }
  }

  function buildWakeupRecords(rows) {
    const days = [
      ["mon", "1"],
      ["tue", "2"],
      ["wed", "3"],
      ["thu", "4"],
      ["fri", "5"],
      ["sat", "6"],
      ["sun", "7"]
    ];
    const records = [];
    const skip = new Set();
    rows.forEach((row, rowIndex) => {
      days.forEach(([dayKey, weekday]) => {
        const key = `${rowIndex}:${dayKey}`;
        if (skip.has(key)) return;
        const cell = row[dayKey] || {};
        const html = String(cell.courseName || "").trim();
        if (!html) return;
        const span = identicalSpan(rows, rowIndex, dayKey, html, cell.sty || "", skip);
        parseCourseDisplayEntries(html).forEach((entry) => {
          const infos = entry.classInfos && entry.classInfos.length ? entry.classInfos : [entry.classInfo || {}];
          const mainInfo = infos[0] || {};
          records.push({
            "课程名称": entry.name || "无",
            "星期": weekday,
            "开始节数": String(rowIndex + 1),
            "结束节数": String(rowIndex + span),
            "老师": mainInfo.teacher || "无",
            "地点": mainInfo.room || "无",
            "周数": wakeupWeeks(infos) || "无"
          });
        });
      });
    });
    return records;
  }

  function wakeupWeeks(infos) {
    const parts = [];
    compactClassInfos(infos).forEach((info) => {
      const range = weekRange(info.weeks);
      const weeks = normalizeWakeupWeekRange(info.weeks);
      if (!weeks) return;
      const parity = range && range.start === range.end ? "" : info.parity === "单周" ? "单" : info.parity === "双周" ? "双" : "";
      parts.push(`${weeks}${parity}`);
    });
    return [...new Set(parts)].join("、");
  }

  function normalizeWakeupWeekRange(value) {
    const range = weekRange(value);
    if (range) return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
    const single = String(value || "").match(/(\d+)周/);
    return single ? single[1] : "";
  }

  function csvCell(value) {
    const text = String(value ?? "").replaceAll(",", "、");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function identicalSpan(rows, start, dayKey, html, style, skip) {
    let span = 1;
    for (let index = start + 1; index < rows.length; index += 1) {
      const next = rows[index] && rows[index][dayKey];
      if (!next || String(next.courseName || "").trim() !== html || String(next.sty || "") !== style) break;
      skip.add(`${index}:${dayKey}`);
      span += 1;
    }
    return span;
  }

  function periodLabel(value, index) {
    const match = String(value || "").match(/第(.+)节/);
    if (match) return chinesePeriodNumber(match[1]) || match[1];
    return String(index + 1);
  }

  function chinesePeriodNumber(value) {
    const map = {一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12};
    return map[value] ? String(map[value]) : "";
  }

  function cssColorFromStyle(style) {
    const match = String(style || "").match(/background-color\s*:\s*([^;]+)/i);
    if (!match) return "";
    const value = match[1].trim();
    if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("color", value)) return value;
    return "";
  }

  function applyJsonCourseCellTheme(cell) {
    const authored = cell.dataset.pkuBg || cell.style.getPropertyValue("--pku-cell-bg").trim();
    const originalBg = colorToRgb(authored) || parseColor(getComputedStyle(cell).backgroundColor);
    if (activeTheme() === "dark") {
      const palette = darkCoursePalette(originalBg, null);
      cell.style.setProperty("--pku-cell-bg", rgbCss(palette.bg));
      cell.style.setProperty("--pku-cell-fg", palette.fg);
      return;
    }
    if (authored) cell.style.setProperty("--pku-cell-bg", authored);
    cell.style.removeProperty("--pku-cell-fg");
  }

  function colorToRgb(value) {
    if (!value) return null;
    const probe = document.createElement("span");
    probe.style.color = value;
    if (!probe.style.color) return null;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const parsed = parseColor(getComputedStyle(probe).color);
    probe.remove();
    return parsed;
  }

  function decorateSparseCourseCells() {
    document.querySelectorAll(".pku-json-course-cell").forEach((cell) => {
      cell.querySelector(".pku-animal-doodle")?.remove();
      const content = cell.querySelector(".pku-course-content");
      if (!content) return;
      const cellHeight = cell.clientHeight;
      const contentHeight = Math.min(content.scrollHeight, cellHeight);
      if (!cellHeight || (cellHeight - contentHeight) / cellHeight <= 0.45) return;
      const doodle = document.createElement("div");
      doodle.className = "pku-animal-doodle";
      doodle.innerHTML = animalDoodle(cell.dataset.pkuDecoKey || cell.textContent || "");
      cell.appendChild(doodle);
    });
  }

  function animalDoodle(key) {
    const animals = [catDoodle, bunnyDoodle, bearDoodle, foxDoodle, whaleDoodle, birdDoodle];
    return animals[stableHash(key) % animals.length]();
  }

  function stableHash(value) {
    let hash = 2166136261;
    String(value || "").split("").forEach((char) => {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    });
    return hash >>> 0;
  }

  function catDoodle() {
    return '<svg viewBox="0 0 96 72"><path d="M26 28 18 14v23M70 28l8-14v23" /><path d="M22 36c0-17 52-17 52 0v12c0 18-52 18-52 0Z" /><path d="M38 43h.1M58 43h.1" /><path d="M45 51h6M48 48v7M33 53c-7 0-13 3-18 7M63 53c7 0 13 3 18 7" /></svg>';
  }

  function bunnyDoodle() {
    return '<svg viewBox="0 0 96 72"><path d="M35 27C26 10 26 4 33 3c7-1 10 9 12 23M55 26C59 8 64 1 70 4c7 4 1 17-8 28" /><path d="M24 42c0-17 48-18 50-1 3 24-50 25-50 1Z" /><path d="M39 43h.1M57 43h.1" /><path d="M46 51h5M48 49v5" /></svg>';
  }

  function bearDoodle() {
    return '<svg viewBox="0 0 96 72"><circle cx="27" cy="27" r="10" /><circle cx="69" cy="27" r="10" /><path d="M22 39c0-22 52-22 52 0v7c0 22-52 22-52 0Z" /><path d="M39 43h.1M57 43h.1" /><path d="M43 53c2 3 8 3 10 0" /></svg>';
  }

  function foxDoodle() {
    return '<svg viewBox="0 0 96 72"><path d="M22 25 15 10l24 11M74 25l7-15-24 11" /><path d="M20 31c8-14 48-14 56 0L61 59H35Z" /><path d="M39 39h.1M57 39h.1" /><path d="M44 49h8l-4 5Z" /></svg>';
  }

  function whaleDoodle() {
    return '<svg viewBox="0 0 96 72"><path d="M20 45c8-20 44-24 58-5 6 9-7 20-28 20-18 0-31-5-30-15Z" /><path d="M24 39c-7-7-10-14-4-18 7 5 12 9 15 17" /><path d="M35 39h.1" /><path d="M58 28c4-7 10-9 15-5M61 31c6-3 11-2 16 2" /></svg>';
  }

  function birdDoodle() {
    return '<svg viewBox="0 0 96 72"><path d="M24 46c6-20 38-24 48-4 8 16-15 25-32 18-11-5-19-7-16-14Z" /><path d="M58 37l18-8-6 17" /><path d="M39 42h.1" /><path d="M40 60v7M54 60v7" /></svg>';
  }

  function dedupe(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = [item.name, item.teacher || "", item.date || "missing", item.period || "", item.location || "", item.rawExamText || ""].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function readEdits() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_EDIT) || "{}");
    } catch {
      return {};
    }
  }

  function writeEdit(item) {
    const edits = readEdits();
    edits[item.id] = item;
    localStorage.setItem(STORAGE_EDIT, JSON.stringify(edits));
  }

  function mergeEdits(items) {
    const edits = readEdits();
    return items.map((item) => ({...item, ...(edits[item.id] || {})}));
  }

  function readyForTimeline(item) {
    if (!item.enabled || !item.name || !item.date || !item.time) return false;
    if ((item.assessment || "待补") === "待补") return false;
    return true;
  }

  function pending(item) {
    return !readyForTimeline(item);
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      const left = `${a.date || "9999-99-99"} ${PERIOD_ORDER[a.period] || 9} ${a.name}`;
      const right = `${b.date || "9999-99-99"} ${PERIOD_ORDER[b.period] || 9} ${b.name}`;
      return left.localeCompare(right, "zh-CN");
    });
  }

  function updateItem(id, patch) {
    exams = exams.map((item) => {
      if (item.id !== id) return item;
      const next = {...item, ...patch};
      if ("period" in patch) next.time = next.period ? (PERIOD_TIME[next.period] || next.time) : "";
      if ("assessment" in patch && next.assessment === "待补") {
        next.period = "";
        next.time = "";
      }
      if ("date" in patch) next.weekday = weekdayFromDate(next.date);
      writeEdit(next);
      return next;
    });
    render();
  }

  function render() {
    const total = exams.length;
    const readyCount = exams.filter(readyForTimeline).length;
    const missingCount = exams.filter((item) => item.enabled && pending(item)).length;
    setText("#pku-total", total);
    setText("#pku-ready", readyCount);
    setText("#pku-missing", missingCount);
    renderEditor();
    renderTimeline();
  }

  function renderEditor() {
    const list = document.querySelector("#pku-edit-list");
    if (!list) return;
    list.innerHTML = "";
    const sorted = sortItems(exams);
    appendSection(list, "已安排", sorted.filter((item) => !pending(item)), scheduledCollapsed, () => {
      scheduledCollapsed = !scheduledCollapsed;
      renderEditor();
    });
    appendSection(list, "待补课程", sorted.filter(pending), pendingCollapsed, () => {
      pendingCollapsed = !pendingCollapsed;
      renderEditor();
    });
  }

  function appendSection(parent, title, items, collapsed, onToggle) {
    const section = document.createElement("section");
    section.className = "pku-list-section";
    const head = document.createElement("div");
    head.className = "pku-section-head";
    head.innerHTML = `<strong>${escapeHtml(title)} · ${items.length}</strong>`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = collapsed ? "展开" : "折叠";
    toggle.addEventListener("click", onToggle);
    head.appendChild(toggle);
    section.appendChild(head);
    if (!collapsed) {
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "pku-empty";
        empty.textContent = title === "待补课程" ? "没有待补课程" : "暂无已安排课程";
        section.appendChild(empty);
      } else {
        items.forEach((item) => section.appendChild(renderEditorRow(item)));
      }
    }
    parent.appendChild(section);
  }

  function renderEditorRow(item) {
    const row = document.createElement("article");
    row.className = `pku-edit-row${pending(item) ? " is-pending" : ""}`;
    row.innerHTML = `
      <div class="pku-row-head">
        <input type="checkbox" ${item.enabled ? "checked" : ""}>
        <strong>${escapeHtml(item.name || "未命名课程")}</strong>
      </div>
      <label>课程名<input data-field="name" value="${escapeAttr(item.name)}"></label>
      <label>授课教师<input data-field="teacher" value="${escapeAttr(item.teacher)}"></label>
      <div class="pku-grid-2">
        <label>结课方式<select data-field="assessment">${ASSESSMENT_OPTIONS.map((value) => option(value, value, item.assessment || "待补")).join("")}</select></label>
        <label>日期<input data-field="date" type="date" value="${escapeAttr(item.date)}"></label>
        <label>时段<select data-field="period">${option("", "待补", item.period)}${option("上午", "上午", item.period)}${option("下午", "下午", item.period)}${option("晚上", "晚上", item.period)}</select></label>
        <label>时间<input data-field="time" value="${escapeAttr(item.time)}"></label>
      </div>
      <label>地点<input data-field="location" placeholder="地点待定" value="${escapeAttr(item.location)}"></label>
    `;
    row.querySelector("input[type='checkbox']").addEventListener("change", (event) => {
      updateItem(item.id, {enabled: event.target.checked});
    });
    row.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", (event) => updateItem(item.id, {[event.target.dataset.field]: event.target.value}));
    });
    return row;
  }

  function renderTimeline() {
    const timeline = document.querySelector("#pku-timeline");
    if (!timeline) return;
    const readyItems = sortItems(exams).filter(readyForTimeline);
    timeline.innerHTML = "";
    if (!readyItems.length) {
      timeline.innerHTML = `<div class="pku-empty">暂无完整期末安排</div>`;
      return;
    }
    const groups = new Map();
    readyItems.forEach((item) => {
      if (!groups.has(item.date)) groups.set(item.date, []);
      groups.get(item.date).push(item);
    });
    for (const [date, items] of groups) {
      const day = document.createElement("section");
      day.className = "pku-day";
      day.innerHTML = `<div class="pku-dot"></div><h2>${escapeHtml(date)}</h2>`;
      items.forEach((item) => day.appendChild(renderExamCard(item)));
      timeline.appendChild(day);
    }
  }

  function renderExamCard(item) {
    const status = examStatus(item);
    const card = document.createElement("article");
    card.className = `pku-exam-card ${status.className}`;
    const assessment = item.assessment && item.assessment !== "期末考试"
      ? `<div class="pku-exam-line"><span class="pku-line-icon">${icon("file")}</span><span class="pku-line-text">${escapeHtml(item.assessment)}</span></div>`
      : "";
    const location = item.location || "地点待定";
    card.innerHTML = `
      ${status.label ? `<em>${escapeHtml(status.label)}</em>` : ""}
      <div class="pku-exam-line"><span class="pku-line-icon">${icon("book")}</span><span class="pku-line-text">${escapeHtml(item.name)}</span></div>
      ${item.teacher ? `<div class="pku-exam-line"><span class="pku-line-icon">${icon("cap")}</span><span class="pku-line-text">${escapeHtml(item.teacher)}</span></div>` : ""}
      ${assessment}
      <div class="pku-exam-line"><span class="pku-line-icon">${icon("clock")}</span><span class="pku-line-text">${escapeHtml(item.time)}${item.weekday ? `(${escapeHtml(item.weekday)})` : ""}</span></div>
      <div class="pku-exam-line ${item.location ? "" : "is-missing"}"><span class="pku-line-icon">${icon("map")}</span><span class="pku-line-text">${escapeHtml(location)}</span></div>
    `;
    return card;
  }

  async function exportTimelineImage() {
    const readyItems = sortItems(exams).filter(readyForTimeline);
    if (!readyItems.length) {
      window.alert("暂无可导出的期末安排。");
      return;
    }
    try {
      const blob = await renderTimelinePng(readyItems);
      downloadBlob(blob, `pku-exam-timeline-${dateKey(new Date())}.png`);
    } catch (error) {
      window.alert(`导出失败：${error.message}`);
    }
  }

  function renderTimelinePng(items) {
    const groups = [];
    const byDate = new Map();
    items.forEach((item) => {
      if (!byDate.has(item.date)) byDate.set(item.date, []);
      byDate.get(item.date).push(item);
    });
    for (const [date, dateItems] of byDate) groups.push([date, dateItems]);

    const scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
    const width = 1080;
    const contentX = 184;
    const railX = 96;
    const cardX = contentX;
    const cardWidth = width - cardX - 72;
    const paddingTop = 64;
    const rowHeight = 36;
    const cardPaddingY = 24;
    const gapAfterDate = 18;
    const gapAfterCard = 16;
    const gapAfterDay = 28;

    const measuredCards = [];
    let height = paddingTop;
    groups.forEach(([date, dateItems]) => {
      height += 40 + gapAfterDate;
      dateItems.forEach((item) => {
        const lines = exportLines(item);
        const cardHeight = cardPaddingY * 2 + lines.length * rowHeight;
        measuredCards.push({date, item, lines, top: height, cardHeight});
        height += cardHeight + gapAfterCard;
      });
      height += gapAfterDay;
    });
    height += 48;

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = "#FBF4E8";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#FFFDF8";
    ctx.strokeStyle = "#E2CDAE";
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(railX, paddingTop + 14);
    ctx.lineTo(railX, height - 54);
    ctx.stroke();

    let cursor = paddingTop;
    groups.forEach(([date, dateItems]) => {
      drawCircle(ctx, railX, cursor + 14, 7, "#F7EBDD", "#E2CDAE");
      ctx.fillStyle = "#715F52";
      ctx.font = "400 32px 'Source Han Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";
      ctx.fillText(date, contentX, cursor + 28);
      cursor += 40 + gapAfterDate;
      dateItems.forEach((item) => {
        const lines = exportLines(item);
        const cardHeight = cardPaddingY * 2 + lines.length * rowHeight;
        const status = examStatus(item);
        ctx.fillStyle = status.className === "is-today" ? "#FFF2E8" : status.className === "is-tomorrow" ? "#FFF8E7" : "#FFFDF8";
        ctx.strokeStyle = status.className === "is-today" ? "#8C0000" : status.className === "is-tomorrow" ? "#7A5C2E" : "#E2CDAE";
        ctx.globalAlpha = status.className === "is-past" ? 0.48 : 1;
        ctx.fillRect(cardX, cursor, cardWidth, cardHeight);
        ctx.strokeRect(cardX, cursor, cardWidth, cardHeight);
        if (status.label) {
          ctx.fillStyle = "#F7EBDD";
          ctx.fillRect(cardX + cardWidth - 74, cursor + 14, 52, 24);
          ctx.fillStyle = "#715F52";
          ctx.font = "700 14px 'Source Han Sans SC', 'Microsoft YaHei', sans-serif";
          ctx.fillText(status.label, cardX + cardWidth - 64, cursor + 31);
        }
        lines.forEach((line, index) => {
          const y = cursor + cardPaddingY + index * rowHeight + 24;
          ctx.fillStyle = "#7A5C2E";
          ctx.font = "400 18px 'Source Han Sans SC', 'Microsoft YaHei', sans-serif";
          ctx.fillText(line.icon, cardX + 28, y - 1);
          ctx.fillStyle = line.missing ? "#7A5C2E" : "#2A1D17";
          ctx.font = "400 24px 'Source Han Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";
          ctx.fillText(line.text, cardX + 72, y);
        });
        ctx.globalAlpha = 1;
        cursor += cardHeight + gapAfterCard;
      });
      cursor += gapAfterDay;
    });

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas 导出失败"));
      }, "image/png");
    });
  }

  function exportLines(item) {
    const lines = [{icon: "□", text: item.name}];
    if (item.teacher) lines.push({icon: "△", text: item.teacher});
    if (item.assessment && item.assessment !== "期末考试") lines.push({icon: "文", text: item.assessment});
    lines.push({icon: "○", text: `${item.time}${item.weekday ? `(${item.weekday})` : ""}`});
    lines.push({icon: "◇", text: item.location || "地点待定", missing: !item.location});
    return lines;
  }

  function drawCircle(ctx, x, y, radius, fill, stroke) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function examEndDate(item) {
    const end = String(item.time || "").split("-")[1] || "23:59";
    const normalized = end.trim().replace("：", ":");
    const date = new Date(`${item.date}T${normalized.length === 5 ? normalized : "23:59"}:00`);
    return Number.isNaN(date.getTime()) ? new Date(`${item.date}T23:59:00`) : date;
  }

  function dateKey(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  function examStatus(item) {
    const now = new Date();
    const today = dateKey(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = dateKey(tomorrowDate);
    if (examEndDate(item) < now) return {className: "is-past", label: "已结束"};
    if (item.date === today) return {className: "is-today", label: "今日"};
    if (item.date === tomorrow) return {className: "is-tomorrow", label: "明日"};
    return {className: "", label: ""};
  }

  function setText(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.textContent = String(value);
  }

  function option(value, label, current) {
    return `<option value="${escapeAttr(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function icon(name) {
    const icons = {
      book: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"></path></svg>',
      cap: '<svg viewBox="0 0 24 24"><path d="m22 10-10-5-10 5 10 5 10-5Z"></path><path d="M6 12v5c3 2 9 2 12 0v-5"></path></svg>',
      clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
      map: '<svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
      file: '<svg viewBox="0 0 24 24"><path d="M14 2H6v20h12V8Z"></path><path d="M14 2v6h4"></path></svg>'
    };
    return icons[name] || "";
  }

  function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("\n", " ");
  }

  function css() {
    return `
      :root {
        --pku-bg: #FBF4E8;
        --pku-panel: #FFFDF8;
        --pku-ink: #2A1D17;
        --pku-muted: #715F52;
        --pku-line: #E2CDAE;
        --pku-soft: #F7EBDD;
        --pku-primary: #8C0000;
        --pku-accent: #7A5C2E;
        --pku-font: "Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "思源黑体", "Microsoft YaHei", sans-serif;
      }
      :root[data-pku-exam-theme="dark"] {
        --pku-bg: #18110D;
        --pku-panel: #241812;
        --pku-ink: #FFF0DF;
        --pku-muted: #D5BDA1;
        --pku-line: #57402F;
        --pku-soft: #2D2018;
        --pku-primary: #E85B5B;
        --pku-accent: #D2A65A;
      }
      :root[data-pku-exam-theme="dark"] body:not(.pku-exam-view) {
        background: var(--pku-bg) !important;
        color: var(--pku-ink) !important;
      }
      #pku-exam-toolbar {
        position: sticky;
        top: 0;
        left: 0;
        right: 0;
        width: 100%;
        min-height: 68px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 24px;
        border: 0;
        border-bottom: 1px solid var(--pku-line);
        background: #151922;
        color: #FFFDF8;
        font: 14px/1.4 var(--pku-font);
        box-sizing: border-box;
      }
      .pku-app-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }
      .pku-brand-mark {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border: 1px solid rgba(255, 253, 248, 0.78);
        color: #FFFDF8;
        font-weight: 800;
        font-size: 18px;
      }
      .pku-brand-text {
        display: grid;
        gap: 1px;
      }
      .pku-brand-text strong {
        color: #FFFDF8;
        font-size: 18px;
        letter-spacing: 0;
      }
      .pku-brand-text small {
        color: rgba(255, 253, 248, 0.62);
        font-size: 11px;
        letter-spacing: 0;
      }
      .pku-app-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .pku-view-switch,
      .pku-theme-switch {
        border: 1px solid rgba(255, 253, 248, 0.16);
        background: rgba(255, 253, 248, 0.08);
      }
      .pku-toolbar-command {
        border: 1px solid rgba(255, 253, 248, 0.16) !important;
        background: rgba(255, 253, 248, 0.08) !important;
      }
      .pku-toolbar-command:hover {
        background: rgba(255, 253, 248, 0.14) !important;
        color: #FFFDF8 !important;
      }
      .pku-view-switch {
        --view-thumb-x: 0px;
        position: relative;
        display: grid;
        grid-template-columns: 54px 84px;
        align-items: center;
        isolation: isolate;
      }
      .pku-view-switch[data-view="exam"] {
        --view-thumb-x: 54px;
      }
      #pku-exam-toolbar button {
        border: 0;
        min-height: 34px;
        padding: 0 12px;
        background: transparent;
        color: rgba(255, 253, 248, 0.72);
        cursor: pointer;
        font: 14px/1.4 var(--pku-font);
      }
      .pku-view-switch button {
        position: relative;
        z-index: 1;
        padding: 0;
      }
      .pku-view-switch button.is-active {
        color: #FFFDF8;
        font-weight: 700;
      }
      .pku-view-thumb {
        position: absolute;
        z-index: 0;
        top: 3px;
        left: 3px;
        width: 48px;
        height: 28px;
        background: #8C0000;
        transform: translateX(var(--view-thumb-x));
        transition: transform 180ms ease, background-color 180ms ease;
      }
      .pku-view-switch[data-view="exam"] .pku-view-thumb {
        width: 78px;
      }
      .pku-theme-switch {
        --thumb-x: 0px;
        position: relative;
        display: grid;
        grid-template-columns: repeat(3, 38px);
        isolation: isolate;
      }
      .pku-theme-switch[data-mode="light"] {
        --thumb-x: 38px;
      }
      .pku-theme-switch[data-mode="dark"] {
        --thumb-x: 76px;
      }
      .pku-theme-switch button {
        position: relative;
        z-index: 1;
        min-width: 38px;
        padding: 0;
        color: rgba(255, 253, 248, 0.68);
      }
      .pku-theme-switch button.is-active {
        color: #FFFDF8;
        font-weight: 700;
      }
      .pku-theme-thumb {
        position: absolute;
        z-index: 0;
        top: 3px;
        left: 3px;
        width: 32px;
        height: 28px;
        background: #8C0000;
        transform: translateX(var(--thumb-x));
        transition: transform 180ms ease, background-color 180ms ease;
      }
      .pku-portal-wide-content,
      .pku-portal-chrome-shell {
        display: none !important;
      }
      .pku-course-title-strip {
        display: none !important;
      }
      .pku-term-select {
        width: 340px !important;
        max-width: min(340px, 42vw) !important;
      }
      body.pku-json-table-view > *:not(#pku-exam-toolbar):not(#pku-course-grid-root):not(#pku-exam-panel) {
        display: none !important;
      }
      #pku-course-grid-root {
        min-height: calc(100vh - 68px);
        background: var(--pku-bg);
        color: var(--pku-ink);
        font: 14px/1.45 var(--pku-font);
        padding: 18px 22px 28px;
        box-sizing: border-box;
      }
      body.pku-exam-view #pku-course-grid-root {
        display: none !important;
      }
      .pku-course-loading {
        width: min(96vw, 1880px);
        margin: 24px auto;
        border: 1px solid var(--pku-line);
        background: var(--pku-panel);
        color: var(--pku-muted);
        padding: 22px;
      }
      .pku-json-table-panel {
        width: min(96vw, 1880px);
        margin: 0 auto;
      }
      .pku-json-table-head {
        display: flex;
        align-items: end;
        justify-content: space-between;
        margin-bottom: 14px;
      }
      .pku-json-table-head h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.2;
      }
      .pku-json-table-head p {
        margin: 4px 0 0;
        color: var(--pku-muted);
        font-size: 12px;
      }
      .pku-json-table-wrap {
        border: 1px solid var(--pku-line);
        background: var(--pku-panel);
        overflow: auto;
      }
      .pku-json-table {
        width: 100%;
        min-width: 980px;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .pku-json-table th,
      .pku-json-table td {
        border: 1px solid var(--pku-line);
        box-sizing: border-box;
      }
      .pku-json-table thead th {
        height: 40px;
        background: var(--pku-soft);
        color: var(--pku-muted);
        font-size: 16px;
        font-weight: 750;
      }
      .pku-json-table thead th:first-child,
      .pku-json-period {
        width: 48px;
        background: var(--pku-soft);
        color: var(--pku-muted);
        text-align: center;
        font-weight: 700;
      }
      .pku-json-table tbody tr {
        height: 82px;
      }
      .pku-json-empty {
        background: rgba(255, 253, 248, 0.52);
      }
      .pku-json-course-cell {
        position: relative;
        vertical-align: top;
        overflow: hidden;
        padding: 7px 9px;
        background: var(--pku-cell-bg, var(--pku-panel));
        color: var(--pku-cell-fg, var(--pku-ink));
      }
      .pku-json-course-cell.is-course-conflict {
        box-shadow: inset 4px 0 0 #A81919;
        background: #FFF2E8;
        color: #6E1D16;
      }
      .pku-json-course-cell > .pku-course-content {
        position: relative;
        z-index: 1;
      }
      .pku-animal-doodle {
        position: absolute;
        right: 10px;
        bottom: 8px;
        z-index: 0;
        width: min(42%, 92px);
        max-height: 48%;
        color: currentColor;
        opacity: 0.16;
        pointer-events: none;
      }
      .pku-animal-doodle svg {
        display: block;
        width: 100%;
        height: auto;
        max-height: 100%;
        fill: none;
        stroke: currentColor;
        stroke-width: 4.2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .pku-json-course-cell::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 14px;
        pointer-events: none;
        background: linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,253,248,0.42));
      }
      .pku-beautified-course-cell {
        font-family: var(--pku-font) !important;
        line-height: 1.55 !important;
        padding: 8px 10px !important;
        border-color: var(--pku-cell-border, var(--pku-line)) !important;
        background-color: var(--pku-cell-bg, inherit) !important;
        color: var(--pku-cell-fg, inherit) !important;
        vertical-align: top !important;
      }
      .pku-course-table .pku-beautified-course-cell.is-course-conflict {
        background: #FFF2E8 !important;
        color: #6E1D16 !important;
        box-shadow: inset 4px 0 0 #A81919 !important;
      }
      .pku-course-table .pku-beautified-course-cell.is-course-conflict * {
        color: inherit !important;
      }
      .pku-beautified-course-cell:hover {
        outline: 2px solid var(--pku-accent);
        outline-offset: -2px;
      }
      .pku-course-content {
        display: grid !important;
        gap: 4px !important;
        width: 100% !important;
        max-height: 100% !important;
        overflow: hidden !important;
      }
      .pku-beautified-course-cell > .cell {
        height: 100% !important;
        max-height: 100% !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
        padding: 0 !important;
      }
      .pku-course-entry {
        display: grid !important;
        gap: 2px !important;
        padding: 1px 0 5px !important;
        border-bottom: 1px solid rgba(113, 95, 82, 0.18) !important;
        min-width: 0 !important;
      }
      .pku-course-entry:last-child {
        border-bottom: 0 !important;
        padding-bottom: 1px !important;
      }
      .pku-course-name {
        display: block !important;
        font-weight: 750 !important;
        font-size: 1em !important;
        line-height: 1.22 !important;
        letter-spacing: 0 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      .pku-course-detail {
        display: grid !important;
        grid-template-columns: max-content minmax(0, 1fr) !important;
        gap: 2px !important;
        align-items: start !important;
        min-width: 0 !important;
        font-size: 0.88em !important;
        line-height: 1.24 !important;
      }
      .pku-course-detail b {
        color: var(--pku-muted) !important;
        font-weight: 700 !important;
        white-space: nowrap !important;
      }
      .pku-course-detail span {
        min-width: 0 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      .pku-course-detail i {
        color: var(--pku-muted) !important;
        font-style: normal !important;
        margin: 0 3px !important;
      }
      .pku-course-detail .is-odd-week,
      .pku-course-detail .is-even-week,
      .pku-course-detail .is-split-week {
        color: #8C0000 !important;
        font-weight: 700 !important;
      }
      .pku-course-wide-root,
      .pku-course-table-shell {
        box-sizing: border-box !important;
      }
      .pku-course-wide-root {
        width: min(96vw, 1880px) !important;
        max-width: min(96vw, 1880px) !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }
      .pku-course-table-shell {
        max-width: none !important;
        width: 100% !important;
        overflow-x: visible !important;
      }
      .pku-course-table-shell .el-table__header,
      .pku-course-table-shell .el-table__body,
      .pku-course-table-shell .el-table__footer {
        width: 100% !important;
        table-layout: fixed !important;
      }
      .pku-course-table-shell .el-table__header-wrapper,
      .pku-course-table-shell .el-table__body-wrapper {
        width: 100% !important;
        overflow-x: visible !important;
      }
      .pku-course-table {
        width: 100% !important;
        min-width: 0 !important;
        table-layout: fixed !important;
        border-collapse: collapse !important;
        background: var(--pku-panel) !important;
      }
      .pku-course-table th,
      .pku-course-table td {
        width: auto !important;
        border-color: var(--pku-line) !important;
      }
      .pku-course-table .pku-beautified-course-cell {
        position: relative !important;
        height: 100% !important;
        overflow: hidden !important;
        font-size: clamp(11px, 0.62vw, 13px) !important;
        line-height: 1.38 !important;
        padding: clamp(5px, 0.38vw, 8px) !important;
        word-break: break-word !important;
        overflow-wrap: anywhere !important;
      }
      .pku-course-table .pku-beautified-course-cell::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 12px;
        pointer-events: none;
        background: linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0.42));
      }
      .pku-week-head {
        font-family: var(--pku-font) !important;
        font-weight: 700 !important;
        color: var(--pku-muted) !important;
        background: var(--pku-soft) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-wide-root,
      :root[data-pku-exam-theme="dark"] .pku-course-table-shell,
      :root[data-pku-exam-theme="dark"] .pku-course-table,
      :root[data-pku-exam-theme="dark"] .pku-course-table th,
      :root[data-pku-exam-theme="dark"] .pku-course-table td {
        background-color: var(--pku-panel) !important;
        color: var(--pku-ink) !important;
        border-color: var(--pku-line) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell {
        background-color: var(--pku-cell-bg, var(--pku-panel)) !important;
        color: var(--pku-cell-fg, var(--pku-ink)) !important;
        border-color: var(--pku-cell-border, var(--pku-line)) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell::after {
        background: linear-gradient(to bottom, rgba(24,17,13,0), rgba(24,17,13,0.42));
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell.is-course-conflict {
        box-shadow: inset 4px 0 0 #FF7878 !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell .pku-course-name,
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell .pku-course-detail span {
        color: var(--pku-cell-fg, var(--pku-ink)) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-entry {
        border-bottom-color: rgba(213, 189, 161, 0.2) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell .pku-course-detail b,
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell .pku-course-detail i {
        color: #D5BDA1 !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-week-head {
        color: var(--pku-muted) !important;
        background: var(--pku-soft) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-json-table-wrap,
      :root[data-pku-exam-theme="dark"] .pku-json-table {
        background: var(--pku-panel);
      }
      :root[data-pku-exam-theme="dark"] .pku-json-table th,
      :root[data-pku-exam-theme="dark"] .pku-json-table td {
        border-color: var(--pku-line);
      }
      :root[data-pku-exam-theme="dark"] .pku-json-table thead th,
      :root[data-pku-exam-theme="dark"] .pku-json-period {
        background: var(--pku-soft);
        color: var(--pku-muted);
      }
      :root[data-pku-exam-theme="dark"] .pku-json-empty {
        background: rgba(255, 240, 223, 0.03);
      }
      :root[data-pku-exam-theme="dark"] .pku-json-course-cell {
        background: var(--pku-cell-bg, var(--pku-panel));
        color: var(--pku-cell-fg, var(--pku-ink));
      }
      :root[data-pku-exam-theme="dark"] .pku-animal-doodle {
        opacity: 0.2;
      }
      :root[data-pku-exam-theme="dark"] .pku-json-course-cell::after {
        background: linear-gradient(to bottom, rgba(24,17,13,0), rgba(24,17,13,0.42));
      }
      :root[data-pku-exam-theme="dark"] .pku-json-course-cell.is-course-conflict {
        box-shadow: inset 4px 0 0 #FF7878;
      }
      :root[data-pku-exam-theme="dark"] .pku-json-course-cell .pku-course-detail b,
      :root[data-pku-exam-theme="dark"] .pku-json-course-cell .pku-course-detail i {
        color: #D5BDA1 !important;
      }
      body.pku-exam-view > *:not(#pku-exam-toolbar):not(#pku-exam-panel) {
        display: none !important;
      }
      #pku-exam-panel {
        display: none;
        min-height: 100vh;
        background: var(--pku-bg);
        color: var(--pku-ink);
        font: 14px/1.45 var(--pku-font);
        grid-template-columns: minmax(340px, 430px) minmax(520px, 1fr);
      }
      body.pku-exam-view #pku-exam-panel {
        display: grid;
      }
      #pku-exam-panel,
      #pku-exam-panel * {
        box-sizing: border-box !important;
      }
      .pku-editor {
        background: var(--pku-panel);
        border-right: 1px solid var(--pku-line);
        padding: 22px;
        overflow: auto;
        max-height: 100vh;
      }
      .pku-panel-head,
      .pku-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .pku-row-head {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        gap: 10px;
        align-items: center;
        margin-bottom: 10px;
      }
      .pku-panel-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .pku-panel-head h1 {
        margin: 0;
        font-size: 22px;
      }
      #pku-exam-note {
        color: var(--pku-muted);
      }
      .pku-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin: 14px 0;
      }
      .pku-stats div,
      .pku-edit-row,
      .pku-empty,
      .pku-exam-card {
        border: 1px solid var(--pku-line);
        background: var(--pku-panel);
      }
      .pku-stats div {
        padding: 10px;
      }
      .pku-stats strong {
        display: block;
        font-size: 20px;
      }
      .pku-stats span,
      .pku-edit-row label,
      .pku-section-head {
        color: var(--pku-muted);
      }
      .pku-list-section {
        margin-top: 14px;
      }
      .pku-section-head button,
      .pku-panel-head button {
        border: 1px solid var(--pku-line);
        background: var(--pku-panel);
        color: var(--pku-ink);
        min-height: 30px;
        padding: 0 10px;
      }
      .pku-edit-row {
        padding: 11px;
        margin-top: 10px;
        overflow: hidden;
      }
      .pku-edit-row.is-pending {
        background: var(--pku-soft);
      }
      .pku-edit-row label {
        display: block;
        margin-top: 8px;
        font-size: 12px;
        min-width: 0;
      }
      .pku-edit-row input,
      .pku-edit-row select {
        display: block;
        width: 100%;
        max-width: 100%;
        min-height: 32px;
        border: 1px solid var(--pku-line);
        background: var(--pku-panel);
        color: var(--pku-ink);
        padding: 0 8px;
        font: 14px var(--pku-font);
      }
      .pku-row-head input[type="checkbox"] {
        width: 18px !important;
        height: 18px !important;
        min-height: 18px !important;
        margin: 0 !important;
        accent-color: var(--pku-accent);
      }
      .pku-row-head strong {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--pku-ink);
        font-size: 15px;
      }
      .pku-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .pku-preview {
        padding: 24px 32px;
        overflow: auto;
        max-height: 100vh;
      }
      .pku-timeline {
        --rail-x: 16px;
        --content-x: 50px;
        position: relative;
        max-width: 720px;
        margin: 0 auto;
        padding-left: var(--content-x);
      }
      .pku-timeline::before {
        content: "";
        position: absolute;
        left: var(--rail-x);
        top: 16px;
        bottom: 18px;
        width: 2px;
        background: var(--pku-line);
      }
      .pku-day {
        position: relative;
        margin-bottom: 22px;
      }
      .pku-dot {
        position: absolute;
        left: calc(var(--rail-x) - var(--content-x) - 5px);
        top: 7px;
        width: 11px;
        height: 11px;
        border-radius: 999px;
        border: 1px solid var(--pku-line);
        background: var(--pku-soft);
      }
      .pku-day h2 {
        margin: 0 0 10px;
        color: var(--pku-muted);
        font-size: 21px;
        font-weight: 400;
      }
      .pku-exam-card {
        position: relative;
        padding: 14px 74px 14px 18px;
        margin-bottom: 9px;
      }
      .pku-exam-card.is-today {
        border-color: var(--pku-primary);
        box-shadow: inset 4px 0 0 var(--pku-primary);
      }
      .pku-exam-card.is-tomorrow {
        border-color: var(--pku-accent);
        box-shadow: inset 4px 0 0 var(--pku-accent);
      }
      .pku-exam-card.is-past {
        opacity: 0.48;
      }
      .pku-exam-card em {
        position: absolute;
        right: 12px;
        top: 11px;
        font-style: normal;
        background: var(--pku-soft);
        color: var(--pku-muted);
        padding: 1px 6px;
        font-size: 12px;
      }
      .pku-exam-line {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        column-gap: 10px;
        align-items: center;
        min-height: 26px;
        font-size: 18px;
        line-height: 1.35;
        margin-bottom: 5px;
      }
      .pku-exam-line:last-child {
        margin-bottom: 0;
      }
      .pku-line-icon {
        width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
      }
      .pku-line-text {
        min-width: 0;
        display: block;
      }
      .pku-exam-line.is-missing {
        color: var(--pku-accent);
      }
      .pku-exam-card svg {
        width: 17px;
        height: 17px;
        display: block;
        stroke: var(--pku-accent);
        stroke-width: 1.8;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .pku-empty {
        padding: 22px 14px;
        color: var(--pku-muted);
      }
    `;
  }
})();
