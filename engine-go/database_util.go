package main

// Helpers for the database executor (database.go): template resolution as
// DatabaseExecutor overrides it, SQL literal escaping, and JavaScript number /
// date / string semantics the TS code relies on.

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	dbDollarTpl = regexp.MustCompile(`\$\{([^}]+)\}`)
	dbBraceTpl  = regexp.MustCompile(`\{\{([^}]+)\}\}`)
	dbIntRe     = regexp.MustCompile(`^-?\d+$`)
	dbDecRe     = regexp.MustCompile(`^-?\d+\.\d+$`)
)

// dbResolve ports DatabaseExecutor.resolveTemplate (it overrides the base
// class): non-strings come back unchanged, ${x} becomes an escaped SQL
// literal (NULL when undefined), {{x}} becomes String(value) (left as is when
// undefined). The result of a string template is always a string.
func dbResolve(ctx *Ctx, t any) any {
	s, ok := t.(string)
	if !ok {
		return t
	}
	return dbResolveStr(ctx, s)
}

func dbResolveStr(ctx *Ctx, s string) string {
	if !strings.Contains(s, "{{") && !strings.Contains(s, "${") {
		return s
	}
	out := dbDollarTpl.ReplaceAllStringFunc(s, func(m string) string {
		p := strings.TrimSpace(m[2 : len(m)-1])
		if v, ok := ctx.standardValue(p); ok {
			return dbEscape(v)
		}
		return "NULL"
	})
	return dbBraceTpl.ReplaceAllStringFunc(out, func(m string) string {
		p := strings.TrimSpace(m[2 : len(m)-2])
		if v, ok := ctx.standardValue(p); ok {
			return jsString(v)
		}
		return m
	})
}

// dbEscape ports escapeSqlValue.
func dbEscape(v any) string {
	switch t := v.(type) {
	case nil:
		return "NULL"
	case float64, int, int64, bool:
		return jsString(t)
	case time.Time:
		return "'" + dbISO(t) + "'"
	case string:
		if dbIntRe.MatchString(t) || dbDecRe.MatchString(t) {
			return t
		}
		return "'" + strings.ReplaceAll(t, "'", "''") + "'"
	}
	return dbEscape(dbJSString(v))
}

// dbJSString is String(v), also for values jsString does not know.
func dbJSString(v any) string {
	switch t := v.(type) {
	case time.Time:
		// String(date) is the local-time long form; only reached for Date
		// objects, which Go never holds after JSON transport.
		return t.Local().Format("Mon Jan 02 2006 15:04:05 GMT-0700")
	case int32:
		return strconv.FormatInt(int64(t), 10)
	}
	return jsString(v)
}

// dbISO is Date.prototype.toISOString.
func dbISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// dbJSONString is JSON.stringify for values from JSON / the drivers.
func dbJSONString(v any) string {
	return string(jsonStringify(dbJSONable(v), nil))
}

func dbJSONable(v any) any {
	switch t := v.(type) {
	case time.Time:
		return dbISO(t)
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case int32:
		return float64(t)
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = dbJSONable(x)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = dbJSONable(x)
		}
		return out
	}
	return v
}

// dbTypeof is JavaScript typeof for a lookup result (found=false: undefined).
func dbTypeof(v any, found bool) string {
	if !found {
		return "undefined"
	}
	switch v.(type) {
	case nil:
		return "object"
	case string:
		return "string"
	case float64, int, int64, int32:
		return "number"
	case bool:
		return "boolean"
	}
	return "object"
}

// dbLocale is Number.prototype.toLocaleString() for en-US.
func dbLocale(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "∞"
	}
	if math.IsInf(f, -1) {
		return "-∞"
	}
	s := strconv.FormatFloat(math.Abs(f), 'f', 3, 64)
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], strings.TrimRight(s[i+1:], "0")
	}
	var b strings.Builder
	for i, c := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String()
	if frac != "" {
		out += "." + frac
	}
	if f < 0 && out != "0" {
		out = "-" + out
	}
	return out
}

