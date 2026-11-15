"""Incremental NUT v3/v4 binary stream parser and timed-frame packet utilities.

Reads FFmpeg `-f nut` streams chunk-by-chunk from a blocking binary pipe without
buffering the whole stream, preserving per-packet container PTS across rawvideo
(yuv420p) and pcm_s16le frames so RTMP and Interactive VC share one timeline.
"""

import os
import struct

NUT_MAGIC = b'nut/multimedia container\x00'
MAIN_SC = b'\x4e\x4d\x7a\x56\x1f\x5f\x04\xad'
STREAM_SC = b'\x4e\x53\x11\x40\x5b\xf2\xf9\xdb'
SYNC_SC = b'\x4e\x4b\xe4\xad\xee\xca\x45\x69'
INDEX_SC = b'\x4e\x58\xdd\x67\x2f\x23\xe6\x4e'
INFO_SC = b'\x4e\x49\xab\x68\xb5\x96\xba\x78'

FLAG_KEY = 1 << 0
FLAG_EOR = 1 << 1
FLAG_CODED_PTS = 1 << 3
FLAG_STREAM_ID = 1 << 4
FLAG_SIZE_MSB = 1 << 5
FLAG_CHECKSUM = 1 << 6
FLAG_RESERVED = 1 << 7
FLAG_SM_DATA = 1 << 8
FLAG_HEADER_IDX = 1 << 10
FLAG_MATCH_TIME = 1 << 11
FLAG_CODED = 1 << 12
FLAG_INVALID = 1 << 13

TIMED_PKT_MAGIC = b'LNF1'
TIMED_PKT_STRUCT = struct.Struct('<4sqQI')  # magic, pts_us (signed), dur_us (unsigned), payload_len


class _PipeByteSource:
    """Fast incremental byte buffer over a binary file/pipe object."""

    def __init__(self, stream, read_chunk=65536):
        self._stream = stream
        try:
            self._fd = stream.fileno() if hasattr(stream, 'fileno') else None
        except Exception:
            self._fd = None
        self._read_chunk = int(read_chunk)
        self._buf = bytearray()
        self._pos = 0
        self._eof = False

    def _compact(self):
        if self._pos > 0:
            if self._pos >= len(self._buf):
                self._buf.clear()
            else:
                del self._buf[:self._pos]
            self._pos = 0

    def _fill_at_least(self, need):
        avail = len(self._buf) - self._pos
        if avail >= need:
            return True
        if self._eof:
            return False
        if self._pos > 65536 or (self._pos > 0 and avail == 0):
            self._compact()
        while (len(self._buf) - self._pos) < need:
            to_read = max(self._read_chunk, need - (len(self._buf) - self._pos))
            if self._fd is not None:
                chunk = os.read(self._fd, to_read)
            else:
                chunk = self._stream.read(to_read)
            if not chunk:
                self._eof = True
                return (len(self._buf) - self._pos) >= need
            self._buf.extend(chunk)
        return True

    def peek_byte(self):
        if not self._fill_at_least(1):
            return None
        return self._buf[self._pos]

    def read_exact(self, n):
        if n <= 0:
            return b''
        if not self._fill_at_least(n):
            return None
        start = self._pos
        self._pos += n
        return bytes(self._buf[start:self._pos])

    def read_u8(self):
        if not self._fill_at_least(1):
            raise EOFError('unexpected EOF in NUT stream')
        b = self._buf[self._pos]
        self._pos += 1
        return b

    def read_v_recorded(self, raw_out):
        val = 0
        while True:
            b = self.read_u8()
            raw_out.append(b)
            val = (val << 7) | (b & 0x7F)
            if not (b & 0x80):
                return val

    def read_s_recorded(self, raw_out):
        v = self.read_v_recorded(raw_out)
        return -((v + 1) >> 1) if (v & 1) else (v >> 1)

    def read_bytes_recorded(self, n, raw_out):
        data = self.read_exact(n)
        if data is None or len(data) < n:
            raise EOFError('unexpected EOF reading fixed bytes in NUT stream')
        raw_out.extend(data)
        return data

    def read_exact_or_raise(self, n):
        data = self.read_exact(n)
        if data is None or len(data) < n:
            raise EOFError('unexpected EOF reading NUT payload')
        return data


def _read_v_mem(buf, pos):
    val = 0
    while True:
        b = buf[pos]
        pos += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            return val, pos


