package main

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Ctx is one execution context. Branches and for-each workers get a copy of
// the variables (like `new Map(context.variables)` in the TS engine) but share
// node results and logs.
type Ctx struct {
	ID     string
	Parent string // set until the Node side has seen this context
	Input  any
	Vars   map[string]any
	dirty  map[string]bool // variables changed here that Node has not seen yet

	run *Run
}

// Results is the shared node-result store of a run.
type Results struct {
	mu     sync.Mutex
	byID   map[string]NodeResult
	order  []string
	unsent map[string]bool // produced natively, not yet pushed to Node
}

func newResults() *Results {
	return &Results{byID: map[string]NodeResult{}, unsent: map[string]bool{}}
}

func (r *Results) set(res NodeResult, native bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byID[res.NodeID]; !ok {
		r.order = append(r.order, res.NodeID)
	}
	r.byID[res.NodeID] = res
	if native {
		r.unsent[res.NodeID] = true
	}
}

func (r *Results) get(id string) (NodeResult, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.byID[id]
	return v, ok
}

func (r *Results) list() []NodeResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]NodeResult, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id])
	}
	return out
}

// takeUnsent returns native results Node has not received yet.
func (r *Results) takeUnsent() map[string]NodeResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]NodeResult{}
	for id := range r.unsent {
		out[id] = r.byID[id]
	}
	r.unsent = map[string]bool{}
	return out
}

func (c *Ctx) set(k string, v any) {
	c.Vars[k] = v
	c.dirty[k] = true
}

func (c *Ctx) get(k string) (any, bool) {
	v, ok := c.Vars[k]
	return v, ok
}

// fork copies the context for a branch or a for-each worker.
func (c *Ctx) fork() *Ctx {
	vars := make(map[string]any, len(c.Vars))
	for k, v := range c.Vars {
		vars[k] = v
	}
	child := &Ctx{ID: c.run.newCtxID(), Parent: c.ID, Input: c.Input, Vars: vars, dirty: map[string]bool{}, run: c.run}
	// Pending changes of the parent must reach Node with the child too.
	for k := range c.dirty {
		child.dirty[k] = true
	}
	return child
}

// ── Template resolution: port of NodeExecutor.resolveTemplate ────────────────

var mixedTemplate = regexp.MustCompile(`\{\{(.*?)\}\}`)

func (c *Ctx) resolveTemplate(t string) any {
	trimmed := strings.TrimSpace(t)
	if strings.HasPrefix(trimmed, "{{") && strings.HasSuffix(trimmed, "}}") {
		depth, end := 0, -1
		for i := 0; i < len(trimmed)-1; i++ {
			switch trimmed[i : i+2] {
			case "{{":
				depth++
				i++
			case "}}":
				depth--
				if depth == 0 {
					end = i
				}
				i++
			}
			if end >= 0 {
				break
			}
		}
		if end > 2 {
			path := strings.TrimSpace(trimmed[2:end])
			v, ok := c.standardValue(path)
			remaining := trimmed[end+2:]
			if remaining != "" {
				if ok {
					return jsString(v) + remaining
				}
				return remaining
			}
			if !ok {
				return nil
			}
			return v
		}
	}
	return mixedTemplate.ReplaceAllStringFunc(t, func(m string) string {
		p := strings.TrimSpace(m[2 : len(m)-2])
		if v, ok := c.standardValue(p); ok {
			return jsString(v)
		}
		return m
	})
}

// standardValue ports NodeExecutor.getStandardValue. ok=false means undefined.
func (c *Ctx) standardValue(path string) (any, bool) {
	parts := strings.Split(path, ".")
	in, _ := c.Input.(map[string]any)
	if len(parts) >= 2 {
		source, key := parts[0], strings.Join(parts[1:], ".")
		switch strings.ToLower(source) {
		case "path":
			return byPath(field(in, "params"), key)
		case "query":
			return byPath(field(in, "query"), key)
		case "body":
			return byPath(field(in, "body"), key)
		case "header", "headers":
			return byPath(field(in, "headers"), strings.ToLower(key))
		case "input":
			return byPath(c.Input, key)
		case "var", "vars", "variable", "variables":
			if v, ok := c.Vars[key]; ok && v != nil {
				return v, true
			}
			return byPath(c.Vars, key)
		default:
			return c.valueByPath(path)
		}
	}
	if v, ok := c.Vars[path]; ok {
		return v, true // JS: variables.get(path) !== undefined (null counts)
	}
	return c.valueByPath(path)
}

// valueByPath ports getValueByPath(context, path) for an execution context.
func (c *Ctx) valueByPath(path string) (any, bool) {
	parts := strings.Split(path, ".")
	var cur any
	switch parts[0] {
	case "input":
		cur, parts = c.Input, parts[1:]
	case "vars", "variables":
		cur, parts = c.Vars, parts[1:]
	default:
		v, ok := c.Vars[parts[0]]
		if !ok {
			return nil, false
		}
		cur, parts = v, parts[1:]
	}
	return walk(cur, parts)
}

func field(m map[string]any, k string) any {
	if m == nil {
		return nil
	}
	return m[k]
}

// byPath ports getValueByPath(plainObject, path).
func byPath(obj any, path string) (any, bool) {
	if path == "" {
		return obj, obj != nil
	}
	return walk(obj, strings.Split(path, "."))
}

var arrayPart = regexp.MustCompile(`^(.+)\[(\d+)\]$`)

func walk(cur any, parts []string) (any, bool) {
	for _, p := range parts {
		if cur == nil {
			return nil, false
		}
		if m := arrayPart.FindStringSubmatch(p); m != nil {
			arr, ok := prop(cur, m[1]).([]any)
			if !ok {
				return nil, false
			}
			i, _ := strconv.Atoi(m[2])
			if i >= len(arr) {
				return nil, false
			}
			cur = arr[i]
			continue
		}
		v := prop(cur, p)
		if v == undefinedV {
			return nil, false
		}
		cur = v
	}
	if cur == undefinedV {
		return nil, false
	}
	return cur, true
}

type undefinedT struct{}

var undefinedV = &undefinedT{}

// prop reads one JS-style property: object keys, array index / length,
// string length.
func prop(v any, k string) any {
	switch t := v.(type) {
	case map[string]any:
		if x, ok := t[k]; ok {
			return x
		}
		return undefinedV
	case []any:
		if k == "length" {
			return float64(len(t))
		}
		if i, err := strconv.Atoi(k); err == nil && i >= 0 && i < len(t) {
			return t[i]
		}
		return undefinedV
	case string:
		if k == "length" {
			return float64(len([]rune(t)))
		}
	}
	return undefinedV
}

// jsString formats a value the way JavaScript's String(v) does.
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumber(t)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case []any:
		s := make([]string, len(t))
		for i, x := range t {
			if x == nil {
				continue
			}
			s[i] = jsString(x)
		}
		return strings.Join(s, ",")
	case map[string]any:
		return "[object Object]"
	}
	return ""
}

func jsNumber(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case int64:
		return t != 0
	case int:
		return t != 0
	case string:
		return t != ""
	}
	return v != undefinedV
}

func str(m map[string]any, k string) string {
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}

func num(m map[string]any, k string) (float64, bool) {
	switch t := m[k].(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
