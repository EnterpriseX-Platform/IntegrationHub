package main

// JavaScript object key order for Go maps.
//
// Go maps keep no order; JavaScript objects do (integer-like keys ascending,
// then string keys in insertion order). Rows read from a database or a file,
// and JSON coming from the Node server or an HTTP API, carry a meaningful
// order: it becomes CSV/xlsx column order, Object.keys(row), and the JSON
// written back. Producers record the order here; consumers read it back.

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"sort"
	"strconv"
	"sync"
)

// The registry stores only the key list, never the map, so it does not keep
// maps alive. A map's address can be reused after it is collected; a lookup
// therefore only trusts an entry whose keys are exactly the map's keys. Rows
// of one query share one key slice, so an entry costs a few words.
var keyReg = struct {
	sync.Mutex
	byPtr map[uintptr][]string
}{byPtr: map[uintptr][]string{}}

const keyRegMax = 2_000_000

func mapPtr(m map[string]any) uintptr { return reflect.ValueOf(m).Pointer() }

// jsOrder records the key order of m (insertion order of its keys).
func jsOrder(m map[string]any, keys []string) {
	if m == nil || len(keys) == 0 {
		return
	}
	p := mapPtr(m)
	keyReg.Lock()
	if len(keyReg.byPtr) >= keyRegMax {
		keyReg.byPtr = map[uintptr][]string{} // order falls back to sorted
	}
	keyReg.byPtr[p] = keys
	keyReg.Unlock()
}

// copyOrder gives dst the key order of src (for maps built from another).
func copyOrder(dst, src map[string]any) {
	keyReg.Lock()
	k := keyReg.byPtr[mapPtr(src)]
	keyReg.Unlock()
	if k != nil {
		jsOrder(dst, k)
	}
}

// jsKeys is Object.keys(m): integer-like keys ascending, then the other keys
// in their recorded order, then keys added later (order unknown: sorted).
func jsKeys(m map[string]any) []string {
	keyReg.Lock()
	recorded := keyReg.byPtr[mapPtr(m)]
	keyReg.Unlock()
	// Trust the entry only when every recorded key is in m (else the address
	// belonged to another map that was collected).
	for _, k := range recorded {
		if _, ok := m[k]; !ok {
			recorded = nil
			break
		}
	}

	var ints []string
	var named []string
	seen := make(map[string]bool, len(m))
	if recorded != nil {
		for _, k := range recorded {
			if seen[k] {
				continue
			}
			seen[k] = true
			if isArrayIndex(k) {
				ints = append(ints, k)
			} else {
				named = append(named, k)
			}
		}
	}
	var rest []string
	for k := range m {
		if seen[k] {
			continue
		}
		if isArrayIndex(k) {
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
	return append(append(ints, named...), rest...)
}

func isArrayIndex(k string) bool {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(k, 10, 32)
	return err == nil && n < 1<<32-1
}

// jsDecode parses JSON like JSON.parse: numbers are float64 and every object
// remembers its key order.
func jsDecode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := jsDecodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, &json.SyntaxError{Offset: dec.InputOffset()}
	}
	return v, nil
}

func jsDecodeValue(dec *json.Decoder) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch tok := t.(type) {
	case json.Delim:
		switch tok {
		case '{':
			m := map[string]any{}
			var keys []string
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k := kt.(string)
				v, err := jsDecodeValue(dec)
				if err != nil {
					return nil, err
				}
				if _, dup := m[k]; !dup {
					keys = append(keys, k)
				}
				m[k] = v
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			jsOrder(m, keys)
			return m, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := jsDecodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
	case json.Number:
		f, err := tok.Float64()
		if err != nil {
			return nil, err
		}
		return f, nil
	}
	return t, nil
}

// jsEncode writes v as JSON with JavaScript key order and no HTML escaping.
func jsEncode(v any) []byte {
	var buf bytes.Buffer
	jsEncodeTo(&buf, v)
	return buf.Bytes()
}