def _read_s_mem(buf, pos):
    v, pos = _read_v_mem(buf, pos)
    return (-((v + 1) >> 1) if (v & 1) else (v >> 1)), pos


def _skip_sm_data(src, raw_out):
    for _ in range(2):
        cnt = src.read_v_recorded(raw_out)
        for _j in range(cnt):
            _name_len = src.read_v_recorded(raw_out)
            src.read_bytes_recorded(_name_len, raw_out)
            val_len_or_type = src.read_s_recorded(raw_out)
            if val_len_or_type == -1:
                slen = src.read_v_recorded(raw_out)
                src.read_bytes_recorded(slen, raw_out)
            elif val_len_or_type <= -2:
                if val_len_or_type == -4:
                    _ = src.read_v_recorded(raw_out)
                    src.read_v_recorded(raw_out)
                elif val_len_or_type != -2:
                    src.read_v_recorded(raw_out)
            # Non-negative values encode integers directly, -2/-3 read one more v/s below:
            if val_len_or_type in (-2, -3):
                src.read_v_recorded(raw_out)


def _skip_sm_data_safe(src, raw_out):
    """Consume NUT side/meta data entries according to NUT specification."""
    for _ in range(2):
        count = src.read_v_recorded(raw_out)
        for _j in range(count):
            name_len = src.read_v_recorded(raw_out)
            src.read_bytes_recorded(name_len, raw_out)
            type_val = src.read_s_recorded(raw_out)
            if type_val == -1:
                slen = src.read_v_recorded(raw_out)
                src.read_bytes_recorded(slen, raw_out)
            elif type_val == -2:
                tlen = src.read_v_recorded(raw_out)
                src.read_bytes_recorded(tlen, raw_out)
                vlen = src.read_v_recorded(raw_out)
                src.read_bytes_recorded(vlen, raw_out)
            elif type_val == -3:
                src.read_s_recorded(raw_out)
            elif type_val == -4:
                src.read_v_recorded(raw_out)
                src.read_v_recorded(raw_out)


