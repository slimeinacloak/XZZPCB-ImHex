import binascii
import json
import os
import re
import struct
import time
import traceback
from datetime import datetime

from Crypto.Cipher import DES
from Crypto.Util.Padding import unpad

import argparse
import logging


class ObdataError(Exception):
    """A PCB file could not be parsed into .obdata."""


logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("obdata")

# Diagnostic scratch files (broken_files.txt / bitmap_data_files.txt) go here,
# next to this script.
CONFIG_FOLDER_PATH = os.path.dirname(os.path.abspath(__file__))

MASTER_KEY = "DCFC12AC00000000"


def hex_to_bytes(hex_string):
    return binascii.unhexlify(hex_string)


def decrypt_with_des(encrypted_data):
    key = hex_to_bytes(MASTER_KEY)
    des = DES.new(key, DES.MODE_ECB)
    decrypted_data = des.decrypt(encrypted_data)

    # Unpad the data if it's padded with PKCS7
    try:
        decrypted_data = unpad(decrypted_data, DES.block_size)
    except ValueError:
        # If unpadding fails, no padding was used
        pass

    return decrypted_data


def get_net_block_end(data):
    data = bytearray(data)
    net_block_start = struct.unpack("<I", data[0x28:0x2C])[0] + 32
    net_block_length = struct.unpack("<I", data[net_block_start : net_block_start + 4])[
        0
    ]
    net_block_end = net_block_start + net_block_length + 4
    return net_block_end


def de_xor_data(data):
    data = bytearray(data)
    key = data[0x10]

    header_block = bytearray(a ^ key for a in data[:0x40])
    image_block_start = struct.unpack("<I", header_block[0x24:0x28])[0] + 32
    net_block_start = struct.unpack("<I", header_block[0x28:0x2C])[0] + 32

    net_block_length = struct.unpack(
        "<I", bytearray(a ^ key for a in data[net_block_start : net_block_start + 4])
    )[0]

    net_block_end = net_block_start + net_block_length + 4
    log.debug(f"Net block end: {net_block_end}, data length: {len(data)}")
    return bytearray(a ^ key for a in data[:net_block_end]) + data[net_block_end:]


def extract_encrypted_blocks(data):
    data = bytearray(data)
    encrypted_blocks = []

    current_pointer = 0x40
    main_data_blocks_size = struct.unpack(
        "<I", data[current_pointer : current_pointer + 4]
    )[0]
    current_pointer += 4

    while current_pointer < 0x44 + main_data_blocks_size:
        block_type = data[current_pointer : current_pointer + 1]
        current_pointer += 1
        block_size = struct.unpack("<I", data[current_pointer : current_pointer + 4])[0]
        current_pointer += 4
        if block_type == b"\x07":
            encrypted_blocks.append(
                data[current_pointer : current_pointer + block_size]
            )
            current_pointer += block_size
        else:
            current_pointer += block_size
    return encrypted_blocks


def extract_part_blocks(data):
    encrypted_blocks = extract_encrypted_blocks(data)
    blocks = []
    for block in encrypted_blocks:
        decrypted_data = decrypt_with_des(block)
        blocks.append(decrypted_data)
    return blocks


def translate_bytes(input_bytes):
    # The PCB tool encodes text as GB2312; gb18030 is a backward-compatible
    # superset that decodes it (ASCII passes through, unmappable bytes -> U+FFFD).
    return bytes(input_bytes).decode("gb18030", errors="replace")


def return_json(sub_section_data):
    while sub_section_data.endswith(b"\x0a") or sub_section_data.endswith(b"\x0d"):
        sub_section_data = sub_section_data[:-1]
    sub_section_data = translate_bytes(sub_section_data)
    return json.loads(sub_section_data)


def return_diode_readings(sub_section_data):
    regex = r"=([^=]*)=([^=]+)\(([^)]+)\)"
    regex2 = r"^([^=]+)=([^=]+)$"

    diode_readings = {}
    lines = translate_bytes(sub_section_data).split("\n")
    for line in lines:
        line = line.strip()
        match = re.match(regex, line)
        if match:
            value, key1, key2 = match.groups()
            if key1 not in diode_readings:
                diode_readings[key1] = {}
            diode_readings[key1][key2] = value
        else:
            match = re.match(regex2, line)
            if match:
                key, value = match.groups()
                diode_readings[key] = value
    return diode_readings


