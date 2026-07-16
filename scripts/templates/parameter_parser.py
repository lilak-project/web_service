"""Full port of the lilak_parameter_editor.py parameter parser.

Row schema:
  {kind: 'parameter'|'comment', enabled: bool, group, name, value, unit, comment, flags}

- unit holds the name prefix flags as written: '!', '*', '&', '@', '<', or '#'
  ('#' marks a commented-out parameter, distinct from a plain comment line).
- Indent-based group blocks ("group/" lines) are resolved into the group field;
  serialization always writes the flat "group/name" form.
"""
from pathlib import Path


def split_value_and_comment(text: str):
    in_quotes = False
    for idx, char in enumerate(text):
        if char == '"':
            in_quotes = not in_quotes
        elif char == "#" and not in_quotes:
            return text[:idx].rstrip(), text[idx + 1:].strip()
    return text.strip(), ""


def split_name_and_flags(raw_name: str):
    flags = {
        "rewrite": False,
        "temporary": False,
        "multiple": False,
        "conditional": False,
        "include": False,
    }
    prefix = ""
    name = raw_name
    while name:
        if name[0] == "!":
            flags["rewrite"] = True
            prefix += "!"
            name = name[1:]
            continue
        if name[0] == "*":
            flags["temporary"] = True
            prefix += "*"
            name = name[1:]
            continue
        if name[0] == "&":
            flags["multiple"] = True
            prefix += "&"
            name = name[1:]
            continue
        if name[0] == "@":
            flags["conditional"] = True
            prefix += "@"
            name = name[1:]
            continue
        if name[0] == "<":
            flags["include"] = True
            prefix += "<"
            name = name[1:]
            continue
        break
    return name, flags, prefix


def split_group_and_name(full_name: str):
    if "/" in full_name:
        group, name = full_name.rsplit("/", 1)
        return group, name
    return "", full_name


def update_group_context(indent, previous_indent, indent_stack, group_stack):
    current_group = ""
    if indent == 0:
        previous_indent = 0
        indent_stack.clear()
        group_stack.clear()
    elif indent == previous_indent:
        current_group = group_stack[-1] if group_stack else ""
        if len(group_stack) == len(indent_stack) + 1:
            group_stack.pop()
            current_group = group_stack[-1] if group_stack else ""
    elif indent < previous_indent:
        while indent_stack and indent_stack[-1] != indent:
            indent_stack.pop()
            if group_stack:
                group_stack.pop()
        previous_indent = indent_stack[-1] if indent_stack else 0
        current_group = group_stack[-1] if group_stack else ""
    else:
        if len(group_stack) == len(indent_stack) + 1:
            indent_stack.append(indent)
            current_group = group_stack[-1]
        else:
            current_group = group_stack[-1] if group_stack else ""
    return current_group, indent


def should_try_parameter(inner: str):
    if not inner:
        return False
    parts = inner.split(None, 1)
    token = parts[0]
    if token.startswith("#"):
        return False
    if token.endswith("/"):
        return True
    if "/" in token:
        return True
    if token[:1] in "!*&@<":
        return True
    if len(parts) == 1:
        return False

    value_head = parts[1].lstrip()[:1]
    if value_head in ['"', "'", "/", "{", "[", "(", "-", "+"]:
        return True
    if value_head.isdigit():
        return True

    value_token = parts[1].split(None, 1)[0].lower()
    if value_token in {"true", "false", "yes", "no", "on", "off"}:
        return True
    if value_token.startswith("k"):
        return True

    return False


def parse_parameter_candidate(inner: str, current_group: str):
    parts = inner.split(None, 1)
    raw_name = parts[0]
    remainder = parts[1] if len(parts) > 1 else ""
    parsed_name, flags, prefix = split_name_and_flags(raw_name)
    value, comment = split_value_and_comment(remainder)
    full_name = f"{current_group}{parsed_name}"

    if parsed_name.endswith("/") and not value:
        return {
            "kind": "group",
            "full_name": full_name.rstrip("/"),
            "comment": comment,
        }

    group, name = split_group_and_name(full_name)
    return {
        "kind": "parameter",
        "enabled": True,
        "group": group,
        "name": name,
        "value": value,
        "unit": prefix,
        "comment": comment,
        "flags": flags,
    }


