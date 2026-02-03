#include <std/mem.pat>
#include <std/string.pat>
#pragma loop_limit 1000000

u16 last_packet_type;
u32 last_data_size;
u32 padding_length;
fn find_padding_end() {
    padding_length = 0;
    u32 p = 0;
    while (p<last_data_size) {
        // std::print(std::string::to_string(p));
        // not pretty but doing a big () && () && () && () is less pretty so...
        if (std::mem::read_unsigned($+p, 1, 1) == 0xEE) {
            if (std::mem::read_unsigned($+p+2, 1, 1) == 0xFF) {
                if (std::mem::read_unsigned($+p+4, 1, 1) == 0xFF) {
                    if (std::mem::read_unsigned($+p+6, 1, 1) == 0xEE) {
                        padding_length = p+7;
                        break;
                    }
                }
            }
        }
        p += 1;
    }
};

struct tcp_block_with_data {
    if ($ + 32 > sizeof($)) {
        break;
    }
    char md5[32];
    u32 data_size;
    last_data_size = data_size;
    std::print("Last data size: {}", std::string::to_string(last_data_size));
    if (std::mem::read_unsigned($,4,2) == 0x033E0F0D) { // DirectoryManage::ReceivedDownloadData
        u32 hard_coded_filestructure_header;
        u32 uncompressed_data_size;
        padding[data_size-8];
    } else if (last_packet_type == 0x05) {
        // ONLY FOR XORED PARTS:
        // padding at start of each packet ends with EE XX FF XX FF XX EE
        // function returns 0 if cant find in the block so works for other parts :shrug: this is fucked
        find_padding_end();
        std::print("Padding thing length: {}", std::string::to_string(padding_length));
        char padding_thing[padding_length];
        padding[data_size-padding_length];
    } else {
        padding[data_size];
    }
};

struct tcp_EFFCFAFE {
    u32 block_size;
    u32 effcfafe;
    u16 packet_type; // ClientManage::parseFile switch
    last_packet_type = packet_type;
    // 5/0x05 -> PCB? XORed data?
    // 6/0x06 -> Compressed data
    // 7/0x07 -> PDF? non XORed data?
    // 29/0x1D -> At end of PCB json extra data
    if (packet_type == 0x06) {
        std::print("Compressed data ie pdf passwords");
    } else if (packet_type == 0x07) {
        std::print("pcb/pdf packet");
    } else if (packet_type == 0x0b) {
        std::print("File structure packet {}", std::string::to_string($));
    } else if (packet_type == 0x05) {
        std::print("Switch case breaks");
    } else if (packet_type == 0x0e) {
        std::print("Unknown purpose {}", std::string::to_string($));
    } else {
        std::print("Unknown case {}", std::string::to_string($));
    }
    u16 packet_id;
    u32 total_size_of_content; // changes when hits v6v6555v6v6
    u32 bytes_sent_of_content; // bytes since start of file? counts up then resets
    if (block_size > 16) {
        tcp_block_with_data block_data;
    }
};


struct tcp_22A8056E {
    u32 block_size;
    u32 h_22A8056E;
    u32 h_67307C6E;
    padding[block_size-8];
};

struct tcp_block {
    if (std::mem::read_unsigned($+4,4,1) == 0x22A8056E) {
        tcp_22A8056E block;
    } else if (std::mem::read_unsigned($+4,4,1) == 0xEFFCFAFE) {
        tcp_EFFCFAFE block;
    } else {
        std::print(std::string::to_string($));
        break;
    }
};

tcp_block blocks[while(!std::mem::eof())] @ $;
// tcp_block blocks[4] @ $;