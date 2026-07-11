#pragma pattern_limit 6000000

#include <std/mem.pat>
#include <std/string.pat>

/*!
    XZZPCB decoder
    ==============

    File layout:
        0x00   file_header_s      fixed header
        0x44   main data blocks   stream of type-tagged blocks, ending at
                                   0x44 + main_data_blocks_size
               images_block       image references (block may be empty)
               net_block          net names
               [ v6v655 ]         "v6v6555v6v6" marker                (disabled)
               [ post_v6 ]        diode readings, menu, signal names,
                                  part params                        (disabled)

    Each main data block is tagged by a leading u8 type byte:
        0x01  Arcs
        0x02  Vias
        0x03  Seen, purpose unknown
        0x04  Not seen (no handling)
        0x05  Line segments
        0x06  Text
        0x07  Parts & pads
        0x08  Not seen (no handling)
        0x09  Test pads / drill holes
    Runs of 0x00 bytes between blocks are padding.

    The `layer` field carried by several block types:
        1..16   Trace layers (used in order, the last is always 16, e.g. 1,2,3,4,16)
        17      Silkscreen
        18..27  Unknown
        28      Board edges

    Encrypted (not de-xored) files carry a non-zero byte at 0x10
*/

// ---------------------------------------------------------------------------
// De-xor guard: a de-xored file has 0x00 at offset 0x10. If it doesn't, we
// can't parse it - print the size the data processor needs and stop.
// ---------------------------------------------------------------------------
if (std::mem::read_unsigned(0x10, 1) != 0x00) {
    std::print("Not de-xored!");
    u32 xored_data_length = std::mem::find_sequence(0, 0x76, 0x36, 0x76, 0x36, 0x35, 0x35, 0x35, 0x76, 0x36, 0x76, 0x36);
    if (xored_data_length == 0xFFFFFFFF) { // marker sequence not found
        xored_data_length = std::mem::size();
    }
    std::print("In data processor import the .hexnode and use {} as the size interger", xored_data_length);
    return;
};

u32 end_pos; // Scratch: end offset of the image & net blocks

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
struct file_header_s {
    char filetype_signature[11];
    padding[21];
    u32 header_addresses_size;
    u32 image_block_start; // Relative to 0x20
    u32 net_block_start;   // Relative to 0x20
    padding[20];
    u32 main_data_blocks_size;
};

// Size of the main data block stream (also mirrored inside the header). Placed
// on its own so main_block_s can read it as the stream's end bound.
u32 main_data_blocks_size @ 0x40;

// ---------------------------------------------------------------------------
// Main data block types
// ---------------------------------------------------------------------------

// 0x01 - Arcs
struct arc_s {
    u8 type_identifier_01;
    u32 block_size; // non-inclusive of type+size
    u32 layer;
    u32 x1;
    u32 y1;
    s32 r;
    s32 angle_start;
    s32 angle_end;
    s32 scale;
    s32 unknown_arc; // Havent seen not 0
};

// 0x02 - Vias
struct via_s {
    u8 type_identifier_02;
    u32 block_size_type_02; // non-inclusive of type+size
    s32 x;
    s32 y;
    s32 outer_radius;
    s32 inner_radius;
    u32 layer_a_index;
    u32 layer_b_index;
    u32 net_index;
    u32 via_text_length;
    char via_text[via_text_length];
};

// 0x03 - Seen but purpose unknown
struct unknown_03_s {
    u8 type_identifier_03;
    u32 block_size_type_03;
    u32 unknown; // Maybe net index? havent seen not 17
    u32 centre_x;
    u32 centre_y;
    u32 bl_corner_x; // Bottom left
    u32 bl_corner_y;
    u32 tr_corner_x; // Top right
    u32 tr_corner_y;
    u32 unknown2; // Havent seen not 0
    u32 unknown3; // Havent seen not 0
};

// 0x04 - Not seen; no known layout beyond the type byte
struct unhandled_04_s {
    u8 type_identifier_04;
};

// 0x05 - Line segments
struct segment_s {
    u8 type_identifier_05;
    u32 block_size; // non-inclusive of type+size
    u32 layer;
    s32 x1;
    s32 y1;
    s32 x2;
    s32 y2;
    s32 scale;
    u32 trace_net_index;
};

// 0x06 - Text
struct text_s {
    u8 type_identifier_06;
    u32 block_size; // non-inclusive of type+size
    u32 unknown_1;
    u32 pos_x;
    u32 pos_y;
    u32 text_size;
    u32 divider;
    u32 empty;
    u16 one;
    u32 text_length;
    char text[text_length];
};

// 0x07 - Parts & pads (opaque payload)
struct part_s {
    u8 type_identifier_07;
    u32 block_size;
    u8 data[block_size];
};

// 0x08 - Not seen; no known layout beyond the type byte
struct unhandled_08_s {
    u8 type_identifier_08;
};

