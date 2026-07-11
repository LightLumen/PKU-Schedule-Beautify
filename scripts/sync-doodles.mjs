#!/usr/bin/env node

import {createHash} from "node:crypto";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const assetDir = join(repoRoot, "assets", "doodles-raster");
const userscriptPath = join(repoRoot, "pku-exam-timeline.user.js");
const previewPath = join(assetDir, "index.html");

const manifest = [
  ["sis", "bear-front.png"],
  ["sky", "deer.png"],
  ["gy", "robot.png"],
  ["sms", "chick.png"],
  ["xk", "lion-cheer.png"],
  ["hy", "hex-smile.png"],
  ["wy", "round-sign.png"],
  ["jy", "econ-deer.png"],
  ["dk", "earth-chick.png"],
  ["hk", "sprout-deer.png"],
  ["kg", "waving-otter.png"],
  ["art", "phoenix-chick.png"],
  ["zx", "round-owl.png"],
  ["zg", "politics-goat.png"],
  ["scio", "check-sheep.png"],
  ["sps", "sps-deer.png"],
  ["pre-medicine", "lab-cat.png"],
  ["nurse", "nurse-fox.png"],
  ["gsm", "hoodie-cow.png"],
  ["history", "scholar-cat.png"]
];

const MAX_EDGE = 320;
const MAX_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const mode = process.argv[2] || "--check";

if (!["--check", "--write"].includes(mode)) {
  console.error("用法：node scripts/sync-doodles.mjs [--check|--write]");
  process.exit(2);
}

function fail(message) {
  throw new Error(message);
}

function inspectPng(fileName, bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${fileName}: 不是有效的 PNG 文件`);
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") {
    fail(`${fileName}: 缺少 PNG IHDR 数据块`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  if (!width || !height || Math.max(width, height) > MAX_EDGE) {
    fail(`${fileName}: 尺寸为 ${width}x${height}，最长边必须不超过 ${MAX_EDGE}px`);
  }
  if (![4, 6].includes(colorType)) {
    fail(`${fileName}: PNG 必须带 Alpha 透明通道（当前 color type ${colorType}）`);
  }
  if (bytes.length > MAX_BYTES) {
    fail(`${fileName}: ${bytes.length} bytes，超过 ${MAX_BYTES} bytes 限制`);
  }
  return {width, height};
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAssets() {
  const hashes = new Map();
  return manifest.map(([name, fileName]) => {
    const filePath = join(assetDir, fileName);
    if (!existsSync(filePath)) fail(`${fileName}: 本地源图不存在（${filePath}）`);
    const bytes = readFileSync(filePath);
    const dimensions = inspectPng(fileName, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hashes.has(hash)) fail(`${fileName}: 与 ${hashes.get(hash)} 内容重复`);
    hashes.set(hash, fileName);
    return {name, fileName, bytes, dimensions, base64: bytes.toString("base64")};
  });
}

function generatedBlock(assets) {
  const entries = assets.map(({name, base64}) =>
    `    {name: ${JSON.stringify(name)}, src: "data:image/png;base64,${base64}"},`
  );
  return `  const DOODLE_IMAGES = [\n${entries.join("\n")}\n  ];`;
}

function embeddedAssets(source) {
  const blockStart = source.indexOf("  const DOODLE_IMAGES = [");
  const blockEnd = source.indexOf("\n  ];", blockStart);
  if (blockStart < 0 || blockEnd < 0) fail("userscript 中未找到 DOODLE_IMAGES 数据块");
  const block = source.slice(blockStart, blockEnd + 5);
  const entries = [];
  const pattern = /\{name:\s*"([^"]+)",\s*src:\s*"data:image\/png;base64,([^"]+)"\}/g;
  for (const match of block.matchAll(pattern)) entries.push({name: match[1], base64: match[2]});
  return {blockStart, blockEnd: blockEnd + 5, entries};
}

function verifyEmbedded(source, assets) {
  const {entries} = embeddedAssets(source);
  if (entries.length !== assets.length) {
    fail(`userscript 内嵌图片数量为 ${entries.length}，应为 ${assets.length}`);
  }
  entries.forEach((entry, index) => {
    const expected = assets[index];
    if (entry.name !== expected.name) {
      fail(`内嵌图片第 ${index + 1} 项标识为 ${entry.name}，应为 ${expected.name}`);
    }
    if (entry.base64 !== expected.base64) {
      fail(`${expected.fileName}: userscript 内嵌内容与本地源图不一致，请运行 --write`);
    }
  });
}

function verifyPreview(assets) {
  if (!existsSync(previewPath)) fail(`素材预览页不存在（${previewPath}）`);
  const preview = readFileSync(previewPath, "utf8");
  assets.forEach(({name, fileName}) => {
    const pattern = new RegExp(`<figure><img\\s+src="${escapeRegExp(fileName)}"[^>]*>\\s*<figcaption>${escapeRegExp(fileName)}\\s*·\\s*${escapeRegExp(name)}</figcaption></figure>`);
    if (!pattern.test(preview)) fail(`${fileName}: 预览页缺少正确的文件名与内部标识映射`);
  });
}

function syntaxCheck() {
  const result = spawnSync(process.execPath, ["--check", userscriptPath], {stdio: "inherit"});
  if (result.status !== 0) fail("userscript 语法检查失败");
}

try {
  const assets = readAssets();
  let source = readFileSync(userscriptPath, "utf8");
  if (mode === "--write") {
    const current = embeddedAssets(source);
    const next = generatedBlock(assets);
    const updated = `${source.slice(0, current.blockStart)}${next}${source.slice(current.blockEnd)}`;
    if (updated === source) {
      console.log("userscript 中的内嵌图片已经是最新版本，无需写入。");
    } else {
      source = updated;
      writeFileSync(userscriptPath, source, "utf8");
      console.log(`已将 ${assets.length} 张本地 PNG 嵌入 userscript。`);
    }
  }
  verifyEmbedded(source, assets);
  verifyPreview(assets);
  syntaxCheck();
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes.length, 0);
  console.log(`检查通过：${assets.length} 张透明 PNG，共 ${totalBytes} bytes；Base64、映射和语法一致。`);
} catch (error) {
  console.error(`图片同步失败：${error.message}`);
  process.exit(1);
}