// dbFixed1 is Number.prototype.toFixed(1) (ties go up, like JS, where Go
// would round half to even).
func dbFixed1(f float64) string {
	x := new(big.Float).SetPrec(256).SetFloat64(math.Abs(f))
	x.Mul(x, big.NewFloat(20))
	if xi, acc := x.Int(nil); acc == big.Exact && xi.Bit(0) == 1 {
		return strconv.FormatFloat(f+0.05*math.Copysign(1, f)/2, 'f', 1, 64)
	}
	return strconv.FormatFloat(f, 'f', 1, 64)
}

// dbRound is Math.round.
func dbRound(f float64) float64 { return math.Floor(f + 0.5) }

var dbFloatPrefix = regexp.MustCompile(`^[+-]?(Infinity|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)`)

// dbParseFloat is JavaScript parseFloat (longest numeric prefix).
func dbParseFloat(s string) float64 {
	s = strings.TrimLeft(s, " \t\n\r\v\f\u00a0\ufeff")
	m := dbFloatPrefix.FindString(s)
	if m == "" {
		return math.NaN()
	}
	if strings.HasSuffix(m, "Infinity") {
		if strings.HasPrefix(m, "-") {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	f, err := strconv.ParseFloat(m, 64)
	if err != nil {
		// a mantissa like "1." or an exponent overflow
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f
		}
		f, _ = strconv.ParseFloat(strings.TrimSuffix(m, "."), 64)
	}
	return f
}

var (
	dbISODate     = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$`)
	dbISODateTime = regexp.MustCompile(`^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$`)
	dbSlashDate   = regexp.MustCompile(`^(\d{4})/(\d{1,2})/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$`)
	dbUSDate      = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$`)
)

// dbParseDate is `new Date(string)` for the formats V8 accepts that occur in
// imported data: ISO date (UTC), ISO date-time (local unless Z/offset),
// YYYY/MM/DD and MM/DD/YYYY (local). ok=false is an Invalid Date.
func dbParseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	atoi := func(x string) int { n, _ := strconv.Atoi(x); return n }
	valid := func(y, mo, d, h, mi, se int) bool {
		return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 24 && mi <= 59 && se <= 59
	}
	if m := dbISODate.FindStringSubmatch(s); m != nil {
		y, mo, d := atoi(m[1]), 1, 1
		if m[2] != "" {
			mo = atoi(m[2])
		}
		if m[3] != "" {
			d = atoi(m[3])
		}
		if !valid(y, mo, d, 0, 0, 0) {
			return time.Time{}, false
		}
		t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		if t.Day() != d {
			return time.Time{}, false
		}
		return t, true
	}
	if m := dbISODateTime.FindStringSubmatch(s); m != nil {
		y, mo, d, h, mi, se := atoi(m[1]), atoi(m[2]), atoi(m[3]), atoi(m[4]), atoi(m[5]), atoi(m[6])
		if !valid(y, mo, d, h, mi, se) {
			return time.Time{}, false
		}
		ns := 0
		if m[7] != "" {
			frac := (m[7] + "000")[:3]
			ns = atoi(frac) * 1e6
		}
		loc := time.Local
		if z := m[8]; z == "Z" {
			loc = time.UTC
		} else if z != "" {
			z = strings.ReplaceAll(z, ":", "")
			off := atoi(z[1:3])*3600 + atoi(z[3:5])*60
			if z[0] == '-' {
				off = -off
			}
			loc = time.FixedZone("", off)
		}
		return time.Date(y, time.Month(mo), d, h, mi, se, ns, loc), true
	}
	for i, re := range []*regexp.Regexp{dbSlashDate, dbUSDate} {
		if m := re.FindStringSubmatch(s); m != nil {
			y, mo, d := atoi(m[1]), atoi(m[2]), atoi(m[3])
			if i == 1 {
				mo, d, y = atoi(m[1]), atoi(m[2]), atoi(m[3])
			}
			h, mi, se := atoi(m[4]), atoi(m[5]), atoi(m[6])
			if !valid(y, mo, d, h, mi, se) {
				return time.Time{}, false
			}
			return time.Date(y, time.Month(mo), d, h, mi, se, 0, time.Local), true
		}
	}
	return time.Time{}, false
}

