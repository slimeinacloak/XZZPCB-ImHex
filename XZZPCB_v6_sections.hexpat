#pragma description XZZPCB v6v6555v6v6 metadata sections (standalone)
#pragma endian little
#pragma pattern_limit 6000000

// Standalone view of the trailing "v6v6555v6v6" metadata: run this directly on
// an extracted PCB_Files_Meta/*_metadatav6.pcb file or a Section_Examples/
// *.section.bin fragment (the full XZZPCB.hexpat can only reach this region on a
// whole de-xored .pcb). The parser below is kept byte-for-byte identical to the
// v6 section block inside XZZPCB.hexpat - edit both together.
//
// Section labels and record fields mirror the canonical Python parser
// XZZ-Downloader/xzz/obdata.py (sub_header_types + return_* functions). Unlike
// obdata (which builds a dict and drops blank / non-matching lines), this tiles
// the bytes into an ordered record per line. See Section_Patterns/PATTERNS.md.
//
// Layout:
//   "v6v6555v6v6" <term?>              marker line (optional CR/LF), may be absent
//   ( "===" <header> <term> <body> )*  sections, back to back, until EOF
// <term> is CRLF (0d 0a), LF (0a) or CR (0d). A body runs to the next "==="
// (no body ever contains "===") or EOF.

import std.mem;

// End offset (exclusive) of the section body currently being parsed. Set by
// v6_section_s just before it parses the body; read by the per-line structs so
// they never run past the body into the next "===".
u128 v6_body_end;

// Offset of the next "===" at or after `pos`, or the file size if none remain.
fn v6_next_sep(u128 pos) {
    u128 total = std::mem::size();
    if (pos >= total)
        return total;
    s128 hit = std::mem::find_sequence_in_range(0, pos, total, 0x3D, 0x3D, 0x3D);
    if (hit < 0 || u128(hit) > total)
        return total;
    return u128(hit);
};

// obdata.py section label, from the header bytes at `addr`. An empty header
// (the byte after "===" is already CR/LF) is obdata's "Part data".
fn v6_section_kind(u128 addr) {
    u8 lead = std::mem::read_unsigned(addr, 1);
    if (lead == 0x0A || lead == 0x0D) return "Part data";
    if (lead == 0x52) return "RFFE";
    if (lead == 0x50) return "PCB Attachment";
    if (lead == 0xB5) return "Voltage";
    if (lead == 0xD0) return "Signal";
    if (lead == 0xD4) return "Schematic";
    if (lead == 0xD7) {
        u8 tail = std::mem::read_unsigned(addr + 4, 1);
        if (tail == 0xCD) return "Resistance diagram";
        if (tail == 0xB1) return "Resistance table";
        return "Resistance";
    }
    return "unknown";
};

// Body decoder to use, from the header bytes at `addr`:
//   0 = opaque   (PCB Attachment / RFFE JSON, or unknown)
//   1 = voltage             key=value  -> {net, voltage}
//   2 = resistance / table  return_diode_readings -> {reading, net, pin} | {net, reading}
//   3 = schematic           single path string
//   4 = resistance diagram  key=value  -> {net, reading}
//   5 = signal              key=value (value may contain '=') -> {signal, description}
//   6 = part data           whitespace -> {part_name, line_description, part_pad_size}
fn v6_body_shape(u128 addr) {
    u8 lead = std::mem::read_unsigned(addr, 1);
    if (lead == 0x0A || lead == 0x0D) return 6;   // empty header -> Part data
    if (lead == 0xB5) return 1;                   // Voltage
    if (lead == 0xD0) return 5;                   // Signal
    if (lead == 0xD4) return 3;                   // Schematic
    if (lead == 0xD7) {
        u8 tail = std::mem::read_unsigned(addr + 4, 1);
        if (tail == 0xCD) return 4;               // Resistance diagram
        if (tail == 0xB1) return 2;               // Resistance table
        return 2;                                 // Resistance
    }
    return 0;                                     // RFFE / PCB Attachment / unknown
};

// The CR/LF run that ends a "===" header line, plus any blank lines right after
// it, so the first body record starts on real content (some bodies use "\n\n"
// between records; CR-only occurs on some PCB附加).
struct v6_line_end_s {
    u8 crlf[while(!std::mem::eof()
        && (std::mem::read_unsigned($, 1) == 0x0D
            || std::mem::read_unsigned($, 1) == 0x0A))] [[hidden]];
} [[hidden]];

// The CR/LF run that ends a body line, collapsing blank lines, without ever
// reading past v6_body_end (the last line of a body may have no terminator).
struct v6_eol_s {
    u8 crlf[while($ < v6_body_end
        && (std::mem::read_unsigned($, 1) == 0x0D
            || std::mem::read_unsigned($, 1) == 0x0A))] [[hidden]];
} [[hidden]];

