package main

// The two file executors override NodeExecutor.resolveTemplate with their own
// simpler versions; both are ported here, plus FileWriteExecutor's
// getDataFromPath. They walk the TS ExecutionContext object
// ({flow, input, variables: Map, nodeResults: Map, logs, apiSpec}).

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

var fioTplRe = regexp.MustCompile(`\{\{([^}]+)\}\}`)

// fioCtxRoot returns property k of the ExecutionContext object.
func fioCtxRoot(r *Run, ctx *Ctx, k string) any {
	switch k {
	case "flow":
		if r == nil || r.flow == nil {
			return fioUndef
		}
		b, _ := json.Marshal(r.flow)
		var m any
		_ = json.Unmarshal(b, &m)
		return m
	case "input":
		if ctx.Input == nil {
			return nil
		}
		return ctx.Input
	case "variables":
		return &fioJSMap{size: len(ctx.Vars)}
	case "nodeResults":
		if r == nil {
			return &fioJSMap{}
		}
		return &fioJSMap{size: len(r.results.list())}
	case "logs":
		if r == nil {
			return []any{}
		}
		r.logsMu.Lock()
		n := len(r.logs)
		r.logsMu.Unlock()
		return make([]any, n)
	}
	return fioUndef
}

// fioWalkCtx is `let v = context; for (k of keys) v = v?.[k]`.
func fioWalkCtx(r *Run, ctx *Ctx, keys []string) any {
	if len(keys) == 0 {
		return fioUndef
	}
	v := fioCtxRoot(r, ctx, keys[0])
	for _, k := range keys[1:] {
		if v == nil || v == fioUndef {
			return fioUndef
		}
		v = fioProp(v, k)
	}
	return v
}

// fioReadTemplate is FileReadExecutor.resolveTemplate.
func fioReadTemplate(r *Run, ctx *Ctx, t string) string {
	if !strings.Contains(t, "{{") {
		return t
	}
	return fioTplRe.ReplaceAllStringFunc(t, func(m string) string {
		p := fioTrim(m[2 : len(m)-2])
		v := fioWalkCtx(r, ctx, strings.Split(p, "."))
		if v == fioUndef {
			return m
		}
		return fioStr(v)
	})
}

var fioArithRe = regexp.MustCompile(`^([A-Za-z0-9_]+)([+-]\d+)$`)

// fioWriteTemplate is FileWriteExecutor.resolveTemplate.
func fioWriteTemplate(r *Run, ctx *Ctx, t string) string {
	if !strings.Contains(t, "{{") {
		return t
	}
	return fioTplRe.ReplaceAllStringFunc(t, func(m string) string {
		p := fioTrim(m[2 : len(m)-2])
		if am := fioArithRe.FindStringSubmatch(p); am != nil {
			if base, ok := ctx.Vars[am[1]]; ok {
				n := fioToNumber(base)
				if n == n { // !isNaN
					off, _ := strconv.Atoi(strings.TrimPrefix(am[2], "+"))
					return fioNum(n + float64(off))
				}
			}
		}
		keys := strings.Split(p, ".")
		if v, ok := ctx.Vars[p]; ok {
			return fioStr(v)
		}
		if len(keys) >= 2 {
			if v, ok := ctx.Vars[keys[0]]; ok {
				for _, k := range keys[1:] {
					if v == nil || v == fioUndef {
						v = fioUndef
						break
					}
					v = fioProp(v, k)
				}
				if v != fioUndef {
					return fioStr(v)
				}
			}
		}
		v := fioWalkCtx(r, ctx, keys)
		if v == fioUndef {
			return m
		}
		return fioStr(v)
	})
}

// fioDataFromPath is FileWriteExecutor.getDataFromPath.
func fioDataFromPath(r *Run, ctx *Ctx, path string) any {
	keys := strings.Split(path, ".")
	var v any = fioCtxSentinel
	for i := 0; i < len(keys); i++ {
		k := keys[i]
		if v == nil || v == fioUndef {
			return fioUndef
		}
		if (k == "vars" || k == "variables") && v == fioCtxSentinel && i+1 < len(keys) && keys[i+1] != "" {
			if x, ok := ctx.Vars[keys[i+1]]; ok {
				v = x
			} else {
				v = fioUndef
			}
			i++
			continue
		}
		if v == fioCtxSentinel {
			v = fioCtxRoot(r, ctx, k)
			if _, isMap := v.(*fioJSMap); isMap {
				v = map[string]any{} // a Map: no own enumerable properties
			}
			continue
		}
		v = fioProp(v, k)
	}
	if v == fioCtxSentinel {
		return map[string]any{}
	}
	return v
}

type fioCtxT struct{}

var fioCtxSentinel any = &fioCtxT{}
