package main

// Helpers shared by the file-read and file-write executors (ports of
// FileReadExecutor.ts / FileWriteExecutor.ts). They reproduce the JavaScript
// and Node.js behaviour those executors rely on: String(v), Number(v),
// JSON.stringify, String.prototype.trim, path.join/extname, Buffer and
// iconv-lite encodings, and the wording of Node's fs errors.

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
)

// ── JavaScript value semantics ───────────────────────────────────────────────

// fioUndef is JavaScript's undefined where a Go nil would mean null.
type fioUndefT struct{}

var fioUndef = &fioUndefT{}

// fioJSMap stands for a JS Map object (context.variables / nodeResults) when
// a template walks the execution context itself.
type fioJSMap struct{ size int }

// fioNum formats a float like JavaScript's Number.prototype.toString.
func fioNum(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±xx
	mant, expS, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expS)
	k, n := len(digits), exp+1
	var s string
	switch {
	case k <= n && n <= 21:
		s = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		s = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		s = "0." + strings.Repeat("0", -n) + digits
	default:
		s = digits[:1]
		if k > 1 {
			s += "." + digits[1:]
		}
		es := n - 1
		if es >= 0 {
			s += "e+" + strconv.Itoa(es)
		} else {
			s += "e-" + strconv.Itoa(-es)
		}
	}
	return sign + s
}

// fioStr is JavaScript's String(v).
func fioStr(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case *fioUndefT:
		return "undefined"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return fioNum(t)
	case float32:
		return fioNum(float64(t))
	case int:
		return strconv.Itoa(t)
	case int32:
		return strconv.FormatInt(int64(t), 10)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		f, _ := t.Float64()
		return fioNum(f)
	case []any:
		parts := make([]string, len(t))
		for i, x := range t {
			if x == nil || x == fioUndef {
				continue
			}
			parts[i] = fioStr(x)
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(t, ",")
	case *fioJSMap:
		return "[object Map]"
	case time.Time:
		return fioDateString(t)
	}
	return "[object Object]"
}

// fioDateString is Date.prototype.toString.
func fioDateString(t time.Time) string { return jsDateString(t) }

// fioToNumber is JavaScript's Number(v).
func fioToNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case *fioUndefT:
		return math.NaN()
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case string:
		s := fioTrim(t)
		if s == "" {
			return 0
		}
		if len(s) > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X' || s[1] == 'o' || s[1] == 'O' || s[1] == 'b' || s[1] == 'B') {
			base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
			if n, err := strconv.ParseUint(s[2:], base, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
		switch s {
		case "Infinity", "+Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		}
		for _, c := range s {
			if !(c >= '0' && c <= '9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
				return math.NaN()
			}
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			var ne *strconv.NumError
			if errors.As(err, &ne) && ne.Err == strconv.ErrRange {
				return f
			}
			return math.NaN()
		}
		return f
	case []any:
		if len(t) == 0 {
			return 0
		}
		if len(t) == 1 {
			return fioToNumber(fioStr(t[0]))
		}
		return math.NaN()
	}
	return math.NaN()
}

// fioTruthy is JavaScript truthiness.
func fioTruthy(v any) bool {
	switch t := v.(type) {
	case nil, *fioUndefT:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case int:
		return t != 0
	case int64:
		return t != 0
	case string:
		return t != ""
	}
	return true
}

// fioIsJSSpace reports whether r is whitespace for String.prototype.trim
// (WhiteSpace + LineTerminator, which includes the BOM U+FEFF).
func fioIsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// fioTrim is String.prototype.trim.
func fioTrim(s string) string { return strings.TrimFunc(s, fioIsJSSpace) }

// fioLen16 is a JavaScript string's .length (UTF-16 code units).
func fioLen16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// fioKeys is Object.keys(v). Go maps do not keep insertion order, so object
// keys come back sorted (see the README of the port).
func fioKeys(v any) []string {
	switch t := v.(type) {
	case map[string]any:
		return jsKeys(t)
	case []any:
		out := make([]string, len(t))
		for i := range t {
			out[i] = strconv.Itoa(i)
		}
		return out
	case string:
		n := len(utf16.Encode([]rune(t)))
		out := make([]string, n)
		for i := range out {
			out[i] = strconv.Itoa(i)
		}
		return out
	}
	return []string{}
}