class NutStreamReader:
    """Incrementally yields NUT control packets and decoded-metadata frame packets."""

    def __init__(self, stream):
        self._src = _PipeByteSource(stream)
        self.time_bases = []
        self.frame_table = [None] * 256
        self.header_elision = [b'']
        self.streams = {}

    def _parse_main_header(self, payload):
        q = 0
        payload_end = len(payload)
        ver, q = _read_v_mem(payload, q)
        if ver > 3:
            _, q = _read_v_mem(payload, q)  # minor_version
        _scount, q = _read_v_mem(payload, q)
        _max_dist, q = _read_v_mem(payload, q)
        tb_cnt, q = _read_v_mem(payload, q)
        self.time_bases = []
        for _ in range(tb_cnt):
            num, q = _read_v_mem(payload, q)
            den, q = _read_v_mem(payload, q)
            self.time_bases.append((max(1, num), max(1, den)))

        self.frame_table = [None] * 256
        tmp_pts = 0
        tmp_mul = 1
        tmp_stream = 0
        tmp_res = 0
        tmp_match = 0
        tmp_head = 0
        fc = 0
        while fc < 256:
            tmp_flags, q = _read_v_mem(payload, q)
            tmp_fields, q = _read_v_mem(payload, q)
            if tmp_fields > 0:
                tmp_pts, q = _read_s_mem(payload, q)
            if tmp_fields > 1:
                tmp_mul, q = _read_v_mem(payload, q)
            if tmp_fields > 2:
                tmp_stream, q = _read_v_mem(payload, q)
            if tmp_fields > 3:
                tmp_size, q = _read_v_mem(payload, q)
            else:
                tmp_size = 0
            if tmp_fields > 4:
                tmp_res, q = _read_v_mem(payload, q)
            else:
                tmp_res = 0
            if tmp_fields > 5:
                count, q = _read_v_mem(payload, q)
            else:
                count = max(1, tmp_mul - tmp_size)
            if tmp_fields > 6:
                tmp_match, q = _read_s_mem(payload, q)
            if tmp_fields > 7:
                tmp_head, q = _read_v_mem(payload, q)
            for _ in range(count):
                if fc == ord('N'):
                    self.frame_table[fc] = {
                        'flags': FLAG_INVALID,
                        'stream': 0,
                        'mul': 1,
                        'size_lsb': 0,
                        'pts': 0,
                        'res': 0,
                        'header_idx': 0,
                    }
                    fc += 1
                if fc >= 256:
                    break
                self.frame_table[fc] = {
                    'flags': tmp_flags,
                    'stream': tmp_stream,
                    'mul': tmp_mul,
                    'size_lsb': tmp_size,
                    'pts': tmp_pts,
                    'res': tmp_res,
                    'header_idx': tmp_head,
                }
                tmp_size += 1
                fc += 1

        self.header_elision = [b'']
        if q < payload_end:
            hc_m1, q = _read_v_mem(payload, q)
            for _ in range(hc_m1):
                if q >= payload_end:
                    break
                hlen, q = _read_v_mem(payload, q)
                self.header_elision.append(bytes(payload[q:q + hlen]))
                q += hlen
        # Consume optional v4 flags / tail bytes harmlessly if present

    def _parse_stream_header(self, payload):
        q = 0
        sid, q = _read_v_mem(payload, q)
        sclass, q = _read_v_mem(payload, q)
        flen, q = _read_v_mem(payload, q)
        fourcc = bytes(payload[q:q + flen])
        q += flen
        tb_id, q = _read_v_mem(payload, q)
        msb_shift, q = _read_v_mem(payload, q)
        _max_pts_dist, q = _read_v_mem(payload, q)
        tb = self.time_bases[tb_id] if tb_id < len(self.time_bases) else (1, 1000)
        self.streams[sid] = {
            'id': sid,
            'class': sclass,
            'fourcc': fourcc,
            'tb': tb,
            'msb_shift': msb_shift,
            'last_pts': 0,
        }

    def _parse_syncpoint(self, payload):
        if not self.time_bases:
            return
        q = 0
        pts_val, q = _read_v_mem(payload, q)
        tb_idx = pts_val % len(self.time_bases)
        pts_t = pts_val // len(self.time_bases)
        num, den = self.time_bases[tb_idx]
        for st in self.streams.values():
            st_num, st_den = st['tb']
            st['last_pts'] = (pts_t * num * st_den) // (den * st_num)

    def iter_packets(self):
        """Yield ('magic', raw) | ('control', sc, raw) | ('frame', info_dict, hdr_raw, elision, payload)."""
        try:
            yield from self._iter_packets_inner()
        except EOFError:
            return

    def _iter_packets_inner(self):
        magic = self._src.read_exact(len(NUT_MAGIC))
        if not magic:
            return
        if magic != NUT_MAGIC:
            raise ValueError(f'Unexpected NUT header magic: {magic!r}')
        yield ('magic', magic)

        while True:
            b0 = self._src.peek_byte()
            if b0 is None:
                break
            if b0 == 0x4E:  # 'N' startcode control packet
                raw = bytearray()
                sc = self._src.read_bytes_recorded(8, raw)
                fptr = self._src.read_v_recorded(raw)
                if fptr > 4096:
                    self._src.read_bytes_recorded(4, raw)  # header_checksum
                if fptr < 4:
                    raise ValueError(f'Invalid NUT packet forward_ptr={fptr}')
                payload = self._src.read_bytes_recorded(fptr - 4, raw)
                self._src.read_bytes_recorded(4, raw)  # tail checksum
                if sc == MAIN_SC:
                    self._parse_main_header(payload)
                elif sc == STREAM_SC:
                    self._parse_stream_header(payload)
                elif sc == SYNC_SC:
                    self._parse_syncpoint(payload)
                yield ('control', sc, bytes(raw))
                continue

            hdr_raw = bytearray()
            fc_byte = self._src.read_u8()
            hdr_raw.append(fc_byte)
            ft = self.frame_table[fc_byte]
            if ft is None:
                raise ValueError(f'Uninitialized NUT frame code {fc_byte}')
            flags = ft['flags']
            sid = ft['stream']
            pts_delta = ft['pts']
            size = ft['size_lsb']
            mul = ft['mul']
            res = ft['res']
            hidx = ft['header_idx']

            if flags & FLAG_CODED:
                cf = self._src.read_v_recorded(hdr_raw)
                flags ^= cf
            if flags & FLAG_INVALID:
                raise ValueError(f'Invalid NUT frame flags fc={fc_byte} flags=0x{flags:x}')
            if flags & FLAG_STREAM_ID:
                sid = self._src.read_v_recorded(hdr_raw)
            st = self.streams.get(sid)
            if st is None:
                raise ValueError(f'Unknown NUT stream_id={sid}')

            if flags & FLAG_CODED_PTS:
                cpts = self._src.read_v_recorded(hdr_raw)
                msb_shift = st['msb_shift']
                limit = 1 << msb_shift
                mask = limit - 1
                if cpts < limit:
                    delta = st['last_pts'] - (mask // 2)
                    pts = ((cpts - delta) & mask) + delta
                else:
                    pts = cpts - limit
            else:
                pts = st['last_pts'] + pts_delta
            st['last_pts'] = pts

            if flags & FLAG_SIZE_MSB:
                msb = self._src.read_v_recorded(hdr_raw)
                size += mul * msb
            if flags & FLAG_MATCH_TIME:
                _ = self._src.read_s_recorded(hdr_raw)
            if flags & FLAG_HEADER_IDX:
                hidx = self._src.read_v_recorded(hdr_raw)
            if flags & FLAG_RESERVED:
                res = self._src.read_v_recorded(hdr_raw)
            for _ in range(res):
                _ = self._src.read_v_recorded(hdr_raw)
            if flags & FLAG_CHECKSUM:
                self._src.read_bytes_recorded(4, hdr_raw)
            if flags & FLAG_SM_DATA:
                _skip_sm_data_safe(self._src, hdr_raw)

            el = self.header_elision[hidx] if hidx < len(self.header_elision) else b''
            payload_len = max(0, size - len(el))
            payload = self._src.read_exact_or_raise(payload_len)

            num, den = st['tb']
            pts_sec = (pts * num) / float(den)
            info = {
                'stream_id': sid,
                'stream_class': st['class'],
                'pts': pts,
                'tb': st['tb'],
                'pts_sec': pts_sec,
                'pts_us': int(round(pts_sec * 1_000_000.0)),
                'is_key': bool(flags & FLAG_KEY),
                'is_eor': bool(flags & FLAG_EOR),
            }
            yield ('frame', info, bytes(hdr_raw), el, payload)


def write_fd_all(fd, *buffers):
    """Write buffers atomically without partial-write loss using writev on Linux."""
    items = [memoryview(b) for b in buffers if b]
    if not items:
        return
    if len(items) == 1:
        view = items[0]
        off = 0
        total = len(view)
        while off < total:
            n = os.write(fd, view[off:])
            if n <= 0:
                raise BrokenPipeError('pipe closed during write')
            off += n
        return
    # Flatten small batches with writev and fall back safely if partial write occurs
    idx = 0
    item_off = 0
    while idx < len(items):
        vecs = [items[idx][item_off:]] + items[idx + 1:]
        n = os.writev(fd, vecs)
        if n <= 0:
            raise BrokenPipeError('pipe closed during writev')
        rem = n
        while idx < len(items) and rem > 0:
            cur_len = len(items[idx]) - item_off
            if rem >= cur_len:
                rem -= cur_len
                idx += 1
                item_off = 0
            else:
                item_off += rem
                rem = 0


def pack_timed_frame(pts_us, dur_us, payload):
    """Serialize one timed rawvideo/PCM frame for hub -> av_sync Unix socket transport."""
    hdr = TIMED_PKT_STRUCT.pack(TIMED_PKT_MAGIC, int(pts_us), max(0, int(dur_us)), len(payload))
    return hdr, payload


def send_timed_frame(sock, pts_us, dur_us, payload):
    """Send header + payload cleanly over a stream socket."""
    hdr, body = pack_timed_frame(pts_us, dur_us, payload)
    sock.sendall(hdr)
    if body:
        sock.sendall(body)


def _recv_exact(sock, size):
    buf = bytearray()
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def recv_timed_frame(sock):
    """Receive next timed frame (pts_us, dur_us, payload) or None on EOF."""
    hdr = _recv_exact(sock, TIMED_PKT_STRUCT.size)
    if not hdr:
        return None
    magic, pts_us, dur_us, plen = TIMED_PKT_STRUCT.unpack(hdr)
    if magic != TIMED_PKT_MAGIC:
        raise ValueError(f'Corrupt timed frame magic: {magic!r}')
    if plen == 0:
        return int(pts_us), int(dur_us), b''
    payload = _recv_exact(sock, plen)
    if payload is None:
        return None
    return int(pts_us), int(dur_us), payload
