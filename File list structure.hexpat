#pragma endian little
#pragma pattern_limit 2000000
#pragma array_limit 200000

#include <std/core.pat>
#include <std/io.pat>
#include <std/mem.pat>

enum FileSystemEntryType : u32 {
    Folder    = 1,
    BoardView = 3,  // .pcb, .fz, .brd, .bv, .gr, .bdv, .cad, .tvw, .cst, .faz
    Pdf       = 4,  // .pdf
    Download  = 5,  // .zip, .rar, .bin
    WebLink   = 6,  // .com link labels
    Smt       = 13  // .smt (image)
};

enum NewItemFlag : u32 {
    Existing = 0,
    New      = 1
};

struct FileSystemEntry {
    char name[while($[$] != 0x00)];
    padding[1]; // NUL terminator

    u128 type_address = $;
    FileSystemEntryType type;
    if (!std::core::is_valid_enum(type)) {
        std::print(
            "New FileSystemEntryType {} at 0x{:X} for '{}'",
            u32(type), type_address, name
        );
    }
    padding[4]; // u32 unknown_1; always 1
    NewItemFlag new_item; // unknown why but comparing 2 versions figured this out
    padding[4]; // u32 unknown_3; always 0
    u32 depth;
} [[name(name)]];

struct RootFolder {
    FileSystemEntry root;
    FileSystemEntry descendants[
        while(!std::mem::eof() && $[$] != 0x7B)
    ];
} [[name(root.name)]];

RootFolder roots[while(!std::mem::eof())] @ 0x00;