// fioSortedKeys orders keys like V8 does for integer-like keys (ascending
// numerically first), then the rest sorted (insertion order is unknown).
func fioSortedKeys(m map[string]any) []string {
	var ints []string
	var rest []string
	for k := range m {
		if fioIsArrayIndex(k) {
			ints = append(ints, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(ints, func(i, j int) bool {
		a, _ := strconv.ParseUint(ints[i], 10, 64)
		b, _ := strconv.ParseUint(ints[j], 10, 64)
		return a < b
	})
	sort.Strings(rest)
	return append(ints, rest...)
}

func fioIsArrayIndex(k string) bool {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(k, 10, 32)
	return err == nil && n < math.MaxUint32
}

// fioProp reads v[k] like JavaScript (undefined → fioUndef).
func fioProp(v any, k string) any {
	switch t := v.(type) {
	case map[string]any:
		if x, ok := t[k]; ok {
			return x
		}
	case []any:
		if k == "length" {
			return float64(len(t))
		}
		if fioIsArrayIndex(k) {
			if i, _ := strconv.Atoi(k); i < len(t) {
				return t[i]
			}
		}
	case string:
		u := utf16.Encode([]rune(t))
		if k == "length" {
			return float64(len(u))
		}
		if fioIsArrayIndex(k) {
			if i, _ := strconv.Atoi(k); i < len(u) {
				return string(utf16.Decode(u[i : i+1]))
			}
		}
	case *fioJSMap:
		if k == "size" {
			return float64(t.size)
		}
	}
	return fioUndef
}

// fioHasOwn is Object.prototype.hasOwnProperty.call(v, k).
func fioHasOwn(v any, k string) bool {
	switch t := v.(type) {
	case map[string]any:
		_, ok := t[k]
		return ok
	case []any, string:
		if k == "length" {
			return true
		}
		return fioProp(v, k) != fioUndef
	}
	return false
}

// fioTypeErrProp is V8's message for reading a property of null/undefined.
func fioTypeErrProp(v any, prop string) error {
	what := "null"
	if v == fioUndef {
		what = "undefined"
	}
	return fmt.Errorf("Cannot read properties of %s (reading '%s')", what, prop)
}

// ── JSON.stringify ───────────────────────────────────────────────────────────

// fioJSON is JSON.stringify(v, null, indent) ("" = compact).
func fioJSON(v any, indent string) string {
	var b strings.Builder
	fioJSONWrite(&b, v, indent, "")
	return b.String()
}

func fioJSONWrite(b *strings.Builder, v any, indent, cur string) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool, float64, int, int64, json.Number:
		if f, ok := t.(float64); ok && (math.IsNaN(f) || math.IsInf(f, 0)) {
			b.WriteString("null")
			return
		}
		b.WriteString(fioStr(t))
	case string:
		fioJSONQuote(b, t)
	case time.Time:
		fioJSONQuote(b, fioISO(t))
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		inner := cur + indent
		b.WriteByte('[')
		for i, x := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			if x == fioUndef {
				x = nil
			}
			fioJSONWrite(b, x, indent, inner)
		}
		if indent != "" {
			b.WriteString("\n" + cur)
		}
		b.WriteByte(']')
	case map[string]any:
		keys := fioSortedKeys(t)
		inner := cur + indent
		n := 0
		b.WriteByte('{')
		for _, k := range keys {
			if t[k] == fioUndef {
				continue
			}
			if n > 0 {
				b.WriteByte(',')
			}
			n++
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			fioJSONQuote(b, k)
			b.WriteByte(':')
			if indent != "" {
				b.WriteByte(' ')
			}
			fioJSONWrite(b, t[k], indent, inner)
		}
		if n > 0 && indent != "" {
			b.WriteString("\n" + cur)
		}
		b.WriteByte('}')
	case *fioOrdered:
		inner := cur + indent
		b.WriteByte('{')
		n := 0
		for i, k := range t.keys {
			if t.vals[i] == fioUndef {
				continue
			}
			if n > 0 {
				b.WriteByte(',')
			}
			n++
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			fioJSONQuote(b, k)
			b.WriteByte(':')
			if indent != "" {
				b.WriteByte(' ')
			}
			fioJSONWrite(b, t.vals[i], indent, inner)
		}
		if n > 0 && indent != "" {
			b.WriteString("\n" + cur)
		}
		b.WriteByte('}')
	default:
		raw, err := json.Marshal(t)
		if err != nil {
			b.WriteString("null")
			return
		}
		var back any
		_ = json.Unmarshal(raw, &back)
		fioJSONWrite(b, back, indent, cur)
	}
}