def return_signal(sub_section_data):
    regex = r"^([^=]+)=(.+)$"

    signal_data = {}
    lines = translate_bytes(sub_section_data).split("\n")
    for line in lines:
        line = line.strip()
        if line == "":
            continue
        match = re.match(regex, line)
        if match:
            key, value = match.groups()
            signal_data[key] = value
        else:
            log.debug(f"regex didnt match: {line}")
    return signal_data


def return_part_data(sub_section_data):
    part_data = {}
    lines = translate_bytes(sub_section_data)
    regex = r"([^\s]+)\s+([^\s]+)\s+(.+)$"
    for line in lines.split("\n"):
        line = line.strip()
        match = re.match(regex, line)
        if match:
            key, value, description = match.groups()
            part_data[key] = {"line_description": value, "part_pad_size": description}
    return part_data


def return_voltage(sub_section_data):
    voltage_data = {}
    lines = translate_bytes(sub_section_data)
    regex = r"^([^=]+)=([^=]+)$"
    for line in lines.split("\n"):
        line = line.strip()
        match = re.match(regex, line)
        if match:
            key, value = match.groups()
            voltage_data[key] = value
    return voltage_data


def return_resistance_diagram(sub_section_data):
    resistance_diagram_data = {}
    lines = translate_bytes(sub_section_data)
    regex = r"^([^=]+)=([^=]+)$"
    for line in lines.split("\n"):
        line = line.strip()
        match = re.match(regex, line)
        if match:
            key, value = match.groups()
            resistance_diagram_data[key] = value
    return resistance_diagram_data


def return_schematic(sub_section_data):
    schematic_data = translate_bytes(sub_section_data)
    schematic_data = schematic_data.strip()
    return schematic_data


def combine_data(file_name, sub_section_data_list, header_list):
    data_list = []
    for index, (sub_section_data, header) in enumerate(
        zip(sub_section_data_list, header_list)
    ):
        if header not in sub_header_types:
            raise ObdataError(
                f"Header not found in {file_name}: {header!r} "
                f"(translated: {translate_bytes(header)})"
            )

        match sub_header_types[header]:
            case "PCB Attachment":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_json(sub_section_data),
                    }
                )
            case "Signal":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_signal(sub_section_data),
                    }
                )
            case "RFFE":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_json(sub_section_data),
                    }
                )
            case "Resistance":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_diode_readings(sub_section_data),
                    }
                )
            case "Voltage":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_voltage(sub_section_data),
                    }
                )
            case "Part data":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_part_data(sub_section_data),
                    }
                )
            case "Resistance diagram":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_resistance_diagram(sub_section_data),
                    }
                )
            case "Schematic":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_schematic(sub_section_data),
                    }
                )
            case "Resistance table":
                data_list.append(
                    {
                        "header": sub_header_types[header],
                        "data": return_diode_readings(sub_section_data),
                    }
                )

    combined_data = {}
    for data in data_list:
        if data["header"] not in combined_data:
            combined_data[data["header"]] = data["data"]
        else:
            raise ObdataError(f"Duplicate header: {data['header']} in {file_name}")

    return combined_data


def find_data_section(data, main_header):
    pos = data.find(main_header)
    if pos == -1:
        return None
    pos += len(main_header)
    return data[pos:]


def extract_net_index_map(data):
    net_block_start = struct.unpack("<I", data[0x28:0x2C])[0] + 0x20
    pos = net_block_start
    net_block_size = struct.unpack("<I", data[pos : pos + 4])[0]
    pos += 4
    net_index_map = {}
    while pos < net_block_start + net_block_size:
        net_data_size = struct.unpack("<I", data[pos : pos + 4])[0]
        pos += 4
        net_index = struct.unpack("<I", data[pos : pos + 4])[0]
        pos += 4
        net_name_size = net_data_size - 8
        net_name = translate_bytes_failover(data[pos : pos + net_name_size])
        net_index_map[net_index] = net_name
        pos += net_name_size
    if 0 not in net_index_map:
        net_index_map[0] = "UNCONNECTED"
    return net_index_map


def translate_bytes_failover(input_bytes):
    try:
        return bytes(input_bytes).decode()
    except:
        return translate_bytes(input_bytes)


