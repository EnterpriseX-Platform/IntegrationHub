package main

// Shared helpers for the sftp-action, basket-action and basket-trigger
// executors (ports of SFTPActionExecutor.ts, sftpFolderSync.ts,
// BasketActionExecutor.ts, BasketTriggerExecutor.ts). Everything here is
// prefixed "sb" so it cannot clash with helpers other executors add.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// ── Node's path module (posix) ───────────────────────────────────────────────

// sbNormalize ports path.posix.normalize.
func sbNormalize(p string) string {
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
		return "/" + s
	}
	return s
}

// sbJoin ports path.posix.join (and path.join on Linux/macOS).
func sbJoin(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	return sbNormalize(strings.Join(nonEmpty, "/"))
}

// sbBasename ports path.basename(p[, ext]).
func sbBasename(p string, ext ...string) string {
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	if p == "/" {
		return ""
	}
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	if len(ext) > 0 && ext[0] != "" && p != ext[0] && strings.HasSuffix(p, ext[0]) {
		p = p[:len(p)-len(ext[0])]
	}
	return p
}

// sbDirname ports path.dirname.
func sbDirname(p string) string {
	if p == "" {
		return "."
	}
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	i := strings.LastIndex(p, "/")
	if i < 0 {
		return "."
	}
	if i == 0 {
		return "/"
	}
	return p[:i]
}

// sbExtname ports path.extname ('.bashrc' has no extension, 'a.' has '.').
func sbExtname(p string) string {
	b := sbBasename(p)
	i := strings.LastIndex(b, ".")
	if i <= 0 {
		return ""
	}
	// Leading dots do not start an extension.
	if strings.TrimLeft(b[:i], ".") == "" {
		return ""
	}
	return b[i:]
}

// ── Glob patterns, built exactly like the TS (no escaping beyond '.') ───────

// sbGlobLoose: '^' + p.replace(/\./g,'\\.').replace(/\*/g,'.*').replace(/\?/g,'.') + '$'
func sbGlobLoose(pattern string, ignoreCase bool) (*regexp.Regexp, error) {
	s := strings.ReplaceAll(pattern, ".", `\.`)
	s = strings.ReplaceAll(s, "*", ".*")
	s = strings.ReplaceAll(s, "?", ".")
	s = "^" + s + "$"
	if ignoreCase {
		s = "(?i)" + s
	}
	re, err := regexp.Compile(s)
	if err != nil {
		return nil, fmt.Errorf("Invalid regular expression: /%s/: %s", strings.TrimPrefix(s, "(?i)"), err.Error())
	}
	return re, nil
}

// sbGlobStrict ports sftpFolderSync's globToRegex (escapes regex specials, 'i').
func sbGlobStrict(pattern string) *regexp.Regexp {
	var b strings.Builder
	for _, r := range pattern {
		switch r {
		case '.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteRune(r)
		}
	}
	return regexp.MustCompile("(?i)^" + b.String() + "$")
}

// ── Time ─────────────────────────────────────────────────────────────────────

// sbNow is "new Date()" at millisecond precision, in UTC (Prisma stores
// timestamp(3) columns as UTC wall time; pgx writes the wall time it gets).
func sbNow() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func sbISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func sbPad2(n int) string { return fmt.Sprintf("%02d", n) }

// ── JSON.stringify for metadata strings stored in the DB ────────────────────

// sbKV is one key of an ordered object; Val undefinedV drops the key.
type sbKV struct {
	Key string
	Val any
}

// sbObj is an object whose keys keep insertion order when stringified.
type sbObj []sbKV

func sbStringify(v any) string {
	var b bytes.Buffer
	sbWriteJSON(&b, v)
	return b.String()
}

func sbWriteJSON(b *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case sbObj:
		b.WriteByte('{')
		first := true
		for _, kv := range t {
			if kv.Val == undefinedV {
				continue
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			sbWriteString(b, kv.Key)
			b.WriteByte(':')
			sbWriteJSON(b, kv.Val)
		}
		b.WriteByte('}')
	case string:
		sbWriteString(b, t)
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(jsNumber(t))
		}
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case time.Time:
		sbWriteString(b, sbISO(t))
	case []string:
		b.WriteByte('[')
		for i, s := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			sbWriteString(b, s)
		}
		b.WriteByte(']')
	case []any:
		b.WriteByte('[')
		for i, x := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			if x == undefinedV {
				x = nil
			}
			sbWriteJSON(b, x)
		}
		b.WriteByte(']')
	default:
		b.Write(jsonStringify(v, nil))
	}
}