// 0x09 - Test pad / drill hole
struct test_pad_s {
    u8 type_identifier_09;
    u32 block_size;
    u32 pad_number;
    u32 x_origin;
    u32 y_origin;
    u32 inner_diameter; // 0 if filled in
    u32 unknown1;
    u32 name_length;
    char name[name_length];
    u32 outer_width_1;
    u32 outer_height_1;
    u8 flag1;
    u32 outer_width_2;
    u32 outer_height_2;
    u8 flag2;
    u32 outer_width_3;
    u32 outer_height_3;
    u8 flag3;
    u32 unknown2;
    u8 flag4;
    u32 net_index;
    if (block_size > 61) {
        u32 reading_length;
        char reading[reading_length];
        padding[block_size - 60 - 4 - reading_length - name_length];
    }
};

// One entry in the main data block stream. Dispatches on the leading type byte;
// breaks out of the array once the stream is exhausted or an unknown tag shows.
struct main_block_s {
    if (std::mem::eof()) {
        break;
    }
    if ($ >= main_data_blocks_size + 0x44) { // Past the end of the main data blocks
        break;
    }

    if (std::mem::read_unsigned($, 4) == 0) {
        padding[4]; // Run of zero padding between blocks
    } else if ($[$] == 0x01) {
        arc_s ARC;
    } else if ($[$] == 0x02) {
        via_s VIA;
    } else if ($[$] == 0x03) {
        unknown_03_s type03; // Still unknown purpose
    } else if ($[$] == 0x04) {
        unhandled_04_s type04;
        std::error("Block type 0x04 found, no handling for this");
    } else if ($[$] == 0x05) {
        segment_s SEGMENT;
    } else if ($[$] == 0x06) {
        text_s TEXT;
    } else if ($[$] == 0x07) {
        part_s DATA;
    } else if ($[$] == 0x08) {
        unhandled_08_s type08;
        std::error("Block type 0x08 found, no handling for this");
    } else if ($[$] == 0x09) {
        test_pad_s TEST_PAD;
    } else {
        break;
    }
};

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
struct single_image {
    u8 type;
    u8 index; // incrementing from 0
    u8 flag;
    u32 size_x;
    u32 size_y;
    u32 name_length;
    char name[name_length];
};

struct images_block {
    u32 block_size;
    end_pos = $ + block_size;
    single_image image[while($ < end_pos)];
};

// ---------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------
struct single_net {
    u32 size; // inclusive
    u32 index; // incrementing from 1
    char name[size - 8];
};

struct net_block {
    u32 block_size;
    end_pos = $ + block_size;
    single_net net[while($ != end_pos)];
};

// ===========================================================================
// Trailing sections (v6v655 / post_v6)
//
// Everything below decodes the metadata that follows the nets block: the
// "v6v6555v6v6" marker and the diode/menu/signal/params sections. The parsing
// is complete but the placements at the very bottom are left commented out, so
// none of this runs by default. Enable them together when needed.
// ===========================================================================

// v6v6555v6v6 marker
struct v6v655 {
    char v6v655[11];
};

// Returns the number of separator/terminator bytes at the cursor that end a
// post_v6 record, or -1 if the record continues.
fn break_post_v6() {
    if (std::mem::size() == $ + seperator_string_length) {
        return seperator_string_length;
    }
    if (std::mem::read_string($ + seperator_string_length, seperator_string_length) == seperator_string) {
        // Double seperator
        return 2 * seperator_string_length;
    }
    if (std::mem::read_unsigned($, 6, 1) == 0x0D0A0D0A0D0A) {
        return 6;
    }
    if (std::mem::read_unsigned($, 5, 1) == 0x0D0A200D0A) {
        return 5;
    }
    return -1;
};

struct post_v6_signal {
    if (break_post_v6() != -1) {
        padding[break_post_v6()];
        break;
    }
    padding[seperator_string_length];
    char signal_name[while(std::mem::read_unsigned($, 1) != 0x3D)];
    padding[1]; // '='
    char new_signal_name[while(std::mem::read_string($, seperator_string_length) != seperator_string)];
};

struct post_v6_resistance {
    if (break_post_v6() != -1) {
        padding[break_post_v6()];
        break;
    }
    padding[seperator_string_length];
    padding[1]; // '='
    char resistance_reading[while(std::mem::read_unsigned($, 1) != 0x3D)];
    padding[1]; // '='
    char part_name[while(std::mem::read_unsigned($, 1) != 0x28)];
    padding[1]; // '('
    char pin_name[while(std::mem::read_unsigned($, 1) != 0x29)];
    padding[1]; // ')'
};

struct post_v6_menu {
    if (break_post_v6() != -1) {
        padding[break_post_v6()];
        break;
    }
    padding[seperator_string_length];
    char json_data[while(std::mem::read_unsigned($, 4, 1) != 0x0D0A0D0A)];
};

struct post_v6_params {
    if (break_post_v6() != -1) {
        padding[break_post_v6()];
        break;
    }
    if (std::mem::read_string($, seperator_string_length) == seperator_string) {
        padding[seperator_string_length];
    }
    char part_name[while(std::mem::read_unsigned($, 1) != 0x20)];
    padding[1];
    char part_comment[while(std::mem::read_unsigned($, 1) != 0x20)];
    padding[1];
    char part_pad_size[while(std::mem::read_string($, seperator_string_length) != seperator_string)];
};