def extract_part_pin_nets(data, net_index_map):
    blocks = extract_part_blocks(data)
    all_parts_data = {"parts": {}}
    for index, block in enumerate(blocks):
        part_data = {}
        part_name = ""
        # Header
        pos = 0
        part_size = struct.unpack("<I", block[pos : pos + 4])[0]
        pos += 4
        pos += 18
        pad_desc_size = struct.unpack("<I", block[pos : pos + 4])[0]
        pos += 4
        pad_desc = translate_bytes_failover(block[pos : pos + pad_desc_size])
        pos += pad_desc_size

        while pos < part_size:
            sub_type_identifier = block[pos]
            pos += 1
            if sub_type_identifier not in [1, 5, 6, 9]:
                raise ObdataError(
                    f"Sub type identifier not found: {sub_type_identifier} "
                    f"(block {index}, pos {pos})"
                )
            match sub_type_identifier:
                case 1:  # Arc
                    block_size = struct.unpack("<I", block[pos : pos + 4])[0]
                    pos += 4
                    pos += block_size
                case 5:  # line_segment
                    block_size = struct.unpack("<I", block[pos : pos + 4])[0]
                    pos += 4
                    pos += block_size
                case 6:  # Labels/Part Names
                    block_size = struct.unpack("<I", block[pos : pos + 4])[0]
                    pos += 4
                    pos += 26
                    label_size = struct.unpack("<I", block[pos : pos + 4])[0]
                    pos += 4
                    temp_part_name = translate_bytes_failover(
                        block[pos : pos + label_size]
                    )
                    if temp_part_name != "" and part_name == "":
                        part_name = temp_part_name
                    pos += label_size
                case 9:  # Pin
                    block_size = struct.unpack("<I", block[pos : pos + 4])[0]
                    pos += 4
                    block_end = pos + block_size
                    pos += 20
                    pin_name_size = struct.unpack("<I", block[pos : pos + 4])[0]
                    pos += 4
                    pin_name = translate_bytes_failover(
                        block[pos : pos + pin_name_size]
                    )
                    pos += pin_name_size
                    pos += 8
                    while pos < block_end - 4:
                        pin_sub_type_identifier = block[pos]
                        pos += 1
                        if pin_sub_type_identifier not in [0, 1, 2, 3]:
                            raise ObdataError(
                                f"Pin sub type identifier not found: "
                                f"{pin_sub_type_identifier} (block {index}, pos {pos})"
                            )
                        match pin_sub_type_identifier:
                            case 0:
                                net_index = struct.unpack("<I", block[pos : pos + 4])[0]
                                pos += 4
                                if pos >= block_end - 4:
                                    diode_reading_size = 0
                                else:
                                    diode_reading_size = struct.unpack(
                                        "<I", block[pos : pos + 4]
                                    )[0]
                                    pos += 4
                                    if diode_reading_size > 0:
                                        diode_reading = translate_bytes_failover(
                                            block[pos : pos + diode_reading_size]
                                        )
                                        pos += diode_reading_size
                            case _:
                                a = struct.unpack("<I", block[pos : pos + 4])[0]
                                pos += 4
                                if a > 0:
                                    pos += 4
                    if diode_reading_size > 0:
                        part_data[pin_name] = {
                            "net_index": net_index,
                            "net_name": net_index_map[net_index],
                            "diode_reading": diode_reading,
                        }
                    else:
                        part_data[pin_name] = {
                            "net_index": net_index,
                            "net_name": net_index_map[net_index],
                        }
                    pos = block_end

        all_parts_data["parts"][part_name] = {}
        all_parts_data["parts"][part_name]["pins"] = sort_dictionary(part_data)
        if pad_desc != "":
            all_parts_data["parts"][part_name]["pad_desc"] = pad_desc
    return all_parts_data