func fioJSONQuote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// fioOrdered is an object literal with a fixed key order, used only for the
// JSON strings the TS writes into metadata columns.
type fioOrdered struct {
	keys []string
	vals []any
}

func fioObj(kv ...any) *fioOrdered {
	o := &fioOrdered{}
	for i := 0; i+1 < len(kv); i += 2 {
		o.keys = append(o.keys, kv[i].(string))
		o.vals = append(o.vals, kv[i+1])
	}
	return o
}

// fioISO is Date.prototype.toISOString.
func fioISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// ── Node path ────────────────────────────────────────────────────────────────

// fioJoin is path.posix.join (normalises, keeps a trailing slash).
func fioJoin(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	return fioNormalize(strings.Join(nonEmpty, "/"))
}

func fioNormalize(p string) string {
	if p == "" {
		return "."
	}
	abs := strings.HasPrefix(p, "/")
	trailing := strings.HasSuffix(p, "/")
	var out []string
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".":
			continue
		case "..":
			if len(out) > 0 && out[len(out)-1] != ".." {
				out = out[:len(out)-1]
			} else if !abs {
				out = append(out, "..")
			}
		default:
			out = append(out, seg)
		}
	}
	s := strings.Join(out, "/")
	if s == "" && !abs {
		s = "."
	}
	if s != "" && trailing {
		s += "/"
	}
	if abs {
		s = "/" + s
	}
	return s
}

// fioBase is path.basename.
func fioBase(p string) string {
	p = strings.TrimRight(p, "/")
	if p == "" {
		return ""
	}
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// fioDir is path.dirname.
func fioDir(p string) string {
	if p == "" {
		return "."
	}
	abs := p[0] == '/'
	end := len(p)
	for end > 1 && p[end-1] == '/' {
		end--
	}
	i := strings.LastIndex(p[:end], "/")
	if i < 0 {
		return "."
	}
	if i == 0 && abs {
		return "/"
	}
	return p[:i]
}

// fioExt is path.extname.
func fioExt(p string) string {
	b := fioBase(p)
	i := strings.LastIndex(b, ".")
	if i <= 0 {
		return ""
	}
	return b[i:]
}

// ── Node fs ──────────────────────────────────────────────────────────────────

var fioErrnoText = map[syscall.Errno][2]string{
	syscall.ENOENT:       {"ENOENT", "no such file or directory"},
	syscall.EACCES:       {"EACCES", "permission denied"},
	syscall.EPERM:        {"EPERM", "operation not permitted"},
	syscall.EISDIR:       {"EISDIR", "illegal operation on a directory"},
	syscall.ENOTDIR:      {"ENOTDIR", "not a directory"},
	syscall.EEXIST:       {"EEXIST", "file already exists"},
	syscall.ENOSPC:       {"ENOSPC", "no space left on device"},
	syscall.EMFILE:       {"EMFILE", "too many open files"},
	syscall.EROFS:        {"EROFS", "read-only file system"},
	syscall.ENAMETOOLONG: {"ENAMETOOLONG", "name too long"},
	syscall.ELOOP:        {"ELOOP", "too many symbolic links encountered"},
	syscall.EBUSY:        {"EBUSY", "resource busy or locked"},
}

// fioFsErr words an os error the way Node's fs module does, e.g.
// "ENOENT: no such file or directory, open '/x'".
func fioFsErr(err error) error {
	var pe *fs.PathError
	if !errors.As(err, &pe) {
		return err
	}
	var errno syscall.Errno
	if !errors.As(pe.Err, &errno) {
		return err
	}
	t, ok := fioErrnoText[errno]
	if !ok {
		return err
	}
	op := pe.Op
	if op == "read" || op == "write" {
		return fmt.Errorf("%s: %s, %s", t[0], t[1], op)
	}
	return fmt.Errorf("%s: %s, %s '%s'", t[0], t[1], op, pe.Path)
}

func fioExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func fioStat(p string) (os.FileInfo, error) {
	st, err := os.Stat(p)
	if err != nil {
		var pe *fs.PathError
		if errors.As(err, &pe) {
			pe.Op = "stat"
		}
		return nil, fioFsErr(err)
	}
	return st, nil
}

func fioReadFile(p string) ([]byte, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, fioFsErr(err)
	}
	return b, nil
}