struct post_v6_resistance_diagram {
    if (break_post_v6() != -1) {
        padding[break_post_v6()];
        break;
    }
    padding[seperator_string_length];
    char net_name[while(std::mem::read_unsigned($, 1) != 0x3D)];
    padding[1]; // =
    char reading[while(std::mem::read_string($, seperator_string_length) != seperator_string)];
};

struct post_v6_voltage {
    if (break_post_v6() != -1) {
        padding[break_post_v6()];
        break;
    }
    padding[seperator_string_length];
    char net_name[while(std::mem::read_unsigned($, 1) != 0x3D)];
    padding[1]; // =
    char voltage_reading[while(std::mem::read_string($, seperator_string_length) != seperator_string)];
};

// Record separator, discovered from the bytes at the cursor.
str seperator_string;
u8 seperator_string_length;
fn find_seperator() {
    u8 p = 0;
    while (p < 20) {
        if (std::mem::read_unsigned($ + p, 1, 1) == 0x0A) {
            seperator_string = "\x0A";
            seperator_string_length = 1;
            std::print("Seperator = 0x0A");
            break;
        } else if (std::mem::read_unsigned($ + p, 2, 1) == 0x0A0D) {
            seperator_string = "\x0A\x0D";
            seperator_string_length = 2;
            std::print("Seperator = 0x0A0D");
            break;
        } else if (std::mem::read_unsigned($ + p, 2, 1) == 0x0D0A) {
            seperator_string = "\x0D\x0A";
            seperator_string_length = 2;
            std::print("Seperator = 0x0D0A");
            break;
        } else if (std::mem::read_unsigned($ + p, 1, 1) == 0x0D) {
            seperator_string = "\x0D";
            seperator_string_length = 1;
            std::print("Seperator = 0x0D");
            break;
        } else {
            p += 1;
        }
    }
};

// Maps a GB2312-encoded section header to an English tag.
fn translate_string(str input) {
    if (input == "") {
        return "";
    } else if (input == "\xD7\xE8\xD6\xB5") {
        // 阻值 -> Resistance
        return "resistance";
    } else if (input == "\xD7\xE8\xD6\xB5\xCD\xBC") {
        // 阻值图 -> Resistance diagram
        return "resistance diagram";
    } else if (input == "\xD0\xC5\xBA\xC5") {
        // 信号 -> Signal
        return "signal";
    } else if (input == "\xB2\xCB\xB5\xA5") {
        // 菜单 -> Menu
        return "menu";
    } else if (input == "\xB5\xE7\xD1\xB9") {
        // 电压 -> Voltage
        return "voltage";
    } else {
        return "unknown tranlation!";
    }
};

u8 header_string_length;
str last_header_string;
str last_header_string_translated;
bool skip_loop;

fn read_v6_header_string_length() {
    u8 header_string_length = 0;
    if (std::mem::read_unsigned($, 3, 1) == 0x3D3D3D) {
        return 0;
    }
    while (std::mem::read_unsigned($ + header_string_length, 1, 1) != 0x0D
        && std::mem::read_unsigned($ + header_string_length, 1, 1) != 0x0A
        && std::mem::read_unsigned($ + header_string_length, 1, 1) != 0x20) {
        header_string_length += 1;
    }
    if (std::mem::read_unsigned($ + header_string_length, 1, 1) == 0x20) {
        return 0; // For the param type which doesnt have a header :/
    } else {
        return header_string_length;
    }
};

struct post_v6 {
    skip_loop = false;
    header_string_length = read_v6_header_string_length();
    if (header_string_length != 0) {
        char header_string[header_string_length];
        last_header_string = std::mem::read_string($, header_string_length);
        last_header_string_translated = translate_string(header_string);
        std::print("Found header string \'{}\'", last_header_string_translated);
        skip_loop = true;
    }

    if (std::mem::read_unsigned($, 3, 1) == 0x3D3D3D) {
        char seperator[3];
        skip_loop = true;
    }

    if (!skip_loop) {
        std::print("Last header string: {}", last_header_string_translated);
        if (last_header_string_translated == "") {
            // Params (No header string)
            std::print("Found params block");
            post_v6_params params[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "resistance") {
            std::print("Found resistance block");
            post_v6_resistance resistance[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "menu") {
            std::print("Found menu block");
            post_v6_menu menu[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "signal") {
            std::print("Found signal block");
            post_v6_signal signals[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "resistance diagram") {
            std::print("Found resistance diagram block");
            post_v6_resistance_diagram resistance_diagram[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "voltage") {
            std::print("Found voltage block");
            post_v6_voltage voltage[while(!std::mem::eof())];
        }
    }
};

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------
file_header_s header @ 0;
main_block_s main_data_block[while(!std::mem::eof())] @ $;
images_block images @ $;
net_block nets @ $;