def extract_post_v6_data(data):
    sub_section_data_list = []
    header_list = []
    post_v6_start = get_net_block_end(data) + len(main_header)
    post_v6_data = data[post_v6_start:]
    if post_v6_data is None:
        return [], []
    # Find all instances of sub_header_divider
    positions = []
    pos = 0
    while True:
        pos = post_v6_data.find(sub_header_divider, pos)
        if pos == -1:
            break
        positions.append(pos)
        pos += len(sub_header_divider)

    # Split data into sections based on positions
    sections = []
    for i in range(len(positions)):
        start = positions[i]
        if i < len(positions) - 1:
            end = positions[i + 1]
        else:
            end = len(post_v6_data)
        sections.append(post_v6_data[start:end])

    sub_section_data_list = []
    header_list = []
    for i, section in enumerate(sections):
        pos = len(sub_header_divider)
        sub_header = b""
        while section[pos] != 0x0A and section[pos] != 0x0D:
            sub_header += bytes([section[pos]])
            pos += 1
        sub_section_data = section[pos + 1 :]
        if len(sub_section_data.replace(b"\x0a", b"").replace(b"\x0d", b"")) == 0:
            log.debug(f"No data found for in section {i+1}")
            continue
        sub_section_data_list.append(sub_section_data)
        header_list.append(sub_header)
    return sub_section_data_list, header_list


def sort_dictionary(dictionary):
    if isinstance(dictionary, dict):
        sorted_dict = dict(sorted(dictionary.items()))
        for key, value in sorted_dict.items():
            sorted_dict[key] = sort_dictionary(value)
        return sorted_dict
    elif isinstance(dictionary, list):
        return [
            sort_dictionary(item) if isinstance(item, (dict, list)) else item
            for item in dictionary
        ]
    else:
        return dictionary


def natural_sort_key(line):
    """Extract natural sort key from a line like 'L91 m 01005'."""
    first_field = line.split()[0] if line.split() else ""
    # Split into prefix (letters) and suffix (numbers)
    match = re.match(r"^([A-Za-z]*)(\d*)(.*)$", first_field)
    if match:
        prefix, num, rest = match.groups()
        num_val = int(num) if num else 0
        return (prefix.upper(), num_val, rest)
    return (first_field, 0, "")


def sort_lines_naturally(lines):
    """Sort lines naturally by their first field (component name)."""
    return sorted(lines, key=natural_sort_key)


