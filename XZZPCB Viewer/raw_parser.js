/* raw_parser.js
 * Parser for raw PCB files based on the ImHex pattern structure
 * Handles binary data directly instead of pre-processed JSON
 */

class RawPCBParser {
  constructor() {
    this.dataView = null;
    this.offset = 0;
    this.mainDataBlocksSize = 0;
    
    this.MASTER_KEY = "DCFC12AC00000000";
  }

  // Helper method to convert hex string to bytes
  hexToBytes(hexString) {
    const bytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return bytes;
  }

  // DES decryption method based on HTML file
  decryptWithDES(encryptedData) {
    // Check if CryptoJS is available
    if (typeof CryptoJS === 'undefined') {
      throw new Error('CryptoJS is not available. Please include the CryptoJS library before using this parser.');
    }
    
    // Helper: Uint8Array -> CryptoJS WordArray (big-endian words)
    const u8ToWordArray = (u8) => {
      const words = [];
      for (let i = 0; i < u8.length; i++) {
        words[i >>> 2] |= u8[i] << (24 - (i % 4) * 8);
      }
      return CryptoJS.lib.WordArray.create(words, u8.length);
    };

    // Helper: CryptoJS WordArray -> Uint8Array (respect sigBytes)
    const wordArrayToU8 = (wordArray) => {
      const { words, sigBytes } = wordArray;
      const u8 = new Uint8Array(sigBytes);
      for (let i = 0; i < sigBytes; i++) {
        u8[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
      }
      return u8;
    };

    // Convert hex key to bytes then to WordArray
    const keyBytes = this.hexToBytes(this.MASTER_KEY);
    const keyWA = CryptoJS.lib.WordArray.create(keyBytes);

    // Convert encrypted bytes directly to WordArray to avoid large apply()
    const cipherWA = u8ToWordArray(encryptedData);

    // Decrypt using DES in ECB mode with PKCS7 padding (padding removed by CryptoJS)
    const decryptedWA = CryptoJS.DES.decrypt({ ciphertext: cipherWA }, keyWA, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    });

    // Convert to Uint8Array honoring sigBytes
    const decryptedBytes = wordArrayToU8(decryptedWA);
    return decryptedBytes;
  }

  // Parse file header structure
  parseFileHeader() {
    // Print the first 0x50 bytes of this.dataView as space-separated hex bytes
    let bytesStr = "";
    for (let i = 0; i < 0x50 && i < this.dataView.byteLength; i++) {
      const b = this.dataView.getUint8(i);
      bytesStr += b.toString(16).padStart(2, '0') + (i < 0x50 - 1 && i < this.dataView.byteLength - 1 ? " " : "");
    }
    console.log(bytesStr);
    const headerAddressesSize = this.dataView.getUint32(0x20, true);
    const imageBlockStart = this.dataView.getUint32(0x24, true);
    const netBlockStart = this.dataView.getUint32(0x28, true);
    const mainDataBlocksSize = this.dataView.getUint32(0x40, true);
    // console.log(`parseFileHeader: headerAddressesSize: ${headerAddressesSize}`);
    // console.log(`parseFileHeader: imageBlockStart: ${imageBlockStart}`);
    // console.log(`parseFileHeader: netBlockStart: ${netBlockStart}`);
    // console.log(`parseFileHeader: mainDataBlocksSize: ${mainDataBlocksSize}`);
    this.mainDataBlocksSize = mainDataBlocksSize;
    this.offset = 0x44;
  }

  // Helper method to find sequence in array
  findSequence(array, sequence) {
    for (let i = 0; i <= array.length - sequence.length; i++) {
      let found = true;
      for (let j = 0; j < sequence.length; j++) {
        if (array[i + j] !== sequence[j]) {
          found = false;
          break;
        }
      }
      if (found) {
        return i;
      }
    }
    return -1; // Sequence not found
  }

  // Parse main data blocks
  parseMainDataBlocks() {
    const blocks = [];
    const startOffset = this.offset;
    console.log(`parseMainDataBlocks: startOffset: ${startOffset}`);
    const endOffset = startOffset + this.mainDataBlocksSize;
    console.log(`parseMainDataBlocks: endOffset: ${endOffset}`);
    
    while (this.offset < endOffset && this.offset < this.dataView.byteLength) {
      // Check for end of data
      if (this.offset >= endOffset) break;
      
      // Check for padding (4 zero bytes)
      const paddingCheck = this.dataView.getUint32(this.offset, true);
      if (paddingCheck === 0) {
        this.offset += 4;
        continue;
      }

      // Read block type
      const blockType = this.dataView.getUint8(this.offset);
      this.offset += 1;
      
      let block;
      switch (blockType) {
        case 0x01:
          block = this.parseType01(); // ARC
          break;
        case 0x02:
          block = this.parseType02(); // VIA
          break;
        case 0x03:
          block = this.parseType03(); // Unknown
          break;
        case 0x04:
          console.log('Skipping type 0x04 block (1 byte)');
          this.offset += 1; // Skip one byte (no block_size field in pattern)
          break;
        case 0x05:
          block = this.parseType05(); // SEGMENT
          break;
        case 0x06:
          block = this.parseType06(); // TEXT
          break;
        case 0x07:
          block = this.parseType07(); // DATA
          break;
        case 0x08:
          console.warn('Block type 0x08 found, no handling for this');
          this.offset += 1; // Skip one byte
          break;
        case 0x09:
          block = this.parseType09(); // TEST_PAD
          break;
        default:
          console.warn(`Unknown block type: 0x${blockType.toString(16)} at offset ${this.offset}`);
          break;
      }
      
      if (block) {
        blocks.push(block);
      }
    }
    
    return blocks;
  }