// sbWriteString quotes a string like JSON.stringify (no HTML or U+2028 escaping).
func sbWriteString(b *bytes.Buffer, s string) {
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

// ── Number.prototype.toFixed ─────────────────────────────────────────────────

// sbToFixed rounds the exact binary value half-up like JavaScript does
// (Go's %.1f rounds half-to-even).
func sbToFixed(v float64, digits int) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if math.Abs(v) >= 1e21 {
		return jsNumber(v)
	}
	neg := v < 0
	exact := new(big.Float).SetPrec(2000).SetFloat64(math.Abs(v)).Text('f', 1100)
	dot := strings.IndexByte(exact, '.')
	intPart, frac := exact, ""
	if dot >= 0 {
		intPart, frac = exact[:dot], exact[dot+1:]
	}
	for len(frac) < digits+1 {
		frac += "0"
	}
	keep := intPart + frac[:digits]
	n, _ := new(big.Int).SetString(keep, 10)
	if frac[digits] >= '5' {
		n.Add(n, big.NewInt(1))
	}
	s := n.String()
	if digits > 0 {
		for len(s) <= digits {
			s = "0" + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if neg && strings.Trim(s, "0.") != "" {
		s = "-" + s
	}
	return s
}

// ── String.prototype.localeCompare (ICU root collation) ─────────────────────

var sbCollator = collate.New(language.English)

func sbLocaleCompare(a, b string) int { return sbCollator.CompareString(a, b) }

// ── Node-style error messages for local file operations ─────────────────────

var sbErrnoText = map[syscall.Errno][2]string{
	syscall.ENOENT:    {"ENOENT", "no such file or directory"},
	syscall.EACCES:    {"EACCES", "permission denied"},
	syscall.EPERM:     {"EPERM", "operation not permitted"},
	syscall.EISDIR:    {"EISDIR", "illegal operation on a directory"},
	syscall.ENOTDIR:   {"ENOTDIR", "not a directory"},
	syscall.EEXIST:    {"EEXIST", "file already exists"},
	syscall.ENOSPC:    {"ENOSPC", "no space left on device"},
	syscall.EXDEV:     {"EXDEV", "cross-device link not permitted"},
	syscall.EROFS:     {"EROFS", "read-only file system"},
	syscall.ENOTEMPTY: {"ENOTEMPTY", "directory not empty"},
	syscall.EMFILE:    {"EMFILE", "too many open files"},
	syscall.EIO:       {"EIO", "i/o error"},
}

// sbFsErr words a local file error like Node's fs module:
// "ENOENT: no such file or directory, open '/x'".
func sbFsErr(err error, syscallName string, paths ...string) error {
	if err == nil {
		return nil
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return err
	}
	t, ok := sbErrnoText[errno]
	if !ok {
		return err
	}
	msg := fmt.Sprintf("%s: %s, %s", t[0], t[1], syscallName)
	if len(paths) > 0 {
		msg += " '" + paths[0] + "'"
	}
	if len(paths) > 1 {
		msg += " -> '" + paths[1] + "'"
	}
	return errors.New(msg)
}

// ── Local file helpers with Node semantics ──────────────────────────────────

func sbExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func sbMkdirAll(p string) error {
	if err := os.MkdirAll(p, 0o777); err != nil {
		return sbFsErr(err, "mkdir", p)
	}
	return nil
}

// sbCopyFile ports fs.copyFileSync (overwrites the destination).
func sbCopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return sbFsErr(err, "copyfile", src, dst)
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return sbFsErr(err, "copyfile", src, dst)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, st.Mode().Perm())
	if err != nil {
		return sbFsErr(err, "copyfile", src, dst)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return sbFsErr(err, "copyfile", src, dst)
	}
	if err := out.Close(); err != nil {
		return sbFsErr(err, "copyfile", src, dst)
	}
	return nil
}

func sbRename(a, b string) error {
	if err := os.Rename(a, b); err != nil {
		return sbFsErr(err, "rename", a, b)
	}
	return nil
}

func sbUnlink(p string) error {
	if err := os.Remove(p); err != nil {
		return sbFsErr(err, "unlink", p)
	}
	return nil
}

func sbStatSize(p string) (int64, error) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, sbFsErr(err, "stat", p)
	}
	return st.Size(), nil
}

func sbReadFile(p string) ([]byte, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, sbFsErr(err, "open", p)
	}
	return b, nil
}

func sbWriteFile(p string, data []byte) error {
	if err := os.WriteFile(p, data, 0o666); err != nil {
		return sbFsErr(err, "open", p)
	}
	return nil
}

// ── Values from node data ────────────────────────────────────────────────────

// sbStrOf converts a template result the way String(x) would; nil/undefined → "".
func sbStrOf(v any) string {
	if v == nil || v == undefinedV {
		return ""
	}
	return jsString(v)
}

// sbDef returns data[k] or undefinedV when the key is absent.
func sbDef(d map[string]any, k string) any {
	if v, ok := d[k]; ok {
		return v
	}
	return undefinedV
}

// sbPut stores v unless it is undefined (JSON.stringify drops such keys).
func sbPut(m map[string]any, k string, v any) {
	if v == undefinedV {
		return
	}
	m[k] = v
}

// sbOrUndef is "x || undefined".
func sbOrUndef(v any) any {
	if !truthy(v) || v == undefinedV {
		return undefinedV
	}
	return v
}

// sbUTF16Len is the JavaScript string length.
func sbUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

// sbSanitizeSeg ports name.replace(/[^a-zA-Z0-9_-]/g, '_') per UTF-16 unit.
func sbSanitizeSeg(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
			continue
		}
		if r == utf8.RuneError {
			b.WriteByte('_')
			continue
		}
		b.WriteString(strings.Repeat("_", sbUTF16Len(string(r))))
	}
	return b.String()
}