def combine_post_v6_and_part_data(file_name, post_v6_data, part_data):
    if "PCB Attachment" in post_v6_data:
        if "part" in post_v6_data["PCB Attachment"]:
            for part in post_v6_data["PCB Attachment"]["part"]:
                if "alias" in part:
                    try:
                        part_data["parts"][part["reference"]]["alias"] = part["alias"]
                    except:
                        pass
                if "pad" in part:
                    for pin in part["pad"]:
                        if "diode" in pin:
                            try:
                                part_data["parts"][part["reference"]]["pins"][
                                    pin["name"]
                                ]["diode_reading"] = pin["diode"]
                            except:
                                pass
        if "net" in post_v6_data["PCB Attachment"]:
            part_data["net_aliases"] = {}
            for net in post_v6_data["PCB Attachment"]["net"]:
                if "alias" in net:
                    try:
                        part_data["net_aliases"][net["name"]] = net["alias"]
                    except:
                        pass

        if "bitmap" in post_v6_data["PCB Attachment"].keys():
            log.debug(
                f"Bitmap data found in PCB Attachment: {post_v6_data['PCB Attachment']['bitmap']}"
            )
            if post_v6_data["PCB Attachment"]["bitmap"] == {}:
                log.debug("Bitmap data empty, skipping")
            elif (
                post_v6_data["PCB Attachment"]["bitmap"]["x"] == 0
                and post_v6_data["PCB Attachment"]["bitmap"]["y"] == 0
            ):
                log.debug("Bitmap data is 0,0, skipping")
            else:
                log.info(f"Bitmap data is not 0,0 for {file_name}, recording")
                with open(
                    os.path.join(CONFIG_FOLDER_PATH, "bitmap_data_files.txt"),
                    "a",
                    encoding="utf-8",
                ) as bdf:
                    bdf.write(
                        f"{file_name} - {post_v6_data['PCB Attachment']['bitmap']['x']}, {post_v6_data['PCB Attachment']['bitmap']['y']}\n"
                    )

        if any(
            key not in ["part", "net", "bitmap"]
            for key in post_v6_data["PCB Attachment"].keys()
        ):
            raise ObdataError(
                f"Unknown data found in PCB Attachment of {file_name}: "
                f"{post_v6_data['PCB Attachment']}"
            )

    if "Resistance" in post_v6_data:
        for net_or_part in post_v6_data["Resistance"].keys():
            if type(post_v6_data["Resistance"][net_or_part]) == dict:
                for pin in post_v6_data["Resistance"][net_or_part].keys():
                    try:
                        part_data["parts"][net_or_part]["pins"][pin][
                            "diode_reading"
                        ] = post_v6_data["Resistance"][net_or_part][pin]
                    except:
                        pass
            else:
                for part in part_data["parts"].keys():
                    for pin in part_data["parts"][part]["pins"].keys():
                        if (
                            part_data["parts"][part]["pins"][pin]["net_name"]
                            == net_or_part
                        ):
                            try:
                                part_data["parts"][part]["pins"][pin][
                                    "diode_reading"
                                ] = post_v6_data["Resistance"][net_or_part]
                            except:
                                pass

    if "Signal" in post_v6_data:
        part_data["signal_descriptions"] = post_v6_data["Signal"]
    if "RFFE" in post_v6_data:
        part_data["rffe"] = post_v6_data["RFFE"]
    if "Voltage" in post_v6_data:
        for net in post_v6_data["Voltage"].keys():
            for part in part_data["parts"].keys():
                for pin in part_data["parts"][part]["pins"].keys():
                    if part_data["parts"][part]["pins"][pin]["net_name"] == net:
                        part_data["parts"][part]["pins"][pin]["voltage"] = post_v6_data[
                            "Voltage"
                        ][net]
    if "Resistance diagram" in post_v6_data:
        for net in post_v6_data["Resistance diagram"].keys():
            for part in part_data["parts"].keys():
                for pin in part_data["parts"][part]["pins"].keys():
                    if part_data["parts"][part]["pins"][pin]["net_name"] == net:
                        try:
                            part_data["parts"][part]["pins"][pin]["diode_reading"] = (
                                post_v6_data["Resistance diagram"][net]
                            )
                        except:
                            pass
    if "Part data" in post_v6_data:
        for part in post_v6_data["Part data"].keys():
            if part in part_data["parts"]:
                part_data["parts"][part].update(post_v6_data["Part data"][part])
    if "Schematic" in post_v6_data:
        part_data["schematic"] = post_v6_data["Schematic"]
    if "Resistance table" in post_v6_data:
        for net in post_v6_data["Resistance table"].keys():
            for part in part_data["parts"].keys():
                for pin in part_data["parts"][part]["pins"].keys():
                    if part_data["parts"][part]["pins"][pin]["net_name"] == net:
                        try:
                            part_data["parts"][part]["pins"][pin]["diode_reading"] = (
                                post_v6_data["Resistance table"][net]
                            )
                        except:
                            pass

    return part_data


# --- OBDATA writer helpers (see XZZPCB-ImHex/OBDATA_WRITER.md) ------------------
# Only three OBDATA fields are url-encoded: a net's CONDITION, a `t`-valuetype
# value, and the trailing quoted comment. Everything else is emitted plain.
UNRESERVED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_."
)


def obdata_encode(text):
    """URL-encode per OBDATA_WRITER.md 8.3: ' ' -> '+', A-Za-z0-9-_. stay literal,
    every other byte -> '%HH' (uppercase hex). Encodes exactly once."""
    out = []
    for byte in str(text).encode("utf-8"):
        char = chr(byte)
        if char == " ":
            out.append("+")
        elif char in UNRESERVED:
            out.append(char)
        else:
            out.append("%%%02X" % byte)
    return "".join(out)


def normalize_voltage(value):
    """Canonical `v`-line value (OBDATA_WRITER.md 7.4): a unitless dot-decimal.
    Turns comma decimals into dots, rewrites the 'NvNN' notation (e.g. 0v70) into
    0.70, and strips a trailing volt unit."""
    value = str(value).strip().replace(",", ".")
    m = re.fullmatch(r"(\d+)[vV](\d+)", value)
    if m:
        return f"{m.group(1)}.{m.group(2)}"
    if value[-1:] in ("V", "v"):
        value = value[:-1]
    return value


def normalize_reading(value):
    """Canonical `d`-line special tokens are uppercase (OBDATA_WRITER.md 7.4)."""
    value = str(value).strip()
    if value.lower() in ("ol", "na"):
        return value.upper()
    return value