  // Parse ARC (type 0x01)
  parseType01() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const layer = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const x1 = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const y1 = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const r = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const angleStart = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const angleEnd = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const scale = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const unknownArc = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    return {
      ARC: {
        layer,
        x1,
        y1,
        r,
        angle_start: angleStart,
        angle_end: angleEnd,
        scale,
        unknown_arc: unknownArc
      }
    };
  }

  // Parse VIA (type 0x02)
  parseType02() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const x = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const y = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const outerRadius = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const innerRadius = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const layerAIndex = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const layerBIndex = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const netIndex = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const viaTextLength = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    // Read via text
    const viaText = this.readString(viaTextLength);
    
    return {
      VIA: {
        x,
        y,
        outer_radius: outerRadius,
        inner_radius: innerRadius,
        layer_a_index: layerAIndex,
        layer_b_index: layerBIndex,
        net_index: netIndex,
        via_text: viaText
      }
    };
  }

  // Parse unknown type (0x03) - SKIPPED
  parseType03() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    // Skip the entire block data
    this.offset += blockSize;
    
    console.log(`Skipped type 0x03 block, size: ${blockSize} bytes`);
    return {}; // Return empty object
  }

  // Parse SEGMENT (type 0x05)
  parseType05() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const layer = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const x1 = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const y1 = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const x2 = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const y2 = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const scale = this.dataView.getInt32(this.offset, true);
    this.offset += 4;
    
    const traceNetIndex = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    return {
      SEGMENT: {
        layer,
        x1,
        y1,
        x2,
        y2,
        scale,
        trace_net_index: traceNetIndex
      }
    };
  }

  // Parse TEXT (type 0x06)
  parseType06() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const unknown1 = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const posX = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const posY = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const textSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const divider = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const empty = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    const one = this.dataView.getUint16(this.offset, true);
    this.offset += 2;
    
    const textLength = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    // Read text
    const text = this.readString(textLength);
    
    return {
      TEXT: {
        unknown_1: unknown1,
        pos_x: posX,
        pos_y: posY,
        text_size: textSize,
        divider,
        empty,
        one,
        text_length: textLength,
        text
      }
    };
  }

  // Parse DATA (type 0x07) - decrypt the data and parse with PartDataParser
  parseType07() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    // Read the encrypted data
    const encryptedData = new Uint8Array(this.dataView.buffer, this.dataView.byteOffset + this.offset, blockSize);
    this.offset += blockSize;
    
    // console.log(`parseType07: Processing ${blockSize} bytes of encrypted data`);
    // console.log('First 16 bytes of encrypted data:', Array.from(encryptedData.slice(0, 16)));
    
    // Decrypt the data
    let decryptedData;
    try {
      decryptedData = this.decryptWithDES(encryptedData);
      // console.log('Decryption successful');
      // console.log('First 16 bytes of decrypted data:', Array.from(decryptedData.slice(0, 16)));
    } catch (error) {
      console.error('Decryption failed:', error);
      decryptedData = encryptedData; // Fallback to original data
    }
    
    // Parse the decrypted data using PartDataParser
    let parsedData = null;
    try {
      // Check if PartDataParser is available
      if (typeof PartDataParser !== 'undefined') {
        const partDataParser = new PartDataParser();
        parsedData = partDataParser.parse(decryptedData.buffer);
        // console.log('Type07 parsing successful:', parsedData);
      } else {
        console.warn('PartDataParser not available, returning raw decrypted data');
      }
    } catch (error) {
      console.error('PartData parsing failed:', error);
    }
    
    return {
      DATA: {
        block_size: blockSize,
        encrypted_data: Array.from(encryptedData),
        decrypted_data: Array.from(decryptedData),
        parsed_data: parsedData
      }
    };
  }

  // Parse TEST_PAD (type 0x09) - SKIPPED
  parseType09() {
    const blockSize = this.dataView.getUint32(this.offset, true);
    this.offset += 4;
    
    // Skip the entire block data
    this.offset += blockSize;
    
    console.log(`Skipped type 0x09 block, size: ${blockSize} bytes`);
    return {}; // Return empty object
  }

  // Helper method to read strings
  readString(length) {
    const decoder = new TextDecoder('utf-8');
    const stringBytes = new Uint8Array(this.dataView.buffer, this.dataView.byteOffset + this.offset, length);
    this.offset += length;
    return decoder.decode(stringBytes);
  }

  // Main parsing method
  parse(arrayBuffer) {
    this.dataView = new DataView(arrayBuffer);
    this.offset = 0;

    // XOR decryption logic for input array
    if (this.dataView.getUint8(0x10) !== 0x00) {
      console.log("Applying XOR decryption");
      const sequence = [0x76, 0x36, 0x76, 0x36, 0x35, 0x35, 0x35, 0x76, 0x36, 0x76, 0x36];
      const sequenceIndex = this.findSequence(this.dataView, sequence);
      
      let xoredDataLength;
      if (sequenceIndex !== -1) {
        xoredDataLength = sequenceIndex;
      } else {
        xoredDataLength = this.dataView.byteLength;
      }

      const xorKey = this.dataView.getUint8(0x10);
      
      // XOR array byte by byte for xoredDataLength
      for (let i = 0; i < xoredDataLength; i++) {
        this.dataView.setUint8(i, this.dataView.getUint8(i) ^ xorKey);
      }
      
      console.log(`Applied XOR decryption with key 0x${xorKey.toString(16)}, length: ${xoredDataLength}`);
    }

    // Parse file header
    this.parseFileHeader();

    const blocks = this.parseMainDataBlocks();
    
    return {
      main_data_block: blocks
    };
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RawPCBParser;
}