// dbUUID is crypto.randomUUID (version 4).
func dbUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// dbSafeInt is toJsonSafe for a BigInt: a number when it fits exactly in a
// double, else its decimal string.
func dbSafeInt(n int64) any {
	const max = 1<<53 - 1
	if n <= max && n >= -max {
		return float64(n)
	}
	return strconv.FormatInt(n, 10)
}

// dbDecimalString formats coefficient × 10^exp the way decimal.js
// Decimal.toString()/toJSON() does (Prisma's Decimal): trailing zeros
// dropped, exponential notation when the exponent is >= 21 or <= -7.
func dbDecimalString(coef *big.Int, exp int) string {
	if coef.Sign() == 0 {
		return "0"
	}
	neg := coef.Sign() < 0
	digits := new(big.Int).Abs(coef).String()
	for len(digits) > 1 && digits[len(digits)-1] == '0' {
		digits = digits[:len(digits)-1]
		exp++
	}
	e := len(digits) - 1 + exp // exponent of the leading digit
	var s string
	if e >= 21 || e <= -7 {
		s = digits[:1]
		if len(digits) > 1 {
			s += "." + digits[1:]
		}
		if e >= 0 {
			s += "e+" + strconv.Itoa(e)
		} else {
			s += "e" + strconv.Itoa(e)
		}
	} else if e < 0 {
		s = "0." + strings.Repeat("0", -e-1) + digits
	} else if len(digits) <= e+1 {
		s = digits + strings.Repeat("0", e+1-len(digits))
	} else {
		s = digits[:e+1] + "." + digits[e+1:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// dbJSReplace is String.prototype.replace(regex /g, replacementString):
// the replacement's $$, $&, $` and $' patterns are expanded like JS does.
func dbJSReplace(re *regexp.Regexp, s, repl string) string {
	if !strings.Contains(repl, "$") {
		return re.ReplaceAllLiteralString(s, repl)
	}
	var b strings.Builder
	last := 0
	for _, loc := range re.FindAllStringIndex(s, -1) {
		b.WriteString(s[last:loc[0]])
		for i := 0; i < len(repl); i++ {
			if repl[i] != '$' || i == len(repl)-1 {
				b.WriteByte(repl[i])
				continue
			}
			switch repl[i+1] {
			case '$':
				b.WriteByte('$')
				i++
			case '&':
				b.WriteString(s[loc[0]:loc[1]])
				i++
			case '`':
				b.WriteString(s[:loc[0]])
				i++
			case '\'':
				b.WriteString(s[loc[1]:])
				i++
			default:
				b.WriteByte('$')
			}
		}
		last = loc[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// dbSlice is String.prototype.slice(0, n) (UTF-16 code units).
func dbSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// dbKeys returns the keys of a row object: in the original JSON order when
// known, otherwise sorted (Go maps keep no order).
func dbKeys(v any) []string {
	m, ok := v.(map[string]any)
	if !ok {
		if arr, ok := v.([]any); ok {
			out := make([]string, len(arr))
			for i := range arr {
				out[i] = strconv.Itoa(i)
			}
			return out
		}
		if s, ok := v.(string); ok {
			out := []string{}
			for i := range []rune(s) {
				out = append(out, strconv.Itoa(i))
			}
			return out
		}
		return []string{}
	}
	return jsKeys(m)
}

func dbSortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// dbIndex reads row[key] JavaScript style; found=false is undefined.
func dbIndex(row any, key string) (any, bool) {
	v := prop(row, key)
	if v == undefinedV {
		return nil, false
	}
	return v, true
}

// dbDeepCopyJSON round-trips through JSON (for log data snapshots).
func dbDeepCopyJSON(v any) any {
	b, err := json.Marshal(dbJSONable(v))
	if err != nil {
		return v
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}