def component_sort_key(row):
    """Group component lines by refdes: natural order, then the exact refdes so
    distinct refdes that share a natural key (e.g. C1 vs C01) never interleave,
    then ASCII-ascending code letter (OBDATA_WRITER.md 6.3)."""
    ref, code, value = row
    return (natural_sort_key(ref), ref, code, value)


def net_sort_key(row):
    """Cluster a net's lines together: natural net name, then the exact net name
    (so C1 vs C01 style collisions do not interleave), then code/value."""
    net, code, value = row
    return (natural_sort_key(net), net, code, value)


def make_header_text():
    # Header keys in fixed order (OBDATA_WRITER.md 4). BRAND/CATEGORY/ID/BOARDPATH
    # are intentionally left empty for now; TIMESTAMP is stamped at write time.
    header = {
        "OBDATA_V002": "https://openboarddata.org",
        "TIMESTAMP": int(datetime.now().timestamp()),
        "BOARDPATH": "",
        "ID": "",
        "BRAND": "",
        "CATEGORY": "",
        "COMMENT": "conversion by @slimeinacloak :3",
    }
    header_text = "HEADER_DATA_START\n"
    for key, value in header.items():
        header_text += f"{key} {value}\n"
    header_text += "HEADER_DATA_END\n"
    # License line follows HEADER_DATA_END with no blank line (OBDATA_WRITER.md 3.2).
    header_text += (
        "### Released under the OBbL - https://opendatacommons.org/licenses/odbl/1-0/\n"
    )
    return header_text


def make_diagnosis_text():
    # Empty diagnosis; the single blank line that follows is emitted by the caller.
    return "DIAGNOSIS_DATA_START\nDIAGNOSIS_DATA_END\n"


def make_components_text(component_rows):
    components_text = "COMPONENTS_DATA_START\n"
    components_text += "### Component Category Value Comment\n"
    components_text += "### v = value, p = package, c = manufacturer code, r = rating, m = misc, s = status\n"
    components_text += "###\n"
    # Refdes and code are single space-free tokens; the value is the rest of the line
    # and MAY contain spaces (OBDATA_WRITER.md 6). Lines grouped per refdes,
    # ASCII-ascending by code; no blank before _END.
    cleaned, dropped = set(), 0
    for ref, code, value in component_rows:
        ref, value = ref.strip(), value.strip()
        if not ref or not value or any(c.isspace() for c in ref):
            dropped += 1
            continue
        cleaned.add((ref, code, value))
    for ref, code, value in sorted(cleaned, key=component_sort_key):
        components_text += f"{ref} {code} {value}\n"
    if dropped:
        log.debug(
            f"Dropped {dropped} component line(s) with a bad refdes / empty value"
        )
    components_text += "COMPONENTS_DATA_END\n"
    return components_text


def make_nets_text(net_rows):
    nets_text = "NETS_DATA_START\n"
    nets_text += "### Network Valuetype Value Comment\n"
    nets_text += (
        "### d = diode, v = voltage, r = resistance, a = alias, t = net comment\n"
    )
    nets_text += "###\n"
    # A net line has exactly 4 space-separated fields (OBDATA_WRITER.md 7 / 11.1).
    # The key (netname) and the d/v/a value are bare (never url-encoded), so they must
    # not contain whitespace; a `t` value is already url-encoded. Strip stray
    # surrounding whitespace and drop the rare record whose bare field still holds an
    # internal space (unrepresentable in the 4-field grammar). Every net key carries
    # the /Default condition; the comment column is ''.
    cleaned, dropped = set(), 0
    for net, code, value in net_rows:
        net = net.strip()
        if code != "t":
            value = value.strip()
        if (
            not net
            or not value
            or any(c.isspace() for c in net)
            or (code != "t" and any(c.isspace() for c in value))
        ):
            dropped += 1
            continue
        cleaned.add((net, code, value))
    for net, code, value in sorted(cleaned, key=net_sort_key):
        nets_text += f"{net}/Default {code} {value} ''\n"
    if dropped:
        log.debug(f"Dropped {dropped} net line(s) with whitespace in a bare field")
    # Exactly one blank line before _END, present even when populated (3.2 rule 8).
    nets_text += "\n"
    nets_text += "NETS_DATA_END\n"
    return nets_text


