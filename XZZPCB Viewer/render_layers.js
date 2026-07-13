/* render_layers.js - Canvas 2D PCB renderer
 *
 * Loads PCB data (SEGMENT / ARC / VIA / part DATA) from a user-selected
 * .json / .pcb file and renders it to a single <canvas>.
 *
 * Design: the parsers (raw_parser.js / part_data_parser.js) are untouched. We
 * build a retained "scene" once (fit-scale + Y-flip baked in, geometry compiled
 * into a few Path2D batches per layer), then redraw the whole scene under a
 * pan/zoom transform whenever something changes. No DOM node is created per
 * primitive, so the renderer scales to very large boards. Layer toggles, the
 * width slider, hover/selection and search are all just state changes followed
 * by a requestRender().
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SILKSCREEN_LAYER = 17;
const OUTLINE_LAYER = 28;
const PART_OUTLINES_LAYER = 29; // synthetic layer for part outlines
const PART_OUTLINE_COLOR = "#FF6B35";
const TARGET_SIZE = 1000; // normalized world box (matches the old SVG viewBox)
const BG_COLOR = "#001023";
const HIGHLIGHT_COLOR = "#ffe14d"; // selected net, traces on visible layers
const DATA_PIN_COLOR = "#39ff88"; // pins carrying additional data (diode/voltage/comment)
const HIGHLIGHT_ALT_COLOR = "#ff4dff"; // fallback if a layer colour can't be parsed
const HIGHLIGHT_ALT_DARKEN = 0.8; // hidden-layer net traces = their layer colour, darkened by this
const DIM_ALPHA = 0.25; // opacity of everything else while a net is selected
const DEFAULT_WIDTH_FACTOR = 0.4;
const PICK_PX = 6; // hover/click tolerance in CSS pixels
const VIA_TEXT_MIN_PX = 7; // hide via numbers below this on-screen radius
const PIN_TEXT_MIN_PX = 6; // hide pin diode labels below this on-screen radius
const ZOOM_SENSITIVITY = 0.0015; // wheel zoom feel (higher = more sensitive)

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let canvas, ctx;
let dpr = 1;
let scene = null;

// View transform: screen_css = world * k + t
const view = { k: 1, tx: 0, ty: 0, kFit: 1 };

// Render toggles / interaction state
let widthFactor = DEFAULT_WIDTH_FACTOR;
let showViaNumbers = true;
let showPins = true;
let highlightDataPins = false; // green-highlight pins that carry additional data
let hoverNet = null;
let selectedNet = null;
let hoverInfo = null;
let selectedInfo = null;
let searchPins = null; // array of pin refs highlighted by a name search
let browserCollapsed = false; // Parts/Nets panel collapsed state (persists across loads)

// Cached highlight geometry, keyed by the net it was built for
let highlightCache = { net: undefined, buckets: null };

let rafPending = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

// Darken a CSS colour (#RGB, #RRGGBB, or rgb()/rgba()) by a 0..1 factor.
function darken(color, factor) {
  const s = (color || "").trim();
  let r, g, b;
  if (s[0] === "#") {
    let hex = s.slice(1);
    if (hex.length === 3)
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16);
    if (hex.length !== 6 || Number.isNaN(n)) return HIGHLIGHT_ALT_COLOR;
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const mm = s.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!mm) return HIGHLIGHT_ALT_COLOR;
    r = +mm[1];
    g = +mm[2];
    b = +mm[3];
  }
  return `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`;
}

// Natural sort by leading component/net name (port of obdata.py natural_sort_key):
// split the first token into letter-prefix, number, remainder so R2 < R10.
function naturalKey(name) {
  const first = String(name).trim().split(/\s+/)[0] || "";
  const m = first.match(/^([A-Za-z]*)(\d*)(.*)$/);
  if (m) return [m[1].toUpperCase(), m[2] ? parseInt(m[2], 10) : 0, m[3]];
  return [first, 0, ""];
}
function naturalCompare(a, b) {
  const ka = naturalKey(a),
    kb = naturalKey(b);
  if (ka[0] < kb[0]) return -1;
  if (ka[0] > kb[0]) return 1;
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  if (ka[2] < kb[2]) return -1;
  if (ka[2] > kb[2]) return 1;
  return 0;
}

// Group {x1,y1,x2,y2,w} line records into Path2D batches keyed by width.
function compileLineBuckets(lines) {
  const byWidth = new Map();
  for (const l of lines) {
    const key = l.w.toFixed(3);
    let b = byWidth.get(key);
    if (!b) {
      b = { w: l.w, path: new Path2D() };
      byWidth.set(key, b);
    }
    b.path.moveTo(l.x1, l.y1);
    b.path.lineTo(l.x2, l.y2);
  }
  return [...byWidth.values()];
}

// Group arc records (each carries a prebuilt SVG "d" string) into Path2D
// batches keyed by width. Path2D parses SVG path data directly, which lets us
// reuse the exact arc geometry the old SVG renderer produced.
function compileArcBuckets(arcs) {
  const byWidth = new Map();
  for (const a of arcs) {
    const key = a.w.toFixed(3);
    let b = byWidth.get(key);
    if (!b) {
      b = { w: a.w, d: "" };
      byWidth.set(key, b);
    }
    b.d += a.d + " ";
  }
  const out = [];
  for (const b of byWidth.values()) out.push({ w: b.w, path: new Path2D(b.d) });
  return out;
}

// ---------------------------------------------------------------------------
// Scene builder - one pass over main_data_block
// ---------------------------------------------------------------------------
function buildScene(json) {
  const raw = json?.main_data_block || [];
  // Enrichment data from the obdata.py port (present only on the raw .pcb path;
  // absent for ImHex-JSON input, so every lookup below is guarded).
  const netIndexMap = json?.net_index_map || {};
  const obdata = json?.obdata || null;
  const segments = [];
  const arcs = [];
  const vias = [];
  const dataBlocks = [];
  for (const d of raw) {
    if (d.SEGMENT) segments.push(d.SEGMENT);
    else if (d.ARC) arcs.push(d.ARC);
    else if (d.VIA) vias.push(d.VIA);
    else if (d.DATA && d.DATA.parsed_data) dataBlocks.push(d.DATA.parsed_data);
  }
  if (!segments.length && !arcs.length && !vias.length && !dataBlocks.length) {
    return null;
  }

  // --- Bounds (segments, arcs +/- r, vias +/- outer_radius) ---
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of segments) {
    if (s.x1 < minX) minX = s.x1;
    if (s.x2 < minX) minX = s.x2;
    if (s.y1 < minY) minY = s.y1;
    if (s.y2 < minY) minY = s.y2;
    if (s.x1 > maxX) maxX = s.x1;
    if (s.x2 > maxX) maxX = s.x2;
    if (s.y1 > maxY) maxY = s.y1;
    if (s.y2 > maxY) maxY = s.y2;
  }
  for (const a of arcs) {
    if (a.x1 - a.r < minX) minX = a.x1 - a.r;
    if (a.y1 - a.r < minY) minY = a.y1 - a.r;
    if (a.x1 + a.r > maxX) maxX = a.x1 + a.r;
    if (a.y1 + a.r > maxY) maxY = a.y1 + a.r;
  }
  for (const v of vias) {
    if (v.x - v.outer_radius < minX) minX = v.x - v.outer_radius;
    if (v.y - v.outer_radius < minY) minY = v.y - v.outer_radius;
    if (v.x + v.outer_radius > maxX) maxX = v.x + v.outer_radius;
    if (v.y + v.outer_radius > maxY) maxY = v.y + v.outer_radius;
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }

  const rawWidth = maxX - minX || 1;
  const rawHeight = maxY - minY || 1;
  let scale, normWidth, normHeight;
  if (rawWidth >= rawHeight) {
    scale = TARGET_SIZE / rawWidth;
    normWidth = TARGET_SIZE;
    normHeight = rawHeight * scale;
  } else {
    scale = TARGET_SIZE / rawHeight;
    normHeight = TARGET_SIZE;
    normWidth = rawWidth * scale;
  }
  // World-space mappers (fit-scale + Y flip baked in once).
  const mapX = (x) => (x - minX) * scale;
  const mapY = (y) => (maxY - y) * scale;
  const widthToBase = (w) => Math.max((w || 20000) * scale, 1);

  // --- Layer set and colours (mirrors the old renderer) ---
  const layerOrder = [
    ...new Set([
      ...segments.map((o) => o.layer),
      ...arcs.map((o) => o.layer),
      ...vias.flatMap((v) => [v.layer_a_index, v.layer_b_index]),
      PART_OUTLINES_LAYER,
    ]),
  ].sort((a, b) => a - b);

  const style = getComputedStyle(document.documentElement);
  const SILKSCREEN_COLOR =
    style.getPropertyValue("--silkscreen").trim() || "#f2eda1";
  const OUTLINE_COLOR = style.getPropertyValue("--outline").trim() || "#d0d2cd";
  const paletteColor = (index) =>
    style.getPropertyValue(`--layer-${index % 13}`).trim() || "#888";

  const populatedLayers = [
    ...new Set([...segments.map((s) => s.layer), ...arcs.map((a) => a.layer)]),
  ]
    .filter((l) => l !== OUTLINE_LAYER && l !== SILKSCREEN_LAYER && l <= 16)
    .sort((a, b) => a - b);
  const displayMap = {};
  populatedLayers.forEach((l, i) => (displayMap[l] = i + 1));

  const defaultVisible = new Set([
    populatedLayers[0] ?? 1,
    populatedLayers[populatedLayers.length - 1] ?? 16,
    OUTLINE_LAYER,
    SILKSCREEN_LAYER,
    PART_OUTLINES_LAYER,
  ]);

  const layers = {};
  layerOrder.forEach((layer, idx) => {
    const color =
      layer === OUTLINE_LAYER
        ? OUTLINE_COLOR
        : layer === SILKSCREEN_LAYER
          ? SILKSCREEN_COLOR
          : layer === PART_OUTLINES_LAYER
            ? PART_OUTLINE_COLOR
            : paletteColor(idx);
    layers[layer] = {
      layer,
      color,
      darkColor: darken(color, HIGHLIGHT_ALT_DARKEN),
      visible: defaultVisible.has(layer),
      lines: [],
      arcs: [],
    };
  });

  // --- Segments ---
  const flatSegments = []; // for picking + net highlight
  const netMap = new Map(); // net -> { segs:[], vias:[], pins:[] }
  const netEntry = (net) => {
    let e = netMap.get(net);
    if (!e) {
      e = { segs: [], vias: [], pins: [] };
      netMap.set(net, e);
    }
    return e;
  };

  for (const s of segments) {
    const rec = {
      x1: mapX(s.x1),
      y1: mapY(s.y1),
      x2: mapX(s.x2),
      y2: mapY(s.y2),
      w: widthToBase(s.scale),
      net: s.trace_net_index,
      layer: s.layer,
    };
    layers[s.layer].lines.push(rec);
    flatSegments.push(rec);
    if (rec.net != null && rec.net > 0) netEntry(rec.net).segs.push(rec);
  }

  // --- Arcs (precompute SVG "d" so Path2D reproduces the old geometry) ---
  const degToRad = (d) => (d / 10000) * (Math.PI / 180);
  for (const a of arcs) {
    const rScaled = a.r * scale;
    const startRad = degToRad(a.angle_start);
    const endRad = degToRad(a.angle_end);
    const startX = mapX(a.x1 + a.r * Math.cos(startRad));
    const startY = mapY(a.y1 + a.r * Math.sin(startRad));
    const endX = mapX(a.x1 + a.r * Math.cos(endRad));
    const endY = mapY(a.y1 + a.r * Math.sin(endRad));
    let delta = (endRad - startRad) % (2 * Math.PI);
    if (delta < 0) delta += 2 * Math.PI;
    const largeArcFlag = delta > Math.PI ? 1 : 0;
    const sweepFlag = delta > 0 ? 0 : 1; // inverted for the flipped Y axis
    const d = `M ${startX} ${startY} A ${rScaled} ${rScaled} 0 ${largeArcFlag} ${sweepFlag} ${endX} ${endY}`;
    layers[a.layer].arcs.push({ w: widthToBase(a.scale), d });
  }

  // --- Part DATA: sub_type_05 (outline lines) + sub_type_09 (pins) ---
  const pins = [];
  const pinPath = new Path2D();
  const pinsByPart = new Map(); // refdes -> [pin] (for the browser "zoom to part")
  for (const part of dataBlocks) {
    if (!part.sub_blocks) continue;
    // The reference designator (U3, R21) is the first sub_type_06 label; the
    // header's part_group_name is really the pad/package descriptor. `odRef` is
    // the exact key obdata.parts is built under (no fallback, matching
    // ObdataParser.buildParts); `refName` adds a display fallback for the rare
    // label-less part.
    const groupName = part.header ? part.header.part_group_name : "";
    const odRef =
      typeof ObdataParser !== "undefined" ? ObdataParser.partRefName(part) : "";
    const refName = odRef || groupName;
    const odPart = obdata && obdata.parts ? obdata.parts[odRef] : null;
    for (const sb of part.sub_blocks) {
      if (sb.type === "sub_type_05") {
        const w = Math.max((sb.scale || 20000) * scale * 0.3, 0.5);
        layers[PART_OUTLINES_LAYER].lines.push({
          x1: mapX(sb.x1),
          y1: mapY(sb.y1),
          x2: mapX(sb.x2),
          y2: mapY(sb.y2),
          w,
          net: null,
          layer: PART_OUTLINES_LAYER,
        });
      } else if (sb.type === "sub_type_09") {
        const wRaw = sb.width || 10000;
        const hRaw = sb.height || 10000;
        const r = Math.max(
          Math.min((Math.min(wRaw, hRaw) / 2) * scale, 20),
          0.1,
        );
        const cx = mapX(sb.x);
        const cy = mapY(sb.y);
        // net / diode reading live in the pin's sub_parts (pin_sub_type_00)
        let net = null,
          diode = "";
        if (Array.isArray(sb.sub_parts)) {
          const n = sb.sub_parts.find((p) => p.type === "pin_sub_type_00");
          if (n) {
            net = n.net_index;
            diode = n.diode_reading || "";
          }
        }
        // Overlay the merged obdata reading/voltage where available.
        const pinName = sb.pin_name || "";
        const od = odPart && odPart.pins ? odPart.pins[pinName] : null;
        let voltage = "";
        if (od) {
          if (od.diode_reading != null && od.diode_reading !== "")
            diode = od.diode_reading;
          if (od.voltage != null) voltage = od.voltage;
        }
        const netName = netIndexMap[net];
        const comment =
          obdata && obdata.signal_descriptions
            ? obdata.signal_descriptions[netName]
            : undefined;
        const pin = {
          cx,
          cy,
          r,
          net,
          netName: netName || "",
          pinName,
          partName: refName,
          package: groupName && groupName !== refName ? groupName : "",
          diode,
          voltage,
          comment: comment || "",
        };
        pins.push(pin);
        pinPath.moveTo(cx + r, cy);
        pinPath.arc(cx, cy, r, 0, Math.PI * 2);
        if (net != null && net > 0) netEntry(net).pins.push(pin);
        let pl = pinsByPart.get(refName);
        if (!pl) {
          pl = [];
          pinsByPart.set(refName, pl);
        }
        pl.push(pin);
      }
    }
  }

  // --- Vias ---
  const viaList = [];
  for (const v of vias) {
    const cx = mapX(v.x);
    const cy = mapY(v.y);
    const via = {
      cx,
      cy,
      rOuter: v.outer_radius * scale,
      rInner: v.inner_radius * scale,
      colorA: layers[v.layer_a_index] ? layers[v.layer_a_index].color : "#888",
      colorB: layers[v.layer_b_index] ? layers[v.layer_b_index].color : "#888",
      labelA: String(displayMap[v.layer_a_index] ?? v.layer_a_index),
      labelB: String(displayMap[v.layer_b_index] ?? v.layer_b_index),
      startL: Math.min(v.layer_a_index, v.layer_b_index),
      endL: Math.max(v.layer_a_index, v.layer_b_index),
      net: v.net_index,
      netName: netIndexMap[v.net_index] || "",
      text: v.via_text || "",
      visible: true,
    };
    viaList.push(via);
    if (via.net != null && via.net > 0) netEntry(via.net).vias.push(via);
  }

  // --- Net-level diode aggregation ---
  // A diode reading characterises a whole net (electrical node), so a net's
  // single agreed reading propagates to every pin/trace on it. If a net's pins
  // carry *different* readings, that's a conflict - keep each pin's own reading
  // only. Net 0 / unconnected pins are already excluded from netMap, so a board
  // of independent readings on one "net" never falsely propagates.
  for (const entry of netMap.values()) {
    const distinct = new Set();
    for (const p of entry.pins) if (p.diode) distinct.add(p.diode);
    if (distinct.size === 1) entry.diode = [...distinct][0];
    else if (distinct.size > 1) entry.diodeConflict = true;
  }

  // --- Effective per-pin reading + "additional data" highlight path ---
  const dataPinPath = new Path2D();
  for (const p of pins) {
    const entry = p.net != null && p.net > 0 ? netMap.get(p.net) : null;
    if (p.diode) {
      p.effectiveDiode = p.diode; // own measured reading
    } else if (entry && entry.diode && !entry.diodeConflict) {
      p.effectiveDiode = entry.diode; // inherited from the net
      p.diodeFromNet = true;
    }
    p.hasData = !!(
      p.effectiveDiode ||
      p.voltage ||
      p.comment ||
      (obdata && obdata.net_aliases && obdata.net_aliases[p.netName])
    );
    if (p.hasData) {
      dataPinPath.moveTo(p.cx + p.r, p.cy);
      dataPinPath.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
    }
  }

  // --- Compile per-layer geometry into Path2D batches ---
  for (const layer of layerOrder) {
    const L = layers[layer];
    L.segPaths = compileLineBuckets(L.lines);
    L.arcPaths = compileArcBuckets(L.arcs);
  }

  // --- Browser lists (Parts / Nets) ---
  const netAliases = (obdata && obdata.net_aliases) || {};
  const signalDescs = (obdata && obdata.signal_descriptions) || {};
  const netsList = [];
  for (const idxStr of Object.keys(netIndexMap)) {
    const index = Number(idxStr);
    if (index === 0) continue; // UNCONNECTED
    const name = netIndexMap[idxStr];
    netsList.push({
      index,
      name,
      alias: netAliases[name],
      comment: signalDescs[name],
    });
  }
  netsList.sort((a, b) => naturalCompare(a.name || "", b.name || ""));

  const partsList = [];
  if (obdata && obdata.parts) {
    for (const ref of Object.keys(obdata.parts)) {
      if (ref === "") continue;
      const p = obdata.parts[ref];
      partsList.push({
        refName: ref,
        alias: p.alias,
        pkg: p.pad_desc,
        pins: Object.keys(p.pins || {}).map((pn) => ({
          pinName: pn,
          net_index: p.pins[pn].net_index,
          net_name: p.pins[pn].net_name,
          diode_reading: p.pins[pn].diode_reading,
          voltage: p.pins[pn].voltage,
        })),
      });
    }
  } else {
    // Fallback (e.g. ImHex-JSON input): group the rendered pins by refdes.
    const byRef = new Map();
    for (const pin of pins) {
      if (!pin.partName) continue;
      let e = byRef.get(pin.partName);
      if (!e) {
        e = { refName: pin.partName, pins: [] };
        byRef.set(pin.partName, e);
      }
      e.pins.push({
        pinName: pin.pinName,
        net_index: pin.net,
        net_name: pin.netName,
        diode_reading: pin.diode,
        voltage: pin.voltage,
      });
    }
    partsList.push(...byRef.values());
  }
  partsList.sort((a, b) => naturalCompare(a.refName || "", b.refName || ""));

  const s = {
    layerOrder,
    layers,
    vias: viaList,
    pins,
    pinPath,
    dataPinPath,
    segments: flatSegments,
    netMap,
    netIndexMap,
    obdata,
    partsList,
    netsList,
    pinsByPart,
    displayMap,
    bounds: { minX, minY, maxX, maxY, normWidth, normHeight },
    scale,
  };
  buildSpatialIndex(s);
  updateViaVisibility(s);
  return s;
}

// ---------------------------------------------------------------------------
// Spatial index (uniform grid) for hover/click picking
// ---------------------------------------------------------------------------
function buildSpatialIndex(s) {
  const { normWidth, normHeight } = s.bounds;
  const cell = Math.max(normWidth, normHeight) / 200 || 1; // ~200 cells across
  const cols = Math.max(1, Math.ceil(normWidth / cell) + 1);
  const grid = new Map();
  const key = (cx, cy) => cy * cols + cx;
  const cellOf = (x, y) => [Math.floor(x / cell), Math.floor(y / cell)];
  const insert = (cx, cy, item) => {
    const k = key(cx, cy);
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    arr.push(item);
  };

  for (const p of s.pins) {
    const [cx, cy] = cellOf(p.cx, p.cy);
    insert(cx, cy, { kind: "pin", ref: p });
  }
  for (const v of s.vias) {
    const [cx, cy] = cellOf(v.cx, v.cy);
    insert(cx, cy, { kind: "via", ref: v });
  }
  for (const seg of s.segments) {
    // insert into every cell the segment's bounding box overlaps
    const [c0x, c0y] = cellOf(
      Math.min(seg.x1, seg.x2),
      Math.min(seg.y1, seg.y2),
    );
    const [c1x, c1y] = cellOf(
      Math.max(seg.x1, seg.x2),
      Math.max(seg.y1, seg.y2),
    );
    for (let gy = c0y; gy <= c1y; gy++) {
      for (let gx = c0x; gx <= c1x; gx++)
        insert(gx, gy, { kind: "seg", ref: seg });
    }
  }
  s.grid = { grid, cell, cols, key, cellOf };
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx,
    cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Return the nearest primitive within `tol` world units of (wx, wy).
function pick(wx, wy, tol) {
  if (!scene || !scene.grid) return null;
  const { grid, cell, key, cellOf } = scene.grid;
  const [gx, gy] = cellOf(wx, wy);
  const span = Math.ceil(tol / cell) + 1;
  let best = null,
    bestD = Infinity;
  const consider = (d, hit) => {
    if (d < bestD) {
      bestD = d;
      best = hit;
    }
  };
  for (let y = gy - span; y <= gy + span; y++) {
    for (let x = gx - span; x <= gx + span; x++) {
      const arr = grid.get(key(x, y));
      if (!arr) continue;
      for (const item of arr) {
        const r = item.ref;
        if (item.kind === "pin") {
          // only pick what is currently drawn (normal pins, or green data pins)
          if (!showPins && !(highlightDataPins && r.hasData)) continue;
          const d = Math.hypot(wx - r.cx, wy - r.cy) - r.r;
          if (d <= tol) consider(d - 1e6, { type: "pin", ref: r }); // pins win ties
        } else if (item.kind === "via") {
          if (!r.visible) continue;
          const d = Math.hypot(wx - r.cx, wy - r.cy) - r.rOuter;
          if (d <= tol) consider(d - 1e6, { type: "via", ref: r });
        } else {
          const L = scene.layers[r.layer];
          if (!L || !L.visible) continue;
          const d = distToSegment(wx, wy, r.x1, r.y1, r.x2, r.y2) - r.w / 2;
          if (d <= tol) consider(d, { type: "seg", ref: r });
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Via visibility (a via shows if any layer in its span is visible)
// ---------------------------------------------------------------------------
function updateViaVisibility(s = scene) {
  if (!s) return;
  const visible = [];
  for (const layer of s.layerOrder)
    if (s.layers[layer].visible) visible.push(layer);
  for (const via of s.vias) {
    via.visible = visible.some((L) => L >= via.startL && L <= via.endL);
  }
}

// ---------------------------------------------------------------------------
// Canvas sizing / view transform
// ---------------------------------------------------------------------------
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function fitToBounds() {
  if (!scene) return;
  const { normWidth, normHeight } = scene.bounds;
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  const k = Math.min(cw / normWidth, ch / normHeight) * 0.95;
  view.k = k;
  view.kFit = k;
  view.tx = (cw - normWidth * k) / 2;
  view.ty = (ch - normHeight * k) / 2;
}

const worldToCssX = (wx) => wx * view.k + view.tx;
const worldToCssY = (wy) => wy * view.k + view.ty;
const cssToWorldX = (cx) => (cx - view.tx) / view.k;
const cssToWorldY = (cy) => (cy - view.ty) / view.k;

// ---------------------------------------------------------------------------
// Highlight geometry (rebuilt only when the highlighted net changes)
// ---------------------------------------------------------------------------
function getHighlightBuckets(net) {
  if (highlightCache.net === net) return highlightCache.buckets;
  let buckets = null;
  const entry = net != null ? scene.netMap.get(net) : null;
  if (entry && entry.segs.length) {
    // Bucket by layer + width so the render pass can colour each bucket by its
    // layer's current visibility. Paths don't change when layers toggle, so
    // caching by net alone stays valid.
    const byKey = new Map();
    for (const s of entry.segs) {
      const key = s.layer + "|" + s.w.toFixed(3);
      let b = byKey.get(key);
      if (!b) {
        b = { layer: s.layer, w: s.w, path: new Path2D() };
        byKey.set(key, b);
      }
      b.path.moveTo(s.x1, s.y1);
      b.path.lineTo(s.x2, s.y2);
    }
    buckets = [...byKey.values()];
  }
  highlightCache = { net, buckets };
  return buckets;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  if (!scene) return;
  resizeCanvas();
  const m = view.k * dpr; // device px per world unit

  // Background
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // World space (device pixels)
  ctx.setTransform(m, 0, 0, m, view.tx * dpr, view.ty * dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const minLineWorld = 0.6 / m; // keep thin traces visible at any zoom

  // When a net is selected (or a name search is active) dim everything else so
  // the highlighted net stands out. The highlight pass below restores full alpha.
  const focusActive = selectedNet != null || (searchPins && searchPins.length > 0);
  ctx.globalAlpha = focusActive ? DIM_ALPHA : 1;

  // Layers, in z-order
  for (const layer of scene.layerOrder) {
    const L = scene.layers[layer];
    if (!L.visible) continue;
    ctx.strokeStyle = L.color;
    for (const b of L.segPaths) {
      ctx.lineWidth = Math.max(b.w * widthFactor, minLineWorld);
      ctx.stroke(b.path);
    }
    for (const b of L.arcPaths) {
      ctx.lineWidth = Math.max(b.w * widthFactor, minLineWorld);
      ctx.stroke(b.path);
    }
  }

  // Vias (outer translucent disc + two colour halves)
  for (const v of scene.vias) {
    if (!v.visible) continue;
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.rOuter, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fill();
    // left half = layer A colour, right half = layer B colour
    ctx.beginPath();
    ctx.moveTo(v.cx, v.cy);
    ctx.arc(v.cx, v.cy, v.rInner, -Math.PI / 2, Math.PI / 2, true);
    ctx.closePath();
    ctx.fillStyle = v.colorA;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(v.cx, v.cy);
    ctx.arc(v.cx, v.cy, v.rInner, -Math.PI / 2, Math.PI / 2, false);
    ctx.closePath();
    ctx.fillStyle = v.colorB;
    ctx.fill();
  }

  // Pins (single batched fill)
  if (showPins) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fill(scene.pinPath);
  }

  // Green-highlight pins carrying additional data. Drawn even when pin rendering
  // is off, so the toggle can isolate just the data pins.
  if (highlightDataPins && scene.dataPinPath) {
    ctx.fillStyle = DATA_PIN_COLOR;
    ctx.fill(scene.dataPinPath);
  }

  // Highlight, search rings and via numbers draw at full strength.
  ctx.globalAlpha = 1;

  // Highlight: selection takes priority over hover
  const net = selectedNet != null ? selectedNet : hoverNet;
  if (net != null) {
    const buckets = getHighlightBuckets(net);
    if (buckets) {
      for (const b of buckets) {
        const L = scene.layers[b.layer];
        // Visible-layer traces use the bright highlight; traces on hidden layers
        // render in a darkened version of their own layer colour, so you can tell
        // which layer each cross-layer segment is routed on.
        ctx.strokeStyle = L
          ? L.visible
            ? HIGHLIGHT_COLOR
            : L.darkColor
          : HIGHLIGHT_ALT_COLOR;
        ctx.lineWidth = b.w * widthFactor + 2 / m; // +2 device px so it pops
        ctx.stroke(b.path);
      }
    }
    const entry = scene.netMap.get(net);
    if (entry) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 1.5 / m;
      for (const v of entry.vias) {
        ctx.beginPath();
        ctx.arc(v.cx, v.cy, v.rOuter + 1.5 / m, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const p of entry.pins) {
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, p.r + 1.5 / m, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Search-by-name pin rings
  if (searchPins && searchPins.length) {
    ctx.strokeStyle = HIGHLIGHT_COLOR;
    ctx.lineWidth = 1.5 / m;
    for (const p of searchPins) {
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r + 2 / m, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Via numbers, drawn crisp in CSS-pixel space (with a zoom LOD)
  if (showViaNumbers) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const v of scene.vias) {
      if (!v.visible) continue;
      const rPx = v.rInner * view.k;
      if (rPx < VIA_TEXT_MIN_PX) continue;
      const cx = worldToCssX(v.cx);
      const cy = worldToCssY(v.cy);
      ctx.font = `${(rPx * 0.6).toFixed(1)}px sans-serif`;
      ctx.fillText(v.labelA, cx - rPx / 2, cy);
      ctx.fillText(v.labelB, cx + rPx / 2, cy);
    }
  }

  // Pin diode readings, drawn as text once zoomed in enough (CSS-pixel space,
  // like via numbers). Shows the effective reading - a pin's own value or the
  // one propagated from its net - with a dark outline so it stays legible over
  // any pin colour. Off-screen pins are culled since there can be thousands.
  {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const p of scene.pins) {
      if (!p.effectiveDiode) continue;
      const rPx = p.r * view.k;
      if (rPx < PIN_TEXT_MIN_PX) continue;
      const cx = worldToCssX(p.cx);
      const cy = worldToCssY(p.cy);
      if (cx < -40 || cx > cssW + 40 || cy < -20 || cy > cssH + 20) continue;
      const fs = Math.min(Math.max(rPx * 1.1, 9), 16);
      ctx.font = `${fs.toFixed(1)}px sans-serif`;
      ctx.lineWidth = Math.max(fs / 5, 2);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(p.effectiveDiode, cx, cy);
      ctx.fillStyle = "#eaffef";
      ctx.fillText(p.effectiveDiode, cx, cy);
    }
  }
}

// ---------------------------------------------------------------------------
// Interaction (pan / zoom / hover / click)
// ---------------------------------------------------------------------------
function setupInteraction() {
  let panning = false;
  let moved = false;
  let downX = 0,
    downY = 0,
    lastX = 0,
    lastY = 0;

  const rectPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [cx, cy] = rectPos(e);
      const wx = cssToWorldX(cx);
      const wy = cssToWorldY(cy);
      // Scale the zoom step with the actual wheel delta so trackpads (many tiny
      // deltas) stay smooth and a mouse notch is a gentle step. Clamp the delta
      // so a momentum flick can't jump the view.
      const dy = Math.max(-80, Math.min(80, e.deltaY));
      const factor = Math.exp(-dy * ZOOM_SENSITIVITY);
      const k = Math.max(
        view.kFit * 0.05,
        Math.min(view.kFit * 1000, view.k * factor),
      );
      view.k = k;
      view.tx = cx - wx * k;
      view.ty = cy - wy * k;
      requestRender();
    },
    { passive: false },
  );

  canvas.addEventListener("mousedown", (e) => {
    panning = true;
    moved = false;
    [downX, downY] = rectPos(e);
    lastX = downX;
    lastY = downY;
    canvas.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    const [cx, cy] = rectPos(e);
    if (panning) {
      const dx = cx - lastX,
        dy = cy - lastY;
      if (Math.abs(cx - downX) > 3 || Math.abs(cy - downY) > 3) moved = true;
      view.tx += dx;
      view.ty += dy;
      lastX = cx;
      lastY = cy;
      requestRender();
      return;
    }
    if (e.target !== canvas) return; // ignore hover over the controls/panels
    // Hover pick
    const tol = PICK_PX / view.k;
    const hit = pick(cssToWorldX(cx), cssToWorldY(cy), tol);
    const net = hit ? netOf(hit) : null;
    const info = hit ? infoOf(hit) : null;
    if (net !== hoverNet || info !== hoverInfo) {
      hoverNet = net;
      hoverInfo = info;
      updateInfoPanel();
      requestRender();
    }
    canvas.style.cursor = hit ? "pointer" : "grab";
  });

  window.addEventListener("mouseup", (e) => {
    if (!panning) return;
    panning = false;
    canvas.style.cursor = "grab";
    if (moved) return; // was a pan, not a click
    const [cx, cy] = rectPos(e);
    const tol = PICK_PX / view.k;
    const hit = pick(cssToWorldX(cx), cssToWorldY(cy), tol);
    if (hit) {
      selectedNet = netOf(hit);
      selectedInfo = infoOf(hit);
    } else {
      selectedNet = null;
      selectedInfo = null;
    }
    searchPins = null;
    updateInfoPanel();
    requestRender();
  });

  window.addEventListener("resize", requestRender);
}

function netOf(hit) {
  const n = hit.ref.net;
  return n != null && n > 0 ? n : null;
}

// "NAME (#index)" when a net name is known, "#index" otherwise, null for no net.
function netLabel(index) {
  if (index == null || index <= 0) return null;
  const name = scene && scene.netIndexMap ? scene.netIndexMap[index] : null;
  return name ? `${name} (#${index})` : `#${index}`;
}

// A net's propagated diode reading (its pins' single agreed value); null when
// the net has no reading or its pins disagree.
function netDiode(index) {
  if (index == null || index <= 0 || !scene) return null;
  const entry = scene.netMap.get(index);
  return entry && entry.diode && !entry.diodeConflict ? entry.diode : null;
}

function infoOf(hit) {
  const r = hit.ref;
  if (hit.type === "pin") {
    // effectiveDiode already resolves own vs net-inherited; mark inherited ones.
    const diode = r.effectiveDiode
      ? r.diodeFromNet
        ? `${r.effectiveDiode} (net)`
        : r.effectiveDiode
      : undefined;
    return {
      title: "Pin",
      rows: [
        ["Part", r.partName],
        ["Pin", r.pinName],
        ["Package", r.package],
        ["Net", netLabel(r.net)],
        ["Diode", diode],
        ["Voltage", r.voltage],
        ["Comment", r.comment],
      ],
    };
  }
  if (hit.type === "via") {
    return {
      title: "Via",
      rows: [
        ["Net", netLabel(r.net)],
        ["Diode", netDiode(r.net)],
        ["Text", r.text],
        ["Layers", `${r.labelA} ↔ ${r.labelB}`],
      ],
    };
  }
  const dn = scene.displayMap[r.layer];
  return {
    title: "Trace",
    rows: [
      ["Net", netLabel(r.net)],
      ["Diode", netDiode(r.net)],
      ["Layer", dn ? `Layer ${dn}` : `Layer ${r.layer}`],
    ],
  };
}

// ---------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------
function updateInfoPanel() {
  const el = document.getElementById("info");
  const info = selectedInfo || hoverInfo;
  if (!info) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const rows = info.rows
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(
      ([k, v]) =>
        `<div class="info-row"><span class="info-key">${k}</span><span>${escapeHtml(String(v))}</span></div>`,
    )
    .join("");
  el.innerHTML = `<div class="info-title">${info.title}${selectedInfo ? " (selected)" : ""}</div>${rows}`;
  el.hidden = false;
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function buildControls() {
  const controls = document.getElementById("controls");
  controls.innerHTML = "";

  const br = () => controls.appendChild(document.createElement("br"));

  // Width slider
  const sliderLabel = document.createElement("span");
  sliderLabel.style.marginRight = "4px";
  sliderLabel.textContent = `Width ×${widthFactor.toFixed(1)}`;
  const widthSlider = document.createElement("input");
  widthSlider.type = "range";
  widthSlider.min = "0.1";
  widthSlider.max = "5";
  widthSlider.step = "0.1";
  widthSlider.value = String(widthFactor);
  widthSlider.style.verticalAlign = "middle";
  widthSlider.oninput = () => {
    widthFactor = parseFloat(widthSlider.value);
    sliderLabel.textContent = `Width ×${widthFactor.toFixed(1)}`;
    requestRender();
  };
  controls.appendChild(sliderLabel);
  controls.appendChild(widthSlider);
  br();

  // Via numbers toggle
  const viaBtn = document.createElement("button");
  viaBtn.textContent = "Via Numbers";
  viaBtn.classList.toggle("active", showViaNumbers);
  viaBtn.onclick = () => {
    showViaNumbers = !showViaNumbers;
    viaBtn.classList.toggle("active", showViaNumbers);
    requestRender();
  };
  controls.appendChild(viaBtn);

  // Pin rendering toggle
  const pinBtn = document.createElement("button");
  pinBtn.textContent = "Pin Rendering";
  pinBtn.classList.toggle("active", showPins);
  pinBtn.onclick = () => {
    showPins = !showPins;
    pinBtn.classList.toggle("active", showPins);
    requestRender();
  };
  controls.appendChild(pinBtn);

  // Highlight pins with additional data (diode/voltage/comment) in green
  const dataBtn = document.createElement("button");
  dataBtn.textContent = "Data Pins";
  dataBtn.classList.toggle("active", highlightDataPins);
  dataBtn.style.setProperty("--layer-color", DATA_PIN_COLOR);
  dataBtn.onclick = () => {
    highlightDataPins = !highlightDataPins;
    dataBtn.classList.toggle("active", highlightDataPins);
    requestRender();
  };
  controls.appendChild(dataBtn);

  // Reset view
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset View";
  resetBtn.onclick = () => {
    fitToBounds();
    requestRender();
  };
  controls.appendChild(resetBtn);
  br();

  const layerButtons = {};

  // Show all
  const showAllBtn = document.createElement("button");
  showAllBtn.textContent = "Show All";
  showAllBtn.onclick = () => {
    for (const layer of scene.layerOrder) {
      scene.layers[layer].visible = true;
      if (layerButtons[layer]) layerButtons[layer].classList.add("active");
    }
    updateViaVisibility();
    requestRender();
  };
  controls.appendChild(showAllBtn);

  // Per-layer toggles (skip unpopulated <=16 layers, matching the old UI)
  for (const layer of scene.layerOrder) {
    if (
      layer !== OUTLINE_LAYER &&
      layer !== SILKSCREEN_LAYER &&
      !scene.displayMap[layer] &&
      layer <= 16
    )
      continue;
    const L = scene.layers[layer];
    const btn = document.createElement("button");
    btn.textContent = getLayerDisplayName(layer, scene.displayMap);
    btn.classList.toggle("active", L.visible);
    btn.style.setProperty("--layer-color", L.color);
    btn.onclick = () => {
      L.visible = !L.visible;
      btn.classList.toggle("active", L.visible);
      updateViaVisibility();
      requestRender();
    };
    controls.appendChild(btn);
    layerButtons[layer] = btn;
  }
  br();

  // Search (net index or pin/part name)
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Highlight net # or pin/part name";
  search.oninput = () => runSearch(search.value.trim());
  controls.appendChild(search);
}

function getLayerDisplayName(layer, displayMap) {
  if (layer === OUTLINE_LAYER) return "Outlines";
  if (layer === SILKSCREEN_LAYER) return "Silkscreen";
  if (layer === PART_OUTLINES_LAYER) return "Part Outlines";
  if (layer > 16) return `Layer ${layer}`;
  return `Layer ${displayMap[layer]}`;
}

function runSearch(q) {
  selectedNet = null;
  selectedInfo = null;
  searchPins = null;
  if (!q) {
    hoverNet = null;
    updateInfoPanel();
    requestRender();
    return;
  }

  if (/^\d+$/.test(q)) {
    // Net index
    const net = parseInt(q, 10);
    selectedNet = net;
    selectedInfo = { title: "Net", rows: [["Net", netLabel(net) || `#${net}`]] };
    fitToNet(net);
  } else {
    // Pin/part name (incl. alias) substring; fall back to net-name match.
    const needle = q.toLowerCase();
    const aliasOf = (p) =>
      scene.obdata && scene.obdata.parts && scene.obdata.parts[p.partName]
        ? scene.obdata.parts[p.partName].alias
        : null;
    const matches = scene.pins.filter((p) => {
      const alias = aliasOf(p);
      return (
        (p.pinName && p.pinName.toLowerCase().includes(needle)) ||
        (p.partName && p.partName.toLowerCase().includes(needle)) ||
        (alias && String(alias).toLowerCase().includes(needle))
      );
    });
    if (matches.length) {
      searchPins = matches;
      selectedInfo = {
        title: "Search",
        rows: [
          ["Query", q],
          ["Matches", matches.length],
        ],
      };
      fitToPins(matches);
    } else {
      // No pin/part hit - try net names (exact preferred, else first substring).
      const idx = findNetByName(needle);
      if (idx != null) {
        selectedNet = idx;
        selectedInfo = { title: "Net", rows: [["Net", netLabel(idx)]] };
        fitToNet(idx);
      } else {
        selectedInfo = {
          title: "Search",
          rows: [
            ["Query", q],
            ["Matches", 0],
          ],
        };
      }
    }
  }
  updateInfoPanel();
  requestRender();
}

// Resolve a lowercase needle to a net index by name: exact match wins, else the
// first substring match. Returns null if nothing matches.
function findNetByName(needle) {
  const map = scene.netIndexMap;
  if (!map) return null;
  let sub = null;
  for (const idxStr of Object.keys(map)) {
    const name = map[idxStr];
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower === needle) return Number(idxStr);
    if (sub == null && lower.includes(needle)) sub = Number(idxStr);
  }
  return sub;
}

function fitToNet(net) {
  const entry = scene.netMap.get(net);
  if (!entry) return;
  const pts = [];
  for (const s of entry.segs) {
    pts.push([s.x1, s.y1], [s.x2, s.y2]);
  }
  for (const v of entry.vias) pts.push([v.cx, v.cy]);
  for (const p of entry.pins) pts.push([p.cx, p.cy]);
  fitToPoints(pts);
}

function fitToPins(pins) {
  fitToPoints(pins.map((p) => [p.cx, p.cy]));
}

function fitToPoints(pts) {
  if (!pts.length) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const k = Math.min(cw / w, ch / h) * 0.6;
  view.k = Math.max(view.kFit * 0.05, Math.min(view.kFit * 1000, k));
  view.tx = cw / 2 - ((minX + maxX) / 2) * view.k;
  view.ty = ch / 2 - ((minY + maxY) / 2) * view.k;
}

// Pan (without zooming) so the bounding box of `pts` is centred in the view.
function centerOnPoints(pts) {
  if (!pts.length) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  view.tx = cw / 2 - ((minX + maxX) / 2) * view.k;
  view.ty = ch / 2 - ((minY + maxY) / 2) * view.k;
}

// ---------------------------------------------------------------------------
// Component / Net browser (right-hand panel)
// ---------------------------------------------------------------------------
function selectNet(index, name, alias, comment) {
  selectedNet = index;
  searchPins = null;
  selectedInfo = {
    title: "Net",
    rows: [
      ["Net", name ? `${name} (#${index})` : `#${index}`],
      ["Alias", alias],
      ["Comment", comment],
    ],
  };
  fitToNet(index);
  updateInfoPanel();
  requestRender();
}

function focusPart(refName) {
  const partPins = scene.pinsByPart.get(refName);
  if (!partPins || !partPins.length) return;
  selectedNet = null;
  searchPins = partPins;
  selectedInfo = {
    title: "Part",
    rows: [
      ["Part", refName],
      ["Pins", partPins.length],
    ],
  };
  // Highlight and centre the part, but keep the current zoom so a small part
  // isn't blown up to fill the window.
  centerOnPoints(partPins.map((p) => [p.cx, p.cy]));
  updateInfoPanel();
  requestRender();
}

function buildBrowser() {
  const el = document.getElementById("browser");
  if (!el) return;
  el.innerHTML = "";

  const parts = scene.partsList || [];
  const nets = scene.netsList || [];
  if (!parts.length && !nets.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  let tab = "parts";

  const tabs = document.createElement("div");
  tabs.className = "browser-tabs";
  const partsBtn = document.createElement("button");
  partsBtn.textContent = `Parts (${parts.length})`;
  const netsBtn = document.createElement("button");
  netsBtn.textContent = `Nets (${nets.length})`;
  tabs.appendChild(partsBtn);
  tabs.appendChild(netsBtn);

  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "Filter…";

  const list = document.createElement("div");
  list.className = "browser-list";

  const pinLine = (pin) => {
    const netTxt = pin.net_name || (pin.net_index ? `#${pin.net_index}` : "");
    const extra = [
      pin.diode_reading ? `D:${pin.diode_reading}` : "",
      pin.voltage ? `V:${pin.voltage}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const row = document.createElement("div");
    row.className = "bi-pin";
    row.innerHTML =
      `<span class="info-key">${escapeHtml(pin.pinName)}</span>` +
      `<span>${escapeHtml(netTxt)}${extra ? " · " + escapeHtml(extra) : ""}</span>`;
    if (pin.net_index) {
      row.onclick = (e) => {
        e.stopPropagation();
        selectNet(pin.net_index, pin.net_name);
      };
    }
    return row;
  };

  const partRow = (p) => {
    const d = document.createElement("details");
    d.className = "browser-item";
    const s = document.createElement("summary");
    s.innerHTML =
      `<span class="bi-name">${escapeHtml(p.refName)}</span>` +
      (p.alias ? `<span class="bi-sub">${escapeHtml(String(p.alias))}</span>` : "") +
      (p.pkg && p.pkg !== p.refName
        ? `<span class="bi-sub">${escapeHtml(String(p.pkg))}</span>`
        : "");
    s.onclick = () => focusPart(p.refName);
    d.appendChild(s);
    const pinWrap = document.createElement("div");
    pinWrap.className = "bi-pins";
    for (const pin of p.pins) pinWrap.appendChild(pinLine(pin));
    d.appendChild(pinWrap);
    return d;
  };

  const netRow = (n) => {
    const row = document.createElement("div");
    row.className = "browser-item";
    row.innerHTML =
      `<span class="bi-name">${n.name ? escapeHtml(n.name) : "#" + n.index}</span>` +
      `<span class="bi-sub">#${n.index}</span>` +
      (n.alias ? `<div class="bi-sub">alias: ${escapeHtml(String(n.alias))}</div>` : "") +
      (n.comment ? `<div class="bi-sub">${escapeHtml(String(n.comment))}</div>` : "");
    row.onclick = () => selectNet(n.index, n.name, n.alias, n.comment);
    return row;
  };

  const renderList = () => {
    const needle = filter.value.trim().toLowerCase();
    list.innerHTML = "";
    if (tab === "parts") {
      for (const p of parts) {
        if (
          needle &&
          !(
            p.refName.toLowerCase().includes(needle) ||
            (p.alias && String(p.alias).toLowerCase().includes(needle)) ||
            (p.pkg && String(p.pkg).toLowerCase().includes(needle))
          )
        )
          continue;
        list.appendChild(partRow(p));
      }
    } else {
      for (const n of nets) {
        const hay = `${n.name || ""} ${n.alias || ""} ${n.comment || ""} #${n.index}`.toLowerCase();
        if (needle && !hay.includes(needle)) continue;
        list.appendChild(netRow(n));
      }
    }
  };

  const setTab = (t) => {
    tab = t;
    partsBtn.classList.toggle("active", t === "parts");
    netsBtn.classList.toggle("active", t === "nets");
    renderList();
  };
  partsBtn.onclick = () => setTab("parts");
  netsBtn.onclick = () => setTab("nets");
  filter.oninput = renderList;

  // Collapsible header: title + toggle. Collapsing hides the body, leaving just
  // the header bar.
  const header = document.createElement("div");
  header.className = "browser-header";
  const title = document.createElement("span");
  title.className = "browser-title";
  title.textContent = "Parts / Nets";
  const toggle = document.createElement("button");
  toggle.className = "browser-toggle";
  header.appendChild(title);
  header.appendChild(toggle);

  const body = document.createElement("div");
  body.className = "browser-body";
  body.appendChild(tabs);
  body.appendChild(filter);
  body.appendChild(list);

  const applyCollapse = () => {
    el.classList.toggle("collapsed", browserCollapsed);
    toggle.textContent = browserCollapsed ? "▸" : "▾";
    toggle.setAttribute("aria-label", browserCollapsed ? "Expand" : "Collapse");
  };
  const toggleCollapse = () => {
    browserCollapsed = !browserCollapsed;
    applyCollapse();
  };
  toggle.onclick = toggleCollapse;
  header.onclick = (e) => {
    if (e.target !== toggle) toggleCollapse();
  };

  el.appendChild(header);
  el.appendChild(body);
  applyCollapse();
  setTab(parts.length ? "parts" : "nets");
}

// ---------------------------------------------------------------------------
// Top-level load
// ---------------------------------------------------------------------------
function loadScene(json) {
  const built = buildScene(json);
  const controls = document.getElementById("controls");
  if (!built) {
    controls.textContent = "No drawable objects found in file.";
    return;
  }
  scene = built;
  hoverNet = selectedNet = null;
  hoverInfo = selectedInfo = null;
  searchPins = null;
  highlightCache = { net: undefined, buckets: null };
  resizeCanvas();
  fitToBounds();
  buildControls();
  buildBrowser();
  updateInfoPanel();
  requestRender();
}

function init() {
  canvas = document.getElementById("pcb");
  ctx = canvas.getContext("2d");
  setupInteraction();
  buildFileInput();
}

function buildFileInput() {
  const controls = document.getElementById("controls");
  controls.innerHTML = "";
  const browser = document.getElementById("browser");
  if (browser) browser.hidden = true;

  const info = document.createElement("span");
  info.textContent = "Select a JSON or PCB file: ";
  controls.appendChild(info);

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.pcb,application/json";
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    if (file.name.toLowerCase().endsWith(".pcb")) {
      reader.onload = (e) => {
        try {
          const data = new RawPCBParser().parse(e.target.result);
          loadScene(data);
        } catch (err) {
          controls.textContent = "Invalid PCB file.";
          console.error("PCB parsing error:", err);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => {
        try {
          loadScene(JSON.parse(e.target.result));
        } catch (err) {
          controls.textContent = "Invalid JSON file.";
          console.error("JSON parsing error:", err);
        }
      };
      reader.readAsText(file);
    }
  };
  controls.appendChild(input);

  const hint = document.createElement("div");
  hint.style.fontSize = "0.75rem";
  hint.style.marginTop = "4px";
  hint.textContent =
    "Input file can be a JSON file exported from ImHex using the XZZPCB pattern file, or a raw .pcb file";
  controls.appendChild(hint);
}

// Debug/inspection surface (mirrors the old window.pcbPanZoom hook).
window.pcbDebug = {
  get scene() {
    return scene;
  },
  get view() {
    return view;
  },
  get selectedNet() {
    return selectedNet;
  },
  get hoverNet() {
    return hoverNet;
  },
  load: loadScene,
  pick(cssX, cssY) {
    const h = pick(cssToWorldX(cssX), cssToWorldY(cssY), PICK_PX / view.k);
    return h ? { type: h.type, net: netOf(h) } : null;
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