// Voltage line: net=voltage (obdata return_voltage).
struct v6_voltage_line_s {
    char net[while($ < v6_body_end
        && std::mem::read_unsigned($, 1) != 0x3D
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x3D) {
        padding[1]; // '='
        char voltage[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
    }
    v6_eol_s eol;
};

// Resistance-diagram line: net=reading (obdata return_resistance_diagram).
struct v6_resistance_diagram_line_s {
    char net[while($ < v6_body_end
        && std::mem::read_unsigned($, 1) != 0x3D
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x3D) {
        padding[1]; // '='
        char reading[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
    }
    v6_eol_s eol;
};

// Signal line: signal=description, where description may itself contain '='
// (obdata return_signal captures everything after the first '=').
struct v6_signal_line_s {
    char signal[while($ < v6_body_end
        && std::mem::read_unsigned($, 1) != 0x3D
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x3D) {
        padding[1]; // '='
        char description[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
    }
    v6_eol_s eol;
};

// Resistance line (obdata return_diode_readings). Two forms:
//   Format A "=reading=net(pin)"  (leading '=' + parenthesis) -> reading, net, pin
//   Format B "net=reading"        -> net, reading (no pin)
struct v6_resistance_line_s {
    u8 lead = std::mem::read_unsigned($, 1) [[hidden]];
    if (lead == 0x3D) {
        padding[1]; // leading '='
        char reading[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x3D
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
        if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x3D)
            padding[1]; // '='
        char net[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x28   // '('
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
        if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x28) {
            padding[1]; // '('
            char pin[while($ < v6_body_end
                && std::mem::read_unsigned($, 1) != 0x29   // ')'
                && std::mem::read_unsigned($, 1) != 0x0D
                && std::mem::read_unsigned($, 1) != 0x0A)];
            if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x29)
                padding[1]; // ')'
        }
        // obdata's regex matches a prefix; ignore anything after ")" up to EOL.
        u8 trailing[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)] [[hidden]];
    } else {
        char net[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x3D
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
        if ($ < v6_body_end && std::mem::read_unsigned($, 1) == 0x3D)
            padding[1]; // '='
        char reading[while($ < v6_body_end
            && std::mem::read_unsigned($, 1) != 0x0D
            && std::mem::read_unsigned($, 1) != 0x0A)];
    }
    v6_eol_s eol;
};

// Part-data line (obdata return_part_data): three whitespace-separated fields
// "part_name  line_description  part_pad_size (rest of line)".
struct v6_part_data_line_s {
    char part_name[while($ < v6_body_end
        && std::mem::read_unsigned($, 1) != 0x20   // space
        && std::mem::read_unsigned($, 1) != 0x09   // tab
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    u8 ws1[while($ < v6_body_end
        && (std::mem::read_unsigned($, 1) == 0x20
            || std::mem::read_unsigned($, 1) == 0x09))] [[hidden]];
    char line_description[while($ < v6_body_end
        && std::mem::read_unsigned($, 1) != 0x20
        && std::mem::read_unsigned($, 1) != 0x09
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    u8 ws2[while($ < v6_body_end
        && (std::mem::read_unsigned($, 1) == 0x20
            || std::mem::read_unsigned($, 1) == 0x09))] [[hidden]];
    char part_pad_size[while($ < v6_body_end
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    v6_eol_s eol;
};

// One "===<header><term><body>" section. kind names it in the tree; the body is
// decoded per v6_body_shape.
struct v6_section_s {
    char separator[3] [[hidden]]; // "==="
    str kind = v6_section_kind($);
    u8  shape = v6_body_shape($) [[hidden]];
    char header[while(!std::mem::eof()
        && std::mem::read_unsigned($, 1) != 0x0D
        && std::mem::read_unsigned($, 1) != 0x0A)];
    v6_line_end_s terminator;
    u128 body_length = v6_next_sep($) - $ [[hidden]];
    v6_body_end = $ + body_length;
    if (body_length > 0) {
        if (shape == 1) {
            v6_voltage_line_s lines[while($ < v6_body_end)];
        } else if (shape == 2) {
            v6_resistance_line_s lines[while($ < v6_body_end)];
        } else if (shape == 4) {
            v6_resistance_diagram_line_s lines[while($ < v6_body_end)];
        } else if (shape == 5) {
            v6_signal_line_s lines[while($ < v6_body_end)];
        } else if (shape == 6) {
            v6_part_data_line_s lines[while($ < v6_body_end)];
        } else if (shape == 3) {
            char path[while($ < v6_body_end
                && std::mem::read_unsigned($, 1) != 0x0D
                && std::mem::read_unsigned($, 1) != 0x0A)];
            if ($ < v6_body_end)
                u8 path_end[v6_body_end - $] [[hidden]]; // trailing newline
        } else {
            char body[body_length]; // RFFE / PCB Attachment (JSON) / unknown
        }
    }
} [[name(kind)]];

// The whole metadata region: the "v6v6555v6v6" marker (plus its optional
// terminator, absorbed as whatever bytes precede the first "===") followed by
// the sections until end of file.
struct v6_metadata_s {
    u128 first_section = v6_next_sep($) [[hidden]];
    if (first_section > $) {
        char marker[first_section - $]; // "v6v6555v6v6" + optional terminator
    }
    v6_section_s sections[while(!std::mem::eof())];
};

v6_metadata_s v6meta @ 0x00;