func fioMkdirAll(p string) error {
	if err := os.MkdirAll(p, 0o777); err != nil {
		var pe *fs.PathError
		if errors.As(err, &pe) {
			pe.Op = "mkdir"
		}
		return fioFsErr(err)
	}
	return nil
}

func fioWriteFile(p string, b []byte) error {
	if err := os.WriteFile(p, b, 0o666); err != nil {
		return fioFsErr(err)
	}
	return nil
}

// ── Encodings (Buffer encodings + iconv-lite) ────────────────────────────────

// fioBufferEnc normalises a Node Buffer encoding name ("" if it is not one).
func fioBufferEnc(enc string) string {
	switch strings.ToLower(enc) {
	case "utf8", "utf-8":
		return "utf8"
	case "ucs2", "ucs-2", "utf16le", "utf-16le":
		return "utf16le"
	case "latin1", "binary":
		return "latin1"
	case "ascii":
		return "ascii"
	case "base64":
		return "base64"
	case "base64url":
		return "base64url"
	case "hex":
		return "hex"
	}
	return ""
}

// fioDecodeUTF8 decodes like Buffer#toString('utf8'): every invalid byte
// becomes U+FFFD, the BOM is kept.
func fioDecodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n <= 1 {
			sb.WriteRune(utf8.RuneError)
			b = b[fioMaximalSubpart(b):]
			continue
		}
		sb.WriteRune(r)
		b = b[n:]
	}
	return sb.String()
}

// fioMaximalSubpart is the length of the invalid sequence at the start of b
// that the WHATWG decoder (Node's) turns into one U+FFFD.
func fioMaximalSubpart(b []byte) int {
	c := b[0]
	var need int
	lo, hi := byte(0x80), byte(0xBF)
	switch {
	case c >= 0xC2 && c <= 0xDF:
		need = 1
	case c == 0xE0:
		need, lo = 2, 0xA0
	case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
		need = 2
	case c == 0xED:
		need, hi = 2, 0x9F
	case c == 0xF0:
		need, lo = 3, 0x90
	case c >= 0xF1 && c <= 0xF3:
		need = 3
	case c == 0xF4:
		need, hi = 3, 0x8F
	default:
		return 1
	}
	n := 1
	for i := 0; i < need && n < len(b); i++ {
		x := b[n]
		if i > 0 {
			lo, hi = 0x80, 0xBF
		}
		if x < lo || x > hi {
			break
		}
		n++
	}
	return n
}

// fioBufferDecode is buf.toString(enc) for a Buffer encoding.
func fioBufferDecode(b []byte, enc string) string {
	switch enc {
	case "utf8":
		return fioDecodeUTF8(b)
	case "utf16le":
		u := make([]uint16, len(b)/2)
		for i := range u {
			u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
		}
		return string(utf16.Decode(u))
	case "latin1":
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c)
		}
		return string(r)
	case "ascii":
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c & 0x7f)
		}
		return string(r)
	case "base64":
		return base64.StdEncoding.EncodeToString(b)
	case "base64url":
		return base64.RawURLEncoding.EncodeToString(b)
	case "hex":
		return hex.EncodeToString(b)
	}
	return fioDecodeUTF8(b)
}