def pull_diode_readings(json_data):
    """(net, 'd', value) rows. Digit readings > 10 are scaled by 1000 to a
    volt-like diode drop; special tokens (OL/NA) are uppercased."""
    rows = []
    for part_data in json_data["parts"].values():
        for pin_data in part_data["pins"].values():
            if "diode_reading" not in pin_data:
                continue
            diode_reading = pin_data["diode_reading"]
            if re.match(r"^\d+$", diode_reading):
                diode_reading = float(diode_reading)
                if diode_reading > 10:
                    diode_reading = f"{(diode_reading/1000):.3f}"
                else:
                    diode_reading = f"{diode_reading}"
            else:
                diode_reading = normalize_reading(diode_reading)
            rows.append((pin_data["net_name"], "d", diode_reading))
    return rows


def pull_net_voltages(json_data):
    """(net, 'v', value) rows; values normalized to unitless dot-decimals."""
    rows = []
    for part_data in json_data["parts"].values():
        for pin_data in part_data["pins"].values():
            if "voltage" in pin_data:
                rows.append(
                    (pin_data["net_name"], "v", normalize_voltage(pin_data["voltage"]))
                )
    return rows


def pull_net_comments(json_data):
    """(net, 't', value) rows from Signal descriptions. A description is free text
    (often GB2312), so it is url-encoded and carried as a `t` net comment, not an
    alias (OBDATA_WRITER.md 7.3/7.4)."""
    rows = []
    for net, description in json_data.get("signal_descriptions", {}).items():
        rows.append((net, "t", obdata_encode(description)))
    return rows


def pull_net_aliases(json_data):
    """(net, 'a', value) rows from real net aliases (PCB Attachment net[].alias).
    An alias value is a bare net name and is NOT url-encoded (OBDATA_WRITER.md 7.3)."""
    rows = []
    for net, alias in json_data.get("net_aliases", {}).items():
        rows.append((net, "a", alias))
    return rows


def pull_components(json_data):
    """(refdes, code, value) rows for the COMPONENTS block: a part alias and pad
    description as `m` (misc), the pad size as `p` (package). Values equal to the
    refdes itself carry no information and are skipped."""
    rows = []
    for ref, part_data in json_data["parts"].items():
        if "alias" in part_data:
            rows.append((ref, "m", f"Part alias: {part_data['alias']}"))
        if "pad_desc" in part_data and part_data["pad_desc"] != ref:
            rows.append((ref, "m", part_data["pad_desc"]))
        if "part_pad_size" in part_data and part_data["part_pad_size"] != ref:
            rows.append((ref, "p", part_data["part_pad_size"]))
    return rows


def make_obdata_file(extracted_data, output_file):
    """Write an .obdata file per OBDATA_WRITER.md. Returns True if written, False
    if skipped (no diode readings, matching the previous behaviour)."""
    diode_rows = pull_diode_readings(extracted_data)
    if len(diode_rows) == 0:
        log.debug("🟡 No diode readings, skipping")
        return False

    net_rows = (
        diode_rows
        + pull_net_voltages(extracted_data)
        + pull_net_comments(extracted_data)
        + pull_net_aliases(extracted_data)
    )
    component_rows = pull_components(extracted_data)

    # Assemble with the exact blank-line skeleton from OBDATA_WRITER.md 3.2: one
    # blank between DIAGNOSIS/COMPONENTS, COMPONENTS/NETS, and NETS/### END.
    text = make_header_text()
    text += make_diagnosis_text()
    text += "\n"
    text += make_components_text(component_rows)
    text += "\n"
    text += make_nets_text(net_rows)
    text += "\n"
    text += "### END\n"

    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def process_pcb_file(file_path, input_root, output_root):
    """Parse one .pcb file into .obdata.

    Returns the created .obdata path relative to ``output_root``, or ``None`` when
    nothing was written (no extractable data, no diode readings, or an error —
    errors are logged and recorded in broken_files.txt).
    """
    file = os.path.basename(file_path)
    try:
        rel_path = os.path.relpath(os.path.dirname(file_path), input_root)
        output_dir = os.path.join(output_root, rel_path)
        output_file = os.path.join(output_dir, re.sub(r"\.[^.]+$", ".obdata", file))

        with open(file_path, "rb") as f:
            data = f.read()
        if data[0] != 0x58:
            log.debug(f"{file} is xored!")
            data = de_xor_data(data)

        sub_section_data_list, header_list = extract_post_v6_data(data)
        if len(sub_section_data_list) == 0 or len(header_list) == 0:
            log.debug(f"🟠 No additional data found for {file}")
            return None
        log.debug(f"🟢 Additional data found for {file}")

        net_index_map = extract_net_index_map(data)
        part_pin_nets_data = extract_part_pin_nets(data, net_index_map)
        post_v6_data = combine_data(file, sub_section_data_list, header_list)
        combined_data = combine_post_v6_and_part_data(
            file, post_v6_data, part_pin_nets_data
        )

        if make_obdata_file(combined_data, output_file):
            return os.path.relpath(output_file, output_root)
        return None
    except Exception as e:
        log.error(f"Error processing {file}: {e}")
        log.debug(traceback.format_exc())
        # Record broken files for later inspection
        with open(
            os.path.join(CONFIG_FOLDER_PATH, "broken_files.txt"),
            "a",
            encoding="utf-8",
        ) as bf:
            bf.write(f"{file}\n")
        return None


