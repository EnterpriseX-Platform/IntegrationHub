package main

import (
	"bytes"
	"encoding/json"
	"sort"
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
		var rest []string
		for k := range t {
			if !seen[k] {
				rest = append(rest, k)
			}
		}
		sort.Strings(rest)
		keys = append(keys, rest...)
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
	if f, ok := v.(float64); ok {
		buf.WriteString(jsNumber(f))
		return
	}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	buf.Truncate(buf.Len() - 1) // Encode adds a newline
}