// fioBufferEncode is Buffer.from(s, enc) / fs.writeFileSync(p, s, {encoding}).
func fioBufferEncode(s string, enc string) ([]byte, error) {
	be := fioBufferEnc(enc)
	switch be {
	case "utf8":
		return []byte(s), nil
	case "utf16le":
		u := utf16.Encode([]rune(s))
		out := make([]byte, 2*len(u))
		for i, c := range u {
			out[2*i], out[2*i+1] = byte(c), byte(c>>8)
		}
		return out, nil
	case "latin1", "ascii":
		u := utf16.Encode([]rune(s))
		out := make([]byte, len(u))
		for i, c := range u {
			out[i] = byte(c)
		}
		return out, nil
	case "base64", "base64url":
		clean := strings.Map(func(r rune) rune {
			switch {
			case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
				return r
			case r == '+' || r == '-':
				return '+'
			case r == '/' || r == '_':
				return '/'
			}
			return -1
		}, s)
		out, _ := base64.RawStdEncoding.DecodeString(strings.TrimRight(clean, "="))
		if out == nil {
			// Node decodes as many whole bytes as it can.
			for n := len(clean); n > 0 && out == nil; n-- {
				out, _ = base64.RawStdEncoding.DecodeString(clean[:n])
			}
		}
		return out, nil
	case "hex":
		var out []byte
		for i := 0; i+1 < len(s); i += 2 {
			b, err := hex.DecodeString(s[i : i+2])
			if err != nil {
				break
			}
			out = append(out, b...)
		}
		return out, nil
	}
	return nil, fmt.Errorf("The argument '%s' is invalid encoding. Received 'encoding'", enc)
}

// iconv-lite: names are matched lower-case without non-alphanumerics.
var fioIconvNorm = regexp.MustCompile(`:\d{4}$|[^0-9a-z]`)

const fioFFFD = '�'

// fioThai decodes the Thai single-byte code pages exactly as iconv-lite's
// tables do (tis620: no C1 range and no 0xA0; windows874: cp874 extras;
// iso885911: C1 controls and NBSP).
func fioThai(b []byte, variant string) string {
	r := make([]rune, 0, len(b))
	for _, c := range b {
		switch {
		case c < 0x80:
			r = append(r, rune(c))
		case (c >= 0xA1 && c <= 0xDA) || (c >= 0xDF && c <= 0xFB):
			r = append(r, rune(0x0E00+int(c)-0xA0))
		case c == 0xA0:
			if variant == "tis620" {
				r = append(r, fioFFFD)
			} else {
				r = append(r, 0xA0)
			}
		case c < 0xA0:
			switch variant {
			case "iso885911":
				r = append(r, rune(c))
			case "windows874":
				if x, ok := map[byte]rune{0x80: 0x20AC, 0x85: 0x2026, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014}[c]; ok {
					r = append(r, x)
				} else {
					r = append(r, fioFFFD)
				}
			default:
				r = append(r, fioFFFD)
			}
		default:
			r = append(r, fioFFFD)
		}
	}
	return string(r)
}

var fioIconvAliases = map[string]string{
	"874": "windows874", "windows874": "windows874", "win874": "windows874", "cp874": "windows874",
	"tis620": "tis620", "tis6200": "tis620", "tis62025291": "tis620", "tis62025330": "tis620", "isoir166": "tis620",
	"iso885911": "iso885911", "cp28601": "iso885911", "28601": "iso885911", "thai": "iso885911", "thai8": "iso885911",
	"utf8": "utf8", "unicode11utf8": "utf8", "utf16le": "utf16le", "ucs2": "utf16le", "utf16be": "utf16be", "utf16": "utf16",
	"latin1": "iso88591", "binary": "iso88591", "iso88591": "iso88591", "l1": "iso88591", "ascii": "ascii", "usascii": "ascii",
}