func jsEncodeTo(buf *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case map[string]any:
		buf.WriteByte('{')
		for i, k := range jsKeys(t) {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeScalar(buf, k)
			buf.WriteByte(':')
			jsEncodeTo(buf, t[k])
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, x := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			jsEncodeTo(buf, x)
		}
		buf.WriteByte(']')
	case []map[string]any:
		buf.WriteByte('[')
		for i, x := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			jsEncodeTo(buf, x)
		}
		buf.WriteByte(']')
	case float64, string, bool:
		writeScalar(buf, t)
	default:
		// Structs and other types use their own (or encoding/json's) encoding.
		var tmp bytes.Buffer
		enc := json.NewEncoder(&tmp)
		enc.SetEscapeHTML(false)
		if enc.Encode(t) != nil {
			buf.WriteString("null")
			return
		}
		buf.Write(bytes.TrimRight(tmp.Bytes(), "\n"))
	}
}

// jsVal wraps a value so encoding/json writes it with JavaScript key order.
type jsVal struct{ V any }

func (j jsVal) MarshalJSON() ([]byte, error) { return jsEncode(j.V), nil }

// Ordered encoding for the values carried inside engine structs.
func (n NodeResult) MarshalJSON() ([]byte, error) {
	type plain NodeResult
	p := plain(n)
	p.Output = nil
	b, err := json.Marshal(p)
	if err != nil || n.Output == nil {
		return b, err
	}
	// insert "output" after nodeType/success, as the field order declares
	out := bytes.TrimSuffix(b, []byte("}"))
	out = append(out, []byte(`,"output":`)...)
	out = append(out, jsEncode(n.Output)...)
	return append(out, '}'), nil
}

func (l LogEntry) MarshalJSON() ([]byte, error) {
	type plain LogEntry
	p := plain(l)
	data := p.Data
	p.Data = nil
	b, err := json.Marshal(p)
	if err != nil || data == nil {
		return b, err
	}
	out := bytes.TrimSuffix(b, []byte("}"))
	out = append(out, []byte(`,"data":`)...)
	out = append(out, jsEncode(data)...)
	return append(out, '}'), nil
}

func (e ExecutionResult) MarshalJSON() ([]byte, error) {
	type plain ExecutionResult
	p := plain(e)
	data := p.Data
	p.Data = nil
	b, err := json.Marshal(p)
	if err != nil || data == nil {
		return b, err
	}
	out := bytes.TrimSuffix(b, []byte("}"))
	out = append(out, []byte(`,"data":`)...)
	out = append(out, jsEncode(data)...)
	return append(out, '}'), nil
}

// om builds an object whose key order is the argument order, like a
// JavaScript object literal: om("rows", rows, "rowCount", n, "command", "SELECT").
func om(kv ...any) map[string]any {
	m := make(map[string]any, len(kv)/2)
	keys := make([]string, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		k := kv[i].(string)
		if isUndefined(kv[i+1]) {
			continue // like JSON.stringify, an undefined property is absent
		}
		if _, dup := m[k]; !dup {
			keys = append(keys, k)
		}
		m[k] = kv[i+1]
	}
	jsOrder(m, keys)
	return m
}

func isUndefined(v any) bool {
	switch v.(type) {
	case *undefinedT, *fioUndefT:
		return true
	}
	return false
}

// jsAssign is Object.assign(dst, src) / {...dst, ...src}: src keys in src
// order, new keys after dst's; undefined values delete the key.
func jsAssign(dst, src map[string]any) {
	order := jsKeys(dst)
	for _, k := range jsKeys(src) {
		v := src[k]
		if isUndefined(v) {
			delete(dst, k)
			continue
		}
		if _, exists := dst[k]; !exists {
			order = append(order, k)
		}
		dst[k] = v
	}
	jsOrder(dst, order)
}

// jsSet sets m[k] = v and records k as the last key when it is new.
func jsSet(m map[string]any, k string, v any) {
	if _, exists := m[k]; !exists {
		jsOrder(m, append(jsKeys(m), k))
	}
	m[k] = v
}
