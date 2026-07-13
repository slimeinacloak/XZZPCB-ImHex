/* obdata_parser.js
 * Port of the *parsing* half of obdata.py into the browser.
 *
 * The raw parser (raw_parser.js) already de-XORs the file and DES-decrypts the
 * part blocks. This module adds the two things obdata.py extracts that the raw
 * parser ignores:
 *
 *   1. the net-index -> net-name map (so the viewer can show "DDR_VDDQ", not "#42"), and
 *   2. the "post-v6" additional data that trails the net block: voltages, net
 *      comments (Signal), net/part aliases, resistance readings, part pad
 *      descriptions, schematic, RFFE.
 *
 * It then folds that metadata onto the already-parsed parts/pins (reusing the
 * PartDataParser output rather than re-parsing the DES blocks) to produce the
 * same combined structure obdata.py builds:
 *
 *   { parts: { <refdes>: { pins: { <pin>: {net_index, net_name, diode_reading?,
 *                                          voltage?} }, alias?, pad_desc?,
 *                          line_description?, part_pad_size? } },
 *     net_aliases: {...}, signal_descriptions: {...}, schematic, rffe }
 *
 * No .obdata *writer* code is ported - the viewer only enriches its display.
 *
 * Exposed as a global singleton (loaded via a plain <script>, detected with
 * `typeof ObdataParser !== 'undefined'`), mirroring how PartDataParser is used.
 */

