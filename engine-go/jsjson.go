package main

import (
	"bytes"
	"encoding/json"
	"math"
	"time"
)

// jsonStringify encodes v like JavaScript's JSON.stringify: object keys in
// the order they had in the flow JSON (raw), no HTML escaping.
func jsonStringify(v any, raw json.RawMessage) []byte {
	var buf bytes.Buffer
	writeJS(&buf, v, raw)
	return buf.Bytes()
}

func writeJS(buf *bytes.Buffer, v any, raw json.RawMessage) {
	switch t := v.(type) {
	case map[string]any:
		var sub map[string]json.RawMessage
		_ = json.Unmarshal(raw, &sub)
		keys := []string{}
		seen := map[string]bool{}
		for _, k := range objectKeys(raw) {
			if _, ok := t[k]; ok && !seen[k] {
				keys, seen[k] = append(keys, k), true
			}
		}
		// keys not in the flow JSON: the map's own (recorded) order
		for _, k := range jsKeys(t) {
			if !seen[k] {
				keys = append(keys, k)
			}
		}
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeScalar(buf, k)
			buf.WriteByte(':')
			writeJS(buf, t[k], sub[k])
		}
		buf.WriteByte('}')
	case []any:
		var sub []json.RawMessage
		_ = json.Unmarshal(raw, &sub)
		buf.WriteByte('[')
		for i, x := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			var r json.RawMessage
			if i < len(sub) {
				r = sub[i]
			}
			writeJS(buf, x, r)
		}
		buf.WriteByte(']')
	default:
		writeScalar(buf, v)
	}
}

func writeScalar(buf *bytes.Buffer, v any) {
	if t, ok := v.(time.Time); ok {
		buf.WriteString(`"` + jsISO(t) + `"`)
		return
	}
	if f, ok := v.(float64); ok {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			buf.WriteString("null") // JSON.stringify(NaN) === "null"
			return
		}
		buf.WriteString(jsNumber(f))
		return
	}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	buf.Truncate(buf.Len() - 1) // Encode adds a newline
}
