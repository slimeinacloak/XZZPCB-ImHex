#pragma pattern_limit 6000000

#include <std/mem.pat>
#include <std/string.pat>

u32 end_pos; // Temp value used for image & net blocks
u32 xored_data_length;
if (std::mem::read_unsigned(0x10, 1) != 0x00) {
    std::print("Not de-xored!");
    xored_data_length = std::mem::find_sequence(0, 0x76, 0x36, 0x76, 0x36, 0x35, 0x35, 0x35, 0x76, 0x36, 0x76, 0x36);
    if (xored_data_length == 4294967295) {
        xored_data_length = std::mem::size();
    }
    std::print("In data processor import the .hexnode and use {} as the size interger", xored_data_length);
    return;
};

/**
File header

Blocks identified by a u8
0x01 -> Arcs
0x02 -> Vias
0x03 -> Seen but known yet
0x04 -> Not seen
0x05 -> Line segments
0x06 -> Text
0x07 -> PART & PADS
0x08 -> Not seen
0x09 -> Test pads/Drill holes12

Image block size (Can be 0)
Images
Nets
v6v6555v6v6
Diode readings, menu, signal names, part params 
*/


u32 main_data_blocks_size @ 0x40;

struct file_header_s {
    char filetype_signature[11];
    padding[21];
    u32 header_addresses_size;
    u32 image_block_start; // Relative to 0x20
    u32 net_block_start; // Relative to 0x20
    padding[20];
    u32 main_data_blocks_size;
};

/**
Layers:
    1->16   Trace Layers (Used in order excluding last which always uses 16, ie 1,2,3,4,16)
    17      Silkscreen
    18->27  Unknown
    28      Board edges 
*/

// Arcs
struct type_01 {
    u8 type_identifier_01;
    u32 block_size; // non-inclusive of type+size
    u32 layer;
    u32 x1;
    u32 y1;
    s32 r;
    s32 angle_start;
    s32 angle_end;
    s32 line_width;
    padding[4]; // Always 0, no visible change
};

// Vias
struct type_02 {
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

// Seen but unknown purpose
struct type_03 {
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

// Not seen
struct type_04 {
    u8 type_identifier_04;
};

// Line Segment
struct type_05 {
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

// Text
struct type_06 {
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

// Part/pads

// Part sub type -> Line Segment (0x05)
struct part_sub_type_05 {
    u8 part_sub_type_identifier_05;
    u32 block_size;
    u32 layer; // Always 17 (silkscreen) so far
    u32 x1;
    u32 y1;
    u32 x2;
    u32 y2;
    u32 scale;
    padding[4]; // no visible change
};

// Part sub type -> Labels/Part Names (0x06)
struct part_sub_type_06 {
    u8 part_sub_type_identifier_06;
    u32 block_size;
    u32 layer; // Always 17 (silkscreen) so far
    u32 x;
    u32 y;
    u32 font_size;
    u32 font_scale;
    u32 text_rotation; // 900k, no visible change?
    bool visibility; // 01 = Hidden, 02 = Visible
    u8 ps06_flag2; // 0 or 1? Unknown purpose
    u32 label_size;
    char type_06_label[label_size];
};

// Part sub type -> Pins (0x09)
enum PinOutlineType : u8 {
    NoneOrEnd, // 0x00
    Circular, // 0x01
    Rectangular // 0x02
};

struct pin_outline {
    if (std::mem::read_unsigned($, 4, 1) == 0 && std::mem::read_unsigned($+4, 1, 1) == 0) {
        u32 outline_end_u32;
        PinOutlineType pin_outline_type;
        break;
    } else {
        u32 pin_outline_x;
        u32 pin_outline_y;
        PinOutlineType pin_outline_type; // 0x00 -> none/end, 0x01 -> circular, 0x02 -> rectangular
    }
};

u32 temp;
struct part_sub_type_09 {
    u8 part_sub_type_identifier_09;
    u32 part_sub_type_09_block_size;
    u32 layer_index; // 0 for not rendered
    u32 pin_x;
    u32 pin_y;
    padding[4]; // no visible change
    u32 pin_name_scale; // no visible change
    u32 pin_name_size;
    char pin_name[pin_name_size];
    
    pin_outline pin_outline[4];
    
    temp = part_sub_type_09_block_size-sizeof(this)+5-12;
    padding[temp];
    if (temp != 0) {
        std::print(std::string::to_string(temp));
    }
    u32 net_index;
    padding[8];
};

// Part/pad main block
struct type_07 {
    u8 type_identifier_07;
    u32 part_block_size; // includes padding at end of block - not self inclusive
    
    u32 part_size; // doesnt include padding at end of block - not self inclusive?
    padding[4]; // all 1, no visible change
    u32 part_x;
    u32 part_y;
    u32 part_rotation; // only visible change when clicked on - degree*10000
    bool part_label_visible; // duplicate value?
    u8 flag2; // all 0
    u32 footprint_label_length;
    char footprint_label[footprint_label_length];
    