var fioCharmaps = map[string]encoding.Encoding{
	"iso88592": charmap.ISO8859_2, "iso88595": charmap.ISO8859_5, "iso885915": charmap.ISO8859_15,
	"windows1250": charmap.Windows1250, "windows1251": charmap.Windows1251, "windows1252": charmap.Windows1252,
	"cp1250": charmap.Windows1250, "cp1251": charmap.Windows1251, "cp1252": charmap.Windows1252,
	"cp437": charmap.CodePage437, "cp850": charmap.CodePage850, "cp866": charmap.CodePage866, "koi8r": charmap.KOI8R,
}

// fioIconvDecode is iconv.decode(buf, enc) (BOM stripped like iconv-lite).
func fioIconvDecode(b []byte, enc string) (string, error) {
	n := fioIconvNorm.ReplaceAllString(strings.ToLower(enc), "")
	name := fioIconvAliases[n]
	var s string
	switch name {
	case "tis620", "windows874", "iso885911":
		s = fioThai(b, name)
	case "utf8":
		s = fioDecodeUTF8(b)
	case "utf16le":
		s = fioBufferDecode(b, "utf16le")
	case "utf16be", "utf16":
		e := unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)
		if name == "utf16" {
			e = unicode.UTF16(unicode.LittleEndian, unicode.UseBOM)
			if len(b) >= 2 && b[0] == 0xFE && b[1] == 0xFF {
				e = unicode.UTF16(unicode.BigEndian, unicode.UseBOM)
			}
		}
		out, _ := e.NewDecoder().Bytes(b)
		s = string(out)
	case "iso88591":
		s = fioBufferDecode(b, "latin1")
	case "ascii":
		s = fioBufferDecode(b, "ascii")
	default:
		cm, ok := fioCharmaps[n]
		if !ok {
			return "", fmt.Errorf("Encoding not recognized: '%s' (searched as: '%s')", enc, n)
		}
		out, _ := cm.NewDecoder().Bytes(b)
		s = string(out)
	}
	return strings.TrimPrefix(s, "\uFEFF"), nil
}

// fioDecode reads bytes as text the way FileReadExecutor does: Buffer
// encodings through fs (BOM kept), anything else through iconv-lite.
func fioDecode(b []byte, enc string) (string, error) {
	if be := fioBufferEnc(enc); be != "" {
		return fioBufferDecode(b, be), nil
	}
	return fioIconvDecode(b, enc)
}

// ── Globs ────────────────────────────────────────────────────────────────────

// fioJSRegex compiles a JS regex source with Go's regexp (the translated
// globs only use syntax both engines share).
func fioJSRegex(src string, ci bool) (*regexp.Regexp, error) {
	if ci {
		src = "(?i)" + src
	}
	re, err := regexp.Compile(src)
	if err != nil {
		return nil, fmt.Errorf("Invalid regular expression: /%s/: %v", src, err)
	}
	return re, nil
}

// ── Date placeholders ────────────────────────────────────────────────────────

func fioPad2(n int) string { return fmt.Sprintf("%02d", n) }

// ── MIME ─────────────────────────────────────────────────────────────────────

func fioMime(fileName string, contentType any) string {
	if ct, ok := contentType.(string); ok && ct != "" && ct != "auto" {
		return ct
	}
	if contentType != nil && contentType != fioUndef {
		if _, isStr := contentType.(string); !isStr && fioTruthy(contentType) {
			return fioStr(contentType)
		}
	}
	switch strings.ToLower(fioExt(fileName)) {
	case ".csv":
		return "text/csv"
	case ".txt":
		return "text/plain"
	case ".json":
		return "application/json"
	case ".xml":
		return "application/xml"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".pdf":
		return "application/pdf"
	case ".zip":
		return "application/zip"
	}
	return "application/octet-stream"
}

// fioData reads node.data[k] keeping the difference between a missing key
// (undefined) and null.
func fioData(d map[string]any, k string) any {
	if v, ok := d[k]; ok {
		return v
	}
	return fioUndef
}

// fioStrOr is `data.k || def` for a string option.
func fioStrOr(d map[string]any, k, def string) string {
	v := fioData(d, k)
	if !fioTruthy(v) {
		return def
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fioStr(v)
}