def _iter_pcb_paths(input_root, pcb_files):
    """Yield absolute .pcb paths to process.

    With ``pcb_files=None``, walk ``input_root`` for every .pcb (full scan /
    backfill). Otherwise resolve each path relative to ``input_root``, skipping
    any that are missing on disk.
    """
    if pcb_files is None:
        for root, _dirs, files in os.walk(input_root):
            for file in files:
                if file.endswith(".pcb"):
                    yield os.path.join(root, file)
        return
    for rel in pcb_files:
        path = os.path.join(input_root, rel)
        if os.path.isfile(path):
            yield path
        else:
            log.debug(f"Skipping missing .pcb: {rel}")


def main(input_root, output_root, pcb_files=None):
    """Extract .obdata from .pcb files; return the created .obdata relative paths.

    ``pcb_files`` is a list of .pcb paths relative to ``input_root`` to process
    (e.g. only the files downloaded this run); ``None`` walks the whole tree.
    """
    pcb_paths = list(_iter_pcb_paths(input_root, pcb_files))
    total = len(pcb_paths)
    start_time = time.time()

    created = []
    for file_index, file_path in enumerate(pcb_paths, start=1):
        if file_index % 100 == 0:
            elapsed = time.time() - start_time
            rate = file_index / max(elapsed, 1e-9)
            pct = (file_index / total * 100.0) if total else 100.0
            eta = elapsed / file_index * (total - file_index)
            log.info(
                f"Processing PCB files: {file_index}/{total} "
                f"({pct:5.1f}%) @ {rate:,.0f}/s ETA: {eta:.0f}s"
            )
        obdata_rel = process_pcb_file(file_path, input_root, output_root)
        if obdata_rel is not None:
            created.append(obdata_rel)

    return sorted(set(created))


main_header = b"\x76\x36\x76\x36\x35\x35\x35\x76\x36\x76\x36"
sub_header_divider = b"\x3d\x3d\x3d"

sub_header_types = {
    b"\x50\x43\x42\xb8\xbd\xbc\xd3": "PCB Attachment",  # Json data
    b"\xd0\xc5\xba\xc5": "Signal",
    b"\xd0\xc5\xba\xc5\x20\x20\x20": "Signal",
    b"\x52\x46\x46\x45": "RFFE",  # Json data
    b"\xd7\xe8\xd6\xb5": "Resistance",
    b"\xb5\xe7\xd1\xb9": "Voltage",
    b"\xd7\xe8\xd6\xb5\xcd\xbc": "Resistance diagram",
    b"": "Part data",
    b"\xd4\xad\xc0\xed\xcd\xbc": "Schematic",
    b"\xd7\xe8\xd6\xb5\xb1\xed": "Resistance table",
}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert XZZPCB .pcb files into OpenBoardData .obdata files."
    )
    parser.add_argument("input_root", help="Directory tree to scan for .pcb files")
    parser.add_argument(
        "output_root",
        nargs="?",
        help="Where to write .obdata files (mirrors the input tree); "
        "defaults to input_root.",
    )
    args = parser.parse_args()
    created = main(args.input_root, args.output_root or args.input_root)
    log.info(f"Wrote {len(created)} .obdata file(s).")