    part_sub_type_06 subtype06[while($[$] == 0x06)]; // Line Segment
    part_sub_type_05 subtype05[while($[$] == 0x05)]; // Labels/Part Names
    part_sub_type_09 subtype09[while($[$] == 0x09)]; // Pins
     
    padding[part_block_size-sizeof(this)+5];
}; 

// Not seen
struct type_08 {
    u8 type_identifier_08;
};

// Test pad/drill hole
struct type_09 {
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
        padding[block_size-60-4-reading_length-name_length];
    }
}; 

struct main_data_block {
    if (std::mem::eof()) {
        break;
    }
    if ($ >= main_data_blocks_size + 0x44) { // Main data block over
        break;
    }
    
    if (std::mem::read_unsigned($, 4) == 0) {
        padding[4];
    } else if ($[$]  == 0x01) {
        type_01 ARC;
    } else if ($[$] == 0x02) {
        type_02 VIA;
    } else if ($[$] == 0x03) {
        type_03 type03; // Still unknown purpose
    } else if ($[$] == 0x04) {
        type_04 type04;
        std::error("Block type 0x04 found, no handling for this");
    } else if ($[$] == 0x05) {
        type_05 SEGMENT;
    } else if ($[$] == 0x06) {
        type_06 TEXT;    
    } else if ($[$] == 0x07) {
        type_07 DATA;
    } else if ($[$] == 0x08) {
        type_08 type08;
        std::error("Block type 0x08 found, no handling for this");
    } else if ($[$] == 0x09) {
        type_09 TEST_PAD;
    } else {
        break;
    }
};

// Images
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
    u32 image_block_size;
    end_pos = $ + image_block_size;
    single_image image[while($ < end_pos)];
};
 
// Nets
struct single_net {
    u32 size; // inclusive
    u32 index; // incrementing from 1
    char name[size-8];
};

struct net_block {
    u32 net_block_size;
    end_pos = $ + net_block_size;
    single_net net[while($ != end_pos)];
}; 

// v6v6555v6v6
struct v6v655 {
    char v6v655[11];
};

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

str seperator_string;
u8 seperator_string_length;
fn find_seperator() {
    u8 p = 0;
    while (p<20) {
        if (std::mem::read_unsigned($+p, 1, 1) == 0x0A) {
            seperator_string = "\x0A";
            seperator_string_length = 1;
            std::print("Seperator = 0x0A");
            break;
        } else if (std::mem::read_unsigned($+p, 2, 1) == 0x0A0D) {
            seperator_string = "\x0A\x0D";
            seperator_string_length = 2;
            std::print("Seperator = 0x0A0D");
            break;
        } else if (std::mem::read_unsigned($+p, 2, 1) == 0x0D0A) {
            seperator_string = "\x0D\x0A";
            seperator_string_length = 2;
            std::print("Seperator = 0x0D0A");
            break;
        } else if (std::mem::read_unsigned($+p, 1, 1) == 0x0D) {
            seperator_string = "\x0D";
            seperator_string_length = 1;
            std::print("Seperator = 0x0D");
            break;
        } else {
            p += 1;
        }
    }
};

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
    while (std::mem::read_unsigned($+header_string_length, 1, 1) != 0x0D
    && std::mem::read_unsigned($+header_string_length, 1, 1) != 0x0A
    && std::mem::read_unsigned($+header_string_length, 1, 1) != 0x20) {
        header_string_length += 1;
        
    }
    if (std::mem::read_unsigned($+header_string_length, 1, 1) == 0x20) {
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
            // resistance
            std::print("Found resistance block");
            post_v6_resistance resistance[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "menu") {
            // menu
            std::print("Found menu block");
            post_v6_menu menu[while(!std::mem::eof())];
        } 
        if (last_header_string_translated == "signal") {
            // signal
            std::print("Found signal block");
            post_v6_signal signals[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "resistance diagram") {
            // resistance diagram
            std::print("Found resistance diagram block");
            post_v6_resistance_diagram resistance_diagram[while(!std::mem::eof())];
        }
        if (last_header_string_translated == "voltage") {
            // voltage
            std::print("Found voltage block");
            post_v6_voltage voltage[while(!std::mem::eof())];
        }
    }
};

///////////////////////////////////

file_header_s header @ 0;
main_data_block main_data_block[while(!std::mem::eof())] @ $;
//main_data_block main_data_block[104] @ $;
images_block images @ header.image_block_start + 0x20;
net_block nets @ header.net_block_start + 0x20;
//if (std::mem::eof()) { // To handle files without v6v655
//    return; 
//}
//v6v655 v6v655 @ $;
//find_seperator();
//post_v6 post_v6[while(!std::mem::eof())] @ $;