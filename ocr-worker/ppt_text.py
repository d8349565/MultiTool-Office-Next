"""只读取 MS-PPT 的当前幻灯片与文字记录，不解析链接、备注或嵌入对象。"""
import struct

import olefile

RECORD = struct.Struct("<HHI")
U32 = struct.Struct("<I")
DOCUMENT, SLIDE, SLIDE_REF, DRAWING = 0x03E8, 0x03EE, 0x03F3, 0x040C
TEXT_CHARS, TEXT_BYTES = 0x0FA0, 0x0FA8
SLIDE_LIST, USER_EDIT, CURRENT_USER, PERSIST_DIRECTORY = 0x0FF0, 0x0FF5, 0x0FF6, 0x1772
SHAPE_CONTAINERS = {0xF002, 0xF003, 0xF004}
TEXTBOX = 0xF00D
INVALID = "PPT 文件损坏或格式无法读取，请用原程序打开"


def record(data, offset, limit):
    if offset + RECORD.size > limit:
        raise ValueError(INVALID)
    flags, kind, size = RECORD.unpack_from(data, offset)
    body = offset + RECORD.size
    if body + size > limit:
        raise ValueError(INVALID)
    return flags, kind, body, body + size


def records(data, start, end):
    while start < end:
        item = record(data, start, end)
        yield item
        start = item[3]


def persisted_objects(data, offset):
    # MS-PPT 2.1.2：从最新编辑往回走，同一个 ID 以最新的流偏移为准。
    offsets = {}
    document_id = None
    while offset:
        _, kind, start, end = record(data, offset, len(data))
        if kind != USER_EDIT or end - start not in (28, 32):
            raise ValueError(INVALID)
        previous, directory, identifier = struct.unpack_from("<III", data, start + 8)
        if document_id is None:
            document_id = identifier
            if end - start == 32 and U32.unpack_from(data, start + 28)[0]:
                raise ValueError("加密的 PPT 请用原程序打开")
        if not previous < directory < offset:
            raise ValueError(INVALID)
        _, kind, start, end = record(data, directory, offset)
        if kind != PERSIST_DIRECTORY:
            raise ValueError(INVALID)
        while start < end:
            if end - start < U32.size:
                raise ValueError(INVALID)
            packed, = U32.unpack_from(data, start)
            identifier, count = packed & 0xFFFFF, packed >> 20
            start += 4
            if not count or identifier + count > 1 << 20 or start + 4 * count > end:
                raise ValueError(INVALID)
            for i in range(count):
                offsets.setdefault(identifier + i, U32.unpack_from(data, start + 4 * i)[0])
            start += 4 * count
        offset = previous
    return offsets, offsets[document_id]


def text_records(data, start, end, limit):
    for _, kind, body, stop in records(data, start, end):
        if kind == TEXT_CHARS:
            value = data[body:min(stop, body + 2 * limit)].decode("utf-16-le", errors="replace")
        elif kind == TEXT_BYTES:
            value = data[body:min(stop, body + limit)].decode("latin-1")
        else:
            continue
        yield value.replace("\r\n", "\n").replace("\r", "\n").replace("\v", "\n").strip("\x00")


def shape_text(data, start, end, limit, depth=0):
    if depth >= 32:
        raise ValueError(INVALID)
    for _, kind, body, stop in records(data, start, end):
        if kind == TEXTBOX:
            yield from text_records(data, body, stop, limit)
        elif kind in SHAPE_CONTAINERS:
            yield from shape_text(data, body, stop, limit, depth + 1)


def slide_text(path, page, file_limit, text_limit):
    try:
        with olefile.OleFileIO(str(path), raise_defects=olefile.DEFECT_INCORRECT) as document:
            if document.get_size("Current User") > 4096:
                raise ValueError(INVALID)
            with document.openstream("Current User") as stream:
                current = stream.read(32)
            if len(current) < 20 or struct.unpack_from("<H", current, 2)[0] != CURRENT_USER:
                raise ValueError(INVALID)
            token, offset = struct.unpack_from("<II", current, 12)
            if token == 0xF3D1C4DF:
                raise ValueError("加密的 PPT 请用原程序打开")
            if token != 0xE391C05F or document.get_size("PowerPoint Document") > file_limit:
                raise ValueError(INVALID)
            with document.openstream("PowerPoint Document") as stream:
                data = stream.read()
        offsets, document_offset = persisted_objects(data, offset)
        _, kind, start, end = record(data, document_offset, len(data))
        if kind != DOCUMENT:
            raise ValueError(INVALID)
        # 同一类型还用于母版和备注；只有实例 0 是正常幻灯片列表。
        slide_list = next(((body, stop) for flags, kind, body, stop in records(data, start, end)
                           if kind == SLIDE_LIST and flags == 0x000F), None)
        if slide_list is None:
            return 0, ()
        count, selected = 0, None
        outline_start = outline_end = slide_list[1]
        for _, kind, body, stop in records(data, *slide_list):
            if kind != SLIDE_REF:
                continue
            count += 1
            if count == page:
                if stop - body < 4:
                    raise ValueError(INVALID)
                selected, = U32.unpack_from(data, body)
                outline_start = stop
            elif count == page + 1:
                outline_end = body - RECORD.size
        if not count:
            return 0, ()
        if selected is None:
            raise ValueError("幻灯片不存在或超出预览范围")
        _, kind, start, end = record(data, offsets[selected], len(data))
        if kind != SLIDE:
            raise ValueError(INVALID)
    except (OSError, KeyError, struct.error) as error:
        raise ValueError(INVALID) from error

    def parts():
        yield from text_records(data, outline_start, outline_end, text_limit)
        for _, kind, body, stop in records(data, start, end):
            if kind == DRAWING:
                yield from shape_text(data, body, stop, text_limit)

    return count, parts()
