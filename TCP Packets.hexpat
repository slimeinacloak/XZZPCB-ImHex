#include <std/mem.pat>

#pragma endian little
#pragma loop_limit 1000000

enum FrameMagic : u32 {
    Transfer  = 0xEFFCFAFE,
    Alternate = 0x22A8056E
};

enum PacketType : u16 {
    ObfuscatedFileData = 0x05,
    CompressedData     = 0x06,
    FileData           = 0x07,
    DirectoryListing   = 0x0B,
    Unknown0E          = 0x0E,
    AdditionalMetadata = 0x1D
};

enum PayloadMagic : u32 {
    DirectoryData = 0x033E0F0D
};

fn find_obfuscation_prefix(u64 address, u64 size) {
    u64 offset = 0;
    while (offset + 7 <= size) {
        if (std::mem::read_unsigned(address + offset, 1) == 0xEE &&
            std::mem::read_unsigned(address + offset + 2, 1) == 0xFF &&
            std::mem::read_unsigned(address + offset + 4, 1) == 0xFF &&
            std::mem::read_unsigned(address + offset + 6, 1) == 0xEE) {
            return offset + 7;
        }
        offset += 1;
    }

    return 0;
};

struct ObfuscationTerminator {
    u8 marker_ee_0;
    u8 unknown_0;
    u8 marker_ff_0;
    u8 unknown_1;
    u8 marker_ff_1;
    u8 unknown_2;
    u8 marker_ee_1;
};

struct ObfuscatedChunk<auto Size> {
    u64 prefix_size = find_obfuscation_prefix($, Size) [[export]];

    if (prefix_size > 0) {
        if (prefix_size > 7) {
            u8 random_prefix[prefix_size - 7];
        }
        ObfuscationTerminator prefix_terminator;
        if (Size > prefix_size) {
            u8 file_data[Size - prefix_size];
        }
    } else if (Size > 0) {
        u8 file_data[Size];
    }
};

struct DirectoryPayload<auto Size> {
    PayloadMagic magic;
    u32 uncompressed_size;
    if (Size > 8) {
        u8 compressed_data[Size - 8];
    }
};

struct PacketPayload<auto Type, auto Size> {
    if (Size >= 8 &&
        std::mem::read_unsigned($, 4, std::mem::Endian::Little) == PayloadMagic::DirectoryData) {
        DirectoryPayload<Size> directory_data;
    } else if (Type == PacketType::ObfuscatedFileData) {
        ObfuscatedChunk<Size> obfuscated_file_data;
    } else if (Type == PacketType::AdditionalMetadata) {
        char utf8_text[Size];
    } else if (Size > 0) {
        u8 data[Size];
    }
};

struct DataEnvelope<auto Type, auto StoredSize> {
    char md5_ascii[32];
    u32 data_size;
    bool size_matches_frame = data_size == StoredSize [[export]];

    if (data_size <= StoredSize) {
        if (data_size > 0) {
            PacketPayload<Type, data_size> payload;
        }
        if (StoredSize > data_size) {
            u8 frame_trailer[StoredSize - data_size];
        }
    } else if (StoredSize > 0) {
        u8 truncated_payload[StoredSize];
    }
};

struct TransferFrame<auto BlockSize> {
    PacketType packet_type;
    u16 packet_id;
    u32 total_content_size;

    if (BlockSize == 16) {
        // The final field is a Unix timestamp in zero-payload control frames.
        u32 unix_timestamp;
    } else {
        u32 content_offset_1_based;
        if (BlockSize >= 52) {
            DataEnvelope<packet_type, BlockSize - 52> data;
        } else {
            u8 malformed_data_header[BlockSize - 16];
        }
    }
};

struct AlternateFrame<auto BlockSize> {
    be u32 secondary_magic;
    if (BlockSize > 8) {
        u8 data[BlockSize - 8];
    }
};

struct TcpPacket {
    if ($ + 8 > sizeof($)) {
        u8 truncated_header[sizeof($) - $];
        break;
    } else {
        // block_size includes the magic and body, but not its own u32 field.
        u32 block_size;
        be FrameMagic magic;

        if (block_size < 4) {
            bool valid_block_size = false [[export]];
            if ($ < sizeof($)) {
                u8 unparsed_data[sizeof($) - $];
            }
            break;
        } else {
            u64 body_size = block_size - 4;
            u64 available_size = sizeof($) - $;

            if (body_size > available_size) {
                bool complete = false [[export]];
                if (available_size > 0) {
                    u8 truncated_body[available_size];
                }
                break;
            } else {
                bool complete = true [[export]];
                match (magic) {
                    (FrameMagic::Transfer): {
                        if (block_size >= 16) {
                            TransferFrame<block_size> transfer;
                        } else if (body_size > 0) {
                            u8 malformed_transfer_body[body_size];
                        }
                    }
                    (FrameMagic::Alternate): {
                        if (block_size >= 8) {
                            AlternateFrame<block_size> alternate;
                        } else if (body_size > 0) {
                            u8 malformed_alternate_body[body_size];
                        }
                    }
                    (_): {
                        if (body_size > 0) {
                            u8 unknown_body[body_size];
                        }
                    }
                }
            }
        }
    }
};

TcpPacket packets[while(!std::mem::eof())] @ 0x00;
