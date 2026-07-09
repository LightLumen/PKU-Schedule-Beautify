// ==UserScript==
// @name         PKU 课表美化与期末安排
// @namespace    local.pku.exam.timeline
// @version      0.1.2
// @description  美化北大门户课表，并基于 getCourseInfo.do 自动生成可编辑期末安排视图。
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
      <div class="pku-view-switch" role="group" aria-label="视图切换">
        <button type="button" data-view="table" class="is-active">课表</button>
        <button type="button" data-view="exam">期末安排</button>
      </div>
      <div id="pku-theme-switch" class="pku-theme-switch" role="group" aria-label="颜色模式">
        <span class="pku-theme-thumb" aria-hidden="true"></span>
        <button type="button" data-theme-mode="system" title="跟随显示屏">屏</button>
        <button type="button" data-theme-mode="light" title="浅色模式">浅</button>
        <button type="button" data-theme-mode="dark" title="深色模式">深</button>
      </div>
    `;
    document.body.appendChild(toolbar);

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
        <p id="pku-exam-note">打开或刷新课表后，脚本会自动读取 getCourseInfo.do。</p>
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

    toolbar.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });
    toolbar.querySelectorAll("[data-theme-mode]").forEach((button) => {
      button.addEventListener("click", () => applyTheme(button.dataset.themeMode));
    });
    panel.querySelector("#pku-refresh-from-table").addEventListener("click", parseAndRender);
    panel.querySelector("#pku-export-timeline").addEventListener("click", exportTimelineImage);
  }

  function setView(view) {
    document.body.classList.toggle("pku-exam-view", view === "exam");
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
          break;
        }
        parent = parent.parentElement;
      }
    });
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
    if (activeTheme() === "dark") {
      const palette = darkCoursePalette(originalBg, originalColor);
      const bg = palette.bg;
      const text = palette.fg;
      cell.style.setProperty("--pku-cell-bg", rgbCss(bg));
      cell.style.setProperty("--pku-cell-fg", text);
      cell.style.setProperty("--pku-cell-border", "rgba(213, 189, 161, 0.22)");
      return;
    }
    cell.style.removeProperty("--pku-cell-bg");
    cell.style.removeProperty("--pku-cell-fg");
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
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 2147483647;
        display: flex;
        gap: 8px;
        align-items: center;
        border: 0;
        background: transparent;
        font: 14px/1.4 var(--pku-font);
      }
      .pku-view-switch,
      .pku-theme-switch {
        border: 1px solid var(--pku-line);
        background: var(--pku-panel);
        box-shadow: 0 8px 24px rgba(42, 29, 23, 0.08);
      }
      :root[data-pku-exam-theme="dark"] .pku-view-switch,
      :root[data-pku-exam-theme="dark"] .pku-theme-switch {
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34);
      }
      .pku-view-switch {
        display: flex;
        align-items: center;
      }
      #pku-exam-toolbar button {
        border: 0;
        min-height: 34px;
        padding: 0 12px;
        background: transparent;
        color: var(--pku-ink);
        cursor: pointer;
        font: 14px/1.4 var(--pku-font);
      }
      .pku-view-switch button + button {
        border-left: 1px solid var(--pku-line) !important;
      }
      .pku-view-switch button.is-active {
        background: var(--pku-primary);
        color: #FFFDF8;
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
        color: var(--pku-muted);
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
        background: var(--pku-primary);
        transform: translateX(var(--thumb-x));
        transition: transform 180ms ease, background-color 180ms ease;
      }
      .pku-portal-wide-content {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        gap: 12px !important;
        width: min(96vw, 1880px) !important;
        max-width: min(96vw, 1880px) !important;
        margin-left: auto !important;
        margin-right: auto !important;
        text-align: left !important;
        box-sizing: border-box !important;
      }
      .pku-beautified-course-cell {
        font-family: var(--pku-font) !important;
        line-height: 1.55 !important;
        padding: 8px 10px !important;
        border-color: var(--pku-cell-border, var(--pku-line)) !important;
        vertical-align: top !important;
      }
      .pku-beautified-course-cell:hover {
        outline: 2px solid var(--pku-accent);
        outline-offset: -2px;
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
        font-size: clamp(12px, 0.72vw, 15px) !important;
        line-height: 1.38 !important;
        padding: clamp(5px, 0.45vw, 9px) !important;
        word-break: break-word !important;
        overflow-wrap: anywhere !important;
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
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-beautified-course-cell * {
        color: var(--pku-cell-fg, var(--pku-ink)) !important;
      }
      :root[data-pku-exam-theme="dark"] .pku-course-table .pku-week-head {
        color: var(--pku-muted) !important;
        background: var(--pku-soft) !important;
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
        padding: 34px 42px;
        overflow: auto;
        max-height: 100vh;
      }
      .pku-timeline {
        --rail-x: 22px;
        --content-x: 70px;
        position: relative;
        max-width: 860px;
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
        margin-bottom: 34px;
      }
      .pku-dot {
        position: absolute;
        left: calc(var(--rail-x) - var(--content-x) - 6px);
        top: 9px;
        width: 14px;
        height: 14px;
        border-radius: 999px;
        border: 1px solid var(--pku-line);
        background: var(--pku-soft);
      }
      .pku-day h2 {
        margin: 0 0 15px;
        color: var(--pku-muted);
        font-size: 28px;
        font-weight: 400;
      }
      .pku-exam-card {
        position: relative;
        padding: 20px 92px 20px 24px;
        margin-bottom: 12px;
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
        right: 16px;
        top: 14px;
        font-style: normal;
        background: var(--pku-soft);
        color: var(--pku-muted);
        padding: 2px 8px;
      }
      .pku-exam-line {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr);
        column-gap: 16px;
        align-items: center;
        min-height: 34px;
        font-size: 24px;
        line-height: 1.35;
        margin-bottom: 8px;
      }
      .pku-exam-line:last-child {
        margin-bottom: 0;
      }
      .pku-line-icon {
        width: 28px;
        height: 28px;
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
        width: 20px;
        height: 20px;
        display: block;
        stroke: var(--pku-accent);
        stroke-width: 1.9;
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