const ObdataParser = {
  // "v6v6555v6v6" magic that immediately follows the net block.
  MAIN_HEADER_LEN: 11,

  // sub_header_types from obdata.py, keyed by the lowercase hex of the raw
  // (GB2312-encoded) header bytes. We match on bytes, not decoded text.
  SUB_HEADER_TYPES: {
    "504342b8bdbcd3": "PCB Attachment", // JSON
    d0c5bac5: "Signal",
    d0c5bac5202020: "Signal",
    "52464645": "RFFE", // JSON
    d7e8d6b5: "Resistance",
    b5e7d1b9: "Voltage",
    d7e8d6b5cdbc: "Resistance diagram",
    "": "Part data", // empty header
    d4adc0edcdbc: "Schematic",
    d7e8d6b5b1ed: "Resistance table",
  },

  _gb: null,
  _decodeGb(bytes) {
    if (!this._gb) this._gb = new TextDecoder("gb18030");
    return this._gb.decode(bytes);
  },

  // translate_bytes_failover: prefer a strict UTF-8 decode, fall back to GB2312.
  _decodeFailover(dataView, pos, size) {
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset + pos, size);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      return this._decodeGb(bytes);
    }
  },

  _toHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  },

  // --- Net index map (obdata.py extract_net_index_map) ----------------------
  extractNetIndexMap(dataView) {
    const netBlockStart = dataView.getUint32(0x28, true) + 0x20;
    let pos = netBlockStart;
    const netBlockSize = dataView.getUint32(pos, true);
    pos += 4;
    const map = {};
    const end = netBlockStart + netBlockSize;
    while (pos < end) {
      const netDataSize = dataView.getUint32(pos, true);
      pos += 4;
      const netIndex = dataView.getUint32(pos, true);
      pos += 4;
      const nameSize = netDataSize - 8;
      map[netIndex] = this._decodeFailover(dataView, pos, nameSize);
      pos += nameSize;
    }
    if (!(0 in map)) map[0] = "UNCONNECTED";
    return map;
  },

  // --- Post-v6 section location (obdata.py get_net_block_end) ----------------
  getNetBlockEnd(dataView) {
    const netBlockStart = dataView.getUint32(0x28, true) + 32;
    const netBlockLength = dataView.getUint32(netBlockStart, true);
    return netBlockStart + netBlockLength + 4;
  },

  // --- Split the post-v6 region into { headerBytes, bodyBytes } sections -----
  // (obdata.py extract_post_v6_data)
  extractPostV6(dataView) {
    const start = this.getNetBlockEnd(dataView) + this.MAIN_HEADER_LEN;
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    const total = bytes.length;
    if (start >= total) return [];

    // Every "===" (0x3d 0x3d 0x3d) divider marks the start of a section.
    const positions = [];
    let i = start;
    while (i <= total - 3) {
      if (bytes[i] === 0x3d && bytes[i + 1] === 0x3d && bytes[i + 2] === 0x3d) {
        positions.push(i);
        i += 3;
      } else {
        i++;
      }
    }

    const sections = [];
    for (let k = 0; k < positions.length; k++) {
      const secStart = positions[k];
      const secEnd = k + 1 < positions.length ? positions[k + 1] : total;
      // header runs from just after "===" up to the first newline.
      let p = secStart + 3;
      const header = [];
      while (p < secEnd && bytes[p] !== 0x0a && bytes[p] !== 0x0d) {
        header.push(bytes[p]);
        p++;
      }
      const bodyStart = Math.min(p + 1, secEnd);
      const bodyBytes = bytes.subarray(bodyStart, secEnd);
      // skip sections whose body is only newlines
      let hasContent = false;
      for (let b = 0; b < bodyBytes.length; b++) {
        if (bodyBytes[b] !== 0x0a && bodyBytes[b] !== 0x0d) {
          hasContent = true;
          break;
        }
      }
      if (!hasContent) continue;
      sections.push({ headerBytes: Uint8Array.from(header), bodyBytes });
    }
    return sections;
  },

  // --- Per-section body parsers (all GB2312-decoded) ------------------------
  _returnJson(bodyBytes) {
    let text = this._decodeGb(bodyBytes).replace(/[\n\r]+$/, "");
    return JSON.parse(text);
  },

  _returnSignal(bodyBytes) {
    const out = {};
    for (let line of this._decodeGb(bodyBytes).split("\n")) {
      line = line.trim();
      if (line === "") continue;
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  },

  // return_diode_readings: nested "=v=part(pin)" form, else flat "key=value".
  _returnDiodeReadings(bodyBytes) {
    const out = {};
    for (let line of this._decodeGb(bodyBytes).split("\n")) {
      line = line.trim();
      let m = line.match(/^=([^=]*)=([^=]+)\(([^)]+)\)/);
      if (m) {
        const value = m[1],
          key1 = m[2],
          key2 = m[3];
        if (!(key1 in out)) out[key1] = {};
        out[key1][key2] = value;
      } else {
        m = line.match(/^([^=]+)=([^=]+)$/);
        if (m) out[m[1]] = m[2];
      }
    }
    return out;
  },

  // return_voltage / return_resistance_diagram: flat "key=value".
  _returnKeyValue(bodyBytes) {
    const out = {};
    for (let line of this._decodeGb(bodyBytes).split("\n")) {
      line = line.trim();
      const m = line.match(/^([^=]+)=([^=]+)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  },

  _returnPartData(bodyBytes) {
    const out = {};
    for (let line of this._decodeGb(bodyBytes).split("\n")) {
      line = line.trim();
      const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (m) out[m[1]] = { line_description: m[2], part_pad_size: m[3] };
    }
    return out;
  },

  _returnSchematic(bodyBytes) {
    return this._decodeGb(bodyBytes).trim();
  },

  // --- combine_data: dispatch each section by its header type ----------------
  combineData(sections) {
    const combined = {};
    for (const { headerBytes, bodyBytes } of sections) {
      const type = this.SUB_HEADER_TYPES[this._toHex(headerBytes)];
      if (type === undefined) continue; // unknown header - skip (Python raises)
      let data;
      try {
        switch (type) {
          case "PCB Attachment":
          case "RFFE":
            data = this._returnJson(bodyBytes);
            break;
          case "Signal":
            data = this._returnSignal(bodyBytes);
            break;
          case "Resistance":
          case "Resistance table":
            data = this._returnDiodeReadings(bodyBytes);
            break;
          case "Voltage":
          case "Resistance diagram":
            data = this._returnKeyValue(bodyBytes);
            break;
          case "Part data":
            data = this._returnPartData(bodyBytes);
            break;
          case "Schematic":
            data = this._returnSchematic(bodyBytes);
            break;
        }
      } catch (e) {
        console.warn(`obdata: failed to parse "${type}" section:`, e);
        continue;
      }
      if (data === undefined) continue;
      if (!(type in combined)) combined[type] = data; // keep first (Python raises on dup)
    }
    return combined;
  },

  // --- Reference designator = first non-empty sub_type_06 label -------------
  // NOT header.part_group_name (that is the pad/package descriptor, which
  // obdata.py calls pad_desc). Post-v6 data keys by refdes, so both this module
  // and the renderer must derive the ref the same way.
  partRefName(part) {
    if (part && Array.isArray(part.sub_blocks)) {
      for (const sb of part.sub_blocks) {
        if (sb.type === "sub_type_06" && sb.label) return sb.label;
      }
    }
    return "";
  },

  // --- Build the parts/pins structure from the already-parsed DATA blocks ----
  // (obdata.py extract_part_pin_nets, minus the DES re-parse)
  buildParts(blocks, netIndexMap) {
    const parts = {};
    for (const b of blocks) {
      const part = b && b.DATA ? b.DATA.parsed_data : null;
      if (!part || !Array.isArray(part.sub_blocks)) continue;
      const refName = this.partRefName(part);
      const padDesc = part.header ? part.header.part_group_name : "";
      const pins = {};
      for (const sb of part.sub_blocks) {
        if (sb.type !== "sub_type_09") continue;
        const pinName = sb.pin_name || "";
        let netIndex = 0,
          diode = "";
        if (Array.isArray(sb.sub_parts)) {
          const n = sb.sub_parts.find((p) => p.type === "pin_sub_type_00");
          if (n) {
            netIndex = n.net_index;
            diode = n.diode_reading || "";
          }
        }
        const pin = { net_index: netIndex, net_name: netIndexMap[netIndex] };
        if (diode) pin.diode_reading = diode;
        pins[pinName] = pin;
      }
      const entry = { pins };
      if (padDesc) entry.pad_desc = padDesc;
      parts[refName] = entry;
    }
    return { parts };
  },

  // --- Fold post-v6 data onto the parts structure ---------------------------
  // (obdata.py combine_post_v6_and_part_data; bitmap/diagnostic bits skipped)
  combinePostV6AndParts(partData, postV6) {
    const parts = partData.parts;

    const applyToNet = (netName, apply) => {
      for (const ref of Object.keys(parts)) {
        const pins = parts[ref].pins;
        for (const pinName of Object.keys(pins)) {
          if (pins[pinName].net_name === netName) apply(pins[pinName]);
        }
      }
    };

    const att = postV6["PCB Attachment"];
    if (att) {
      if (Array.isArray(att.part)) {
        for (const part of att.part) {
          const pd = parts[part.reference];
          if ("alias" in part && pd) pd.alias = part.alias;
          if (Array.isArray(part.pad) && pd && pd.pins) {
            for (const pin of part.pad) {
              if ("diode" in pin && pd.pins[pin.name]) {
                pd.pins[pin.name].diode_reading = pin.diode;
              }
            }
          }
        }
      }
      if (Array.isArray(att.net)) {
        partData.net_aliases = {};
        for (const net of att.net) {
          if ("alias" in net) partData.net_aliases[net.name] = net.alias;
        }
      }
    }

    const res = postV6["Resistance"];
    if (res) {
      for (const key of Object.keys(res)) {
        const val = res[key];
        if (val && typeof val === "object") {
          // key = part ref, val = { pin: reading }
          const pd = parts[key];
          if (pd && pd.pins) {
            for (const pin of Object.keys(val)) {
              if (pd.pins[pin]) pd.pins[pin].diode_reading = val[pin];
            }
          }
        } else {
          applyToNet(key, (pin) => (pin.diode_reading = val));
        }
      }
    }

    if (postV6["Signal"]) partData.signal_descriptions = postV6["Signal"];
    if (postV6["RFFE"]) partData.rffe = postV6["RFFE"];

    const volt = postV6["Voltage"];
    if (volt) {
      for (const net of Object.keys(volt)) applyToNet(net, (pin) => (pin.voltage = volt[net]));
    }

    const rd = postV6["Resistance diagram"];
    if (rd) {
      for (const net of Object.keys(rd)) applyToNet(net, (pin) => (pin.diode_reading = rd[net]));
    }

    const pdata = postV6["Part data"];
    if (pdata) {
      for (const ref of Object.keys(pdata)) {
        if (parts[ref]) Object.assign(parts[ref], pdata[ref]);
      }
    }

    if (postV6["Schematic"]) partData.schematic = postV6["Schematic"];

    const rt = postV6["Resistance table"];
    if (rt) {
      for (const net of Object.keys(rt)) applyToNet(net, (pin) => (pin.diode_reading = rt[net]));
    }

    return partData;
  },

  // --- Orchestrator: never throws, always returns a usable result -----------
  build(dataView, blocks) {
    let netIndexMap = {};
    try {
      netIndexMap = this.extractNetIndexMap(dataView);
    } catch (e) {
      console.warn("obdata: net index map extraction failed:", e);
    }

    let obdata;
    try {
      const partData = this.buildParts(blocks, netIndexMap);
      const sections = this.extractPostV6(dataView);
      obdata = sections.length
        ? this.combinePostV6AndParts(partData, this.combineData(sections))
        : partData;
    } catch (e) {
      console.warn("obdata: post-v6 parse failed:", e);
      try {
        obdata = this.buildParts(blocks, netIndexMap);
      } catch (_) {
        obdata = { parts: {} };
      }
    }

    return { net_index_map: netIndexMap, obdata };
  },
};

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = ObdataParser;
}