def parse_parameter_text(content: str):
    rows = []
    previous_indent = 0
    indent_stack = []
    group_stack = []

    for line_no, raw_line in enumerate(content.splitlines(), start=1):
        if not raw_line.strip():
            continue

        stripped = raw_line.lstrip(" ")
        indent = len(raw_line) - len(stripped)
        current_group, previous_indent = update_group_context(
            indent, previous_indent, indent_stack, group_stack
        )

        if stripped.startswith("#"):
            is_enabled_comment = stripped.startswith("##") and (len(stripped) == 2 or stripped[2].isspace())
            is_line_comment = (len(stripped) == 1 or stripped[1].isspace()) or is_enabled_comment
            if is_line_comment:
                inner = stripped[2:].lstrip() if is_enabled_comment else stripped[1:].lstrip()
                rows.append({
                    "kind": "comment",
                    "enabled": is_enabled_comment,
                    "group": "",
                    "name": "",
                    "value": "",
                    "unit": "",
                    "comment": inner,
                    "line_no": line_no,
                })
                continue

            inner = stripped[1:]
            if should_try_parameter(inner):
                parsed = parse_parameter_candidate(inner, current_group)
                if parsed["kind"] == "group":
                    group_stack.append(parsed["full_name"] + "/")
                    continue
                parsed["enabled"] = True
                parsed["unit"] = "#"
                parsed["line_no"] = line_no
                rows.append(parsed)
                continue

            rows.append({
                "kind": "comment",
                "enabled": False,
                "group": "",
                "name": "",
                "value": "",
                "unit": "",
                "comment": inner.lstrip(),
                "line_no": line_no,
            })
            continue

        parsed = parse_parameter_candidate(stripped, current_group)
        if parsed["kind"] == "group":
            group_stack.append(parsed["full_name"] + "/")
            continue

        parsed["line_no"] = line_no
        rows.append(parsed)

    return rows


def serialize_rows(rows):
    lines = []
    previous_parameter_group = None
    previous_kind = None
    for row in rows:
        kind = row.get("kind", "parameter")
        if kind == "comment":
            comment = (row.get("comment") or "").strip()
            prefix = "##" if row.get("enabled", False) else "#"
            lines.append(f"{prefix} {comment}".rstrip())
            previous_kind = "comment"
            continue

        group = (row.get("group") or "").strip().strip("/")
        name = (row.get("name") or "").strip()
        full_name = f"{group}/{name}" if group and name else name
        if not full_name:
            continue

        value = (row.get("value") or "").strip()
        unit = (row.get("unit") or "").strip()
        comment = (row.get("comment") or "").strip()
        is_commented_parameter = unit == "#"
        prefix = "#" if is_commented_parameter else ("" if row.get("enabled", True) else "#")
        group_key = f"{unit}{group}" if group else unit
        if lines and previous_kind == "parameter" and previous_parameter_group != group_key and lines[-1] != "":
            lines.append("")
        line = f"{prefix}{'' if is_commented_parameter else unit}{full_name}"
        if value:
            line += f"  {value}"
        if comment:
            line += f"  # {comment}"
        lines.append(line)
        previous_parameter_group = group_key
        previous_kind = "parameter"

    return "\n".join(lines) + ("\n" if lines else "")


def parameter_key(row):
    return ((row.get("group") or "").strip(), (row.get("name") or "").strip())


def strip_wrapping_quotes(value: str) -> str:
    value = (value or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def find_parameter_row(rows, group, name):
    for row in rows:
        if row.get("kind") != "parameter":
            continue
        if parameter_key(row) == (group, name):
            return row
    return None


def is_parameter_enabled(row):
    if row is None:
        return False
    if (row.get("unit") or "").strip() == "#":
        return False
    return row.get("enabled", True) is not False


def normalize_searchrun_mfm_rows(rows):
    """When LKRun/SearchRun is 'mfm', comment out InputFile and derive InputPath."""
    search_rows = [
        row for row in rows
        if row.get("kind") == "parameter"
        and parameter_key(row) == ("LKRun", "SearchRun")
        and is_parameter_enabled(row)
    ]
    use_mfm_search = any((row.get("value") or "").strip().split()[:1] == ["mfm"] for row in search_rows)
    if not use_mfm_search:
        return rows

    input_file_row = find_parameter_row(rows, "LKRun", "InputFile")
    input_file_value = strip_wrapping_quotes(input_file_row.get("value", "")) if input_file_row else ""
    input_path_value = str(Path(input_file_value).expanduser().parent) if input_file_value else ""

    if input_file_row is not None:
        input_file_row["unit"] = "#"
        input_file_row["enabled"] = True

    if input_path_value and input_path_value != ".":
        input_path_row = find_parameter_row(rows, "LKRun", "InputPath")
        if input_path_row is None:
            insert_index = 0
            for index, row in enumerate(rows):
                if row.get("kind") == "parameter" and (row.get("group") or "").strip() == "LKRun":
                    insert_index = index + 1
            rows.insert(insert_index, {
                "kind": "parameter",
                "enabled": True,
                "group": "LKRun",
                "name": "InputPath",
                "value": input_path_value,
                "unit": "",
                "comment": "path generated from LKRun/InputFile for SearchRun mfm",
            })
        else:
            input_path_row["value"] = input_path_value
            input_path_row["unit"] = ""
            input_path_row["enabled"] = True

    get_input_row = find_parameter_row(rows, "LKGETConversionTask", "InputFileName")
    if get_input_row is not None:
        get_input_row["unit"] = "#"
        get_input_row["enabled"] = True

    return rows
