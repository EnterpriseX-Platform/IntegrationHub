package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dop251/goja"
)

type nativeFn func(r *Run, node *Node, ctx *Ctx) (any, error)

// Node types Go runs itself. Everything else goes to the Node server.
var nativeExecutors = map[string]nativeFn{
	"api-input":       execAPIInput,
	"delay":           execDelay,
	"transform":       execTransform,
	"condition":       execCondition,
	"for-each":        execForEach,
	"aggregate-split": execAggregateSplit,
	"aggregate-join":  execAggregateJoin,
}

// ── api-input ────────────────────────────────────────────────────────────────

func execAPIInput(r *Run, node *Node, ctx *Ctx) (any, error) {
	in := asMap(ctx.Input)
	out := om(
		"method", in["method"],
		"path", in["path"],
		"headers", in["headers"],
		"query", orEmpty(in["query"]),
		"body", in["body"],
		"params", orEmpty(in["params"]),
	)
	r.log("debug", node.ID, "API Input Request", out)
	return out, nil
}

func orEmpty(v any) any {
	if v == nil {
		return map[string]any{}
	}
	return v
}

// ── delay ────────────────────────────────────────────────────────────────────

func execDelay(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	unit := str(d, "unit")
	var ms float64
	if v, ok := num(d, "duration"); ok && d["duration"] != nil {
		ms = v
		switch unit {
		case "seconds":
			ms *= 1000
		case "minutes":
			ms *= 60 * 1000
		case "hours":
			ms *= 60 * 60 * 1000
		}
	} else if v, ok := num(d, "seconds"); ok && d["seconds"] != nil {
		ms = v * 1000
		unit = "seconds"
	} else {
		ms = 1000
	}
	if unit == "" {
		unit = "ms"
	}
	ms = math.Min(ms, 5*60*1000)
	time.Sleep(time.Duration(ms) * time.Millisecond)
	return om("delayed", ms, "unit", unit, "resumedAt", isoNow()), nil
}

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// ── transform ────────────────────────────────────────────────────────────────

func prevOutput(r *Run, node *Node) any {
	for _, e := range r.flow.Edges {
		if e.Target == node.ID {
			if res, ok := r.results.get(e.Source); ok && res.Output != nil {
				return res.Output
			}
			return map[string]any{}
		}
	}
	return map[string]any{}
}

func execTransform(r *Run, node *Node, ctx *Ctx) (any, error) {
	input := prevOutput(r, node)
	if mapping, ok := node.Data["mapping"].(map[string]any); ok && mapping != nil {
		return applyMapping(mapping, ctx), nil
	}
	code := str(node.Data, "code")
	if code == "" {
		return input, nil
	}
	vm := newVM(r, ctx)
	fn, err := vm.RunString("(function(input, vars, context) {\n\"use strict\";\n" + code + "\n})")
	if err != nil {
		return nil, fmt.Errorf("Transform code execution failed: %s", jsErr(err))
	}
	call, _ := goja.AssertFunction(fn)
	ret, err := call(goja.Undefined(), jsIn(vm, input), jsIn(vm, varsObject(ctx)), contextObject(vm, r, ctx))
	if err != nil {
		if needsNode(err) {
			return nil, errUseFallback
		}
		return nil, fmt.Errorf("Transform code execution failed: %s", jsErr(err))
	}
	return jsOut(ret), nil
}

func applyMapping(mapping map[string]any, ctx *Ctx) map[string]any {
	out := map[string]any{}
	defer copyOrder(out, mapping)
	for k, v := range mapping {
		switch t := v.(type) {
		case string:
			out[k] = ctx.resolveTemplate(t)
		case map[string]any:
			out[k] = applyMapping(t, ctx)
		default:
			out[k] = v
		}
	}
	return out
}

// ── condition ────────────────────────────────────────────────────────────────

var (
	execExistsArgs = regexp.MustCompile(`executions\.exists\(([^)]+)\)`)
	execExistsAll  = regexp.MustCompile(`executions\.exists\([^)]+\)`)
	existsKeyValue = regexp.MustCompile(`(\w+)\s*=\s*(.+)`)
	existsTplEnds  = regexp.MustCompile(`^\{\{|\}\}$`)
	wholeTemplate  = regexp.MustCompile(`^\{\{(.+)\}\}$`)
	identPath      = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_-]*(?:(?:\.[a-zA-Z_][a-zA-Z0-9_-]*)|(?:\[\d+\]))*`)
	inlineTpl      = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)
	operators      = regexp.MustCompile(`[><=!&|]`)
)

func execCondition(r *Run, node *Node, ctx *Ctx) (any, error) {
	cond := str(node.Data, "condition")
	if cond == "" {
		return nil, errors.New("Condition node missing condition expression")
	}
	input := any(map[string]any{})
	var prevVar any
	for _, e := range r.flow.Edges {
		if e.Target == node.ID {
			if res, ok := r.results.get(e.Source); ok && res.Output != nil {
				input = res.Output
				pv := e.Source
				if pn := r.flow.node(e.Source); pn != nil && str(pn.Data, "varName") != "" {
					pv = str(pn.Data, "varName")
				}
				prevVar = pv
			}
			break
		}
	}
	ctx.set("_conditionInput", input)

	// executions.exists(key={{value}}) → true/false from past runs
	processed := cond
	existsArgs := execExistsArgs.FindStringSubmatch(cond)
	if existsArgs != nil {
		exists := processExecutionExists(r, ctx, existsArgs[1])
		processed = execExistsAll.ReplaceAllString(cond, strconv.FormatBool(exists))
	}
	// legacy checkDuplicate flag
	var duplicateCheck any = undefinedV
	if truthy(node.Data["checkDuplicate"]) && existsArgs == nil {
		params := asMap(ctx.Vars["_triggerParams"])
		key := strOr(node.Data, "duplicateKey", "year")
		if val, ok := params[key]; ok {
			isDup := checkDuplicateExecution(r.flow.OperationID, key, jsString(val))
			duplicateCheck = om("checked", true, "passed", !isDup, "isDuplicate", isDup, "key", key, "value", val)
			ctx.set("executionsExists", isDup)
			ctx.set("duplicateKey", key)
			ctx.set("duplicateValue", val)
		}
	}

	result, err := evaluateCondition(r, ctx, processed)
	if err != nil {
		return nil, err
	}
	var next any
	for _, e := range r.flow.Edges {
		if e.Source != node.ID {
			continue
		}
		if result && (e.Label == "true" || e.Label == "yes") || !result && (e.Label == "false" || e.Label == "no" || e.Label == "") {
			next = e.Target
			break
		}
	}
	summary := map[string]any{}
	in := asMap(input)
	if rows, ok := in["rows"].([]any); ok {
		jsSet(summary, "rowCount", float64(len(rows)))
	} else if rc, ok := in["rowCount"]; ok && rc != nil {
		jsSet(summary, "rowCount", rc)
	} else if arr, ok := input.([]any); ok {
		jsSet(summary, "rowCount", float64(len(arr)))
	}
	if next == nil {
		next = undefinedV
	}
	if prevVar == nil {
		prevVar = undefinedV
	}
	return om(
		"condition", cond, "processedCondition", processed, "result", result,
		"nextNodeId", next, "prevNodeVarName", prevVar,
		"inputSummary", summary, "duplicateCheck", duplicateCheck,
	), nil
}

func evaluateCondition(r *Run, ctx *Ctx, cond string) (bool, error) {
	if m := wholeTemplate.FindStringSubmatch(cond); m != nil {
		expr := strings.TrimSpace(m[1])
		if operators.MatchString(expr) {
			resolved := identPath.ReplaceAllStringFunc(expr, func(id string) string {
				switch id {
				case "true", "false", "null", "undefined":
					return id
				}
				v, ok := ctx.valueByPath(id)
				if !ok {
					return "undefined"
				}
				switch t := v.(type) {
				case nil:
					return "null"
				case string:
					return `"` + strings.ReplaceAll(t, `"`, `\"`) + `"`
				case float64, bool, int, int64:
					return jsString(t)
				case []any:
					return strconv.FormatBool(len(t) > 0)
				case map[string]any, time.Time:
					return "true"
				}
				return jsString(v)
			})
			v, err := goja.New().RunString(resolved)
			if err != nil {
				return false, nil // TS: evaluation errors in this form count as false
			}
			return v.ToBoolean(), nil
		}
		v, ok := ctx.valueByPath(expr)
		return ok && truthy(v), nil
	}
	expr := cond
	if strings.Contains(cond, "{{") {
		expr = inlineTpl.ReplaceAllStringFunc(cond, func(m string) string {
			p := inlineTpl.FindStringSubmatch(m)[1]
			v := ctx.resolveTemplate("{{" + p + "}}")
			if v == nil {
				if _, ok := ctx.standardValue(p); !ok {
					return "undefined"
				}
			}
			return string(jsEncode(v))
		})
	}
	v, err := goja.New().RunString(expr)
	if err != nil {
		return false, fmt.Errorf(`Condition could not be evaluated: "%s" (%s)`, cond, jsErr(err))
	}
	return v.ToBoolean(), nil
}

// ── for-each ─────────────────────────────────────────────────────────────────

var defaultMaxItems = func() float64 {
	n, _ := strconv.Atoi(os.Getenv("FLOW_FOREACH_MAX_ITEMS"))
	return float64(n)
}()

func execForEach(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	source := strOr(d, "source", "triggerFiles")
	itemVar := strOr(d, "itemVar", "currentFile")
	indexVar := strOr(d, "indexVar", "loopIndex")

	items, found := resolveSourceArray(source, ctx)
	if !found || items == nil {
		r.log("warn", node.ID, fmt.Sprintf(`For-each source "%s" is empty or unset — no items to process.`, source), nil)
		return om("items", []any{}, "itemVar", itemVar, "indexVar", indexVar, "totalItems", 0.0,
			"matchedItems", 0.0, "deferredItems", 0.0, "maxItems", 0.0, "workers", 1.0), nil
	}
	arr, ok := items.([]any)
	if !ok {
		return nil, fmt.Errorf(`For-each source "%s" is not an array (got %s)`, source, jsTypeof(items))
	}
	filtered := arr
	if pat := str(d, "filterPattern"); pat != "" {
		re, err := regexp.Compile("(?i)^" + strings.ReplaceAll(strings.ReplaceAll(pat, ".", `\.`), "*", ".*") + "$")
		if err == nil {
			filtered = nil
			for _, it := range arr {
				if re.MatchString(itemName(it)) {
					filtered = append(filtered, it)
				}
			}
			if filtered == nil {
				filtered = []any{}
			}
		}
	}
	w, _ := num(d, "workers")
	workers := math.Max(1, math.Min(orOne(w), 20))
	matched := float64(len(filtered))
	maxItems := defaultMaxItems
	if v, ok := num(d, "maxItems"); ok && d["maxItems"] != nil {
		maxItems = v
	}
	deferred := 0.0
	if maxItems > 0 && matched > maxItems {
		deferred = matched - maxItems
		filtered = filtered[:int(maxItems)]
		r.log("warn", node.ID, fmt.Sprintf("For-each source has %s items, above maxItems=%s. Processing the first %s; %s left unprocessed. Any basket session behind this loop is left open so the remainder is not marked done.",
			jsNumber(matched), jsNumber(maxItems), jsNumber(maxItems), jsNumber(deferred)), nil)
		ctx.set("__foreach_incomplete", true)
	}
	return om("items", filtered, "itemVar", itemVar, "indexVar", indexVar, "totalItems", float64(len(filtered)),
		"matchedItems", matched, "deferredItems", deferred, "maxItems", maxItems, "workers", workers), nil
}

func orOne(f float64) float64 {
	if f == 0 {
		return 1
	}
	return f
}

func itemName(it any) string {
	m := asMap(it)
	if s := str(m, "fileName"); s != "" {
		return s
	}
	if s := str(m, "name"); s != "" {
		return s
	}
	if p := str(m, "path"); p != "" {
		parts := strings.Split(p, "/")
		return parts[len(parts)-1]
	}
	return jsString(it)
}

func resolveSourceArray(source string, ctx *Ctx) (any, bool) {
	if v, ok := ctx.Vars[source]; ok {
		return v, true
	}
	parts := strings.Split(source, ".")
	var cur any
	var ok bool
	if parts[0] == "vars" && len(parts) > 1 {
		cur, ok = ctx.Vars[parts[1]]
		parts = parts[2:]
	} else {
		cur, ok = ctx.Vars[parts[0]]
		parts = parts[1:]
	}
	if ok {
		if v, found := walk(cur, parts); found {
			return v, true
		}
	}
	return walk(ctx.Input, strings.Split(source, "."))
}

func strOr(m map[string]any, k, def string) string {
	if s := str(m, k); s != "" {
		return s
	}
	return def
}

func jsTypeof(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case float64, int, int64:
		return "number"
	case bool:
		return "boolean"
	}
	return "object"
}

// ── aggregate split / join ───────────────────────────────────────────────────

func execAggregateSplit(r *Run, node *Node, ctx *Ctx) (any, error) {
	branches := 2.0
	if b, ok := num(node.Data, "branches"); ok && b > 0 {
		branches = b
	}
	strategy := strOr(node.Data, "strategy", "parallel")
	ids := make([]any, int(branches))
	for i := range ids {
		ids[i] = fmt.Sprintf("%s-branch-%d", node.ID, i+1)
	}
	ctx.set("__aggregate_"+node.ID+"_branches", om(
		"type", "fan-out", "totalBranches", branches, "strategy", strategy, "branchIds", ids, "createdAt", isoNow(),
	))
	ctx.set("__aggregate_"+node.ID+"_results", []any{})
	out := om("__isAggregate", true, "__aggregateType", "fan-out", "branches", ids, "strategy", strategy)
	if v, ok := ctx.Vars["input"]; ok {
		jsSet(out, "input", v)
	}
	return out, nil
}

func execAggregateJoin(r *Run, node *Node, ctx *Ctx) (any, error) {
	waitFor := node.Data["waitFor"]
	if waitFor == nil {
		waitFor = "all"
	}
	var keys []string
	for k := range ctx.Vars {
		if strings.HasPrefix(k, "__aggregate_") && strings.HasSuffix(k, "_branches") {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("No upstream aggregate-split node found")
	}
	sort.Strings(keys)
	split := strings.TrimSuffix(strings.TrimPrefix(keys[0], "__aggregate_"), "_branches")
	results, _ := ctx.Vars["__aggregate_"+split+"_results"].([]any)
	info := asMap(ctx.Vars["__aggregate_"+split+"_branches"])
	total, _ := num(info, "totalBranches")

	wait := false
	switch w := waitFor.(type) {
	case string:
		if w == "all" {
			wait = float64(len(results)) < total
		} else if w == "any" {
			wait = len(results) == 0
		}
	case float64:
		wait = float64(len(results)) < w
	}
	if wait {
		return om("__isAggregate", true, "__aggregateType", "fan-in", "status", "waiting",
			"received", float64(len(results)), "expected", total, "waitFor", waitFor), nil
	}
	var aggregated any
	if waitFor == "any" {
		aggregated = nil
		for _, x := range results {
			if m := asMap(x); truthy(m["success"]) {
				aggregated = m["data"]
				break
			}
		}
	} else {
		ok, failed := []any{}, []any{}
		for _, x := range results {
			m := asMap(x)
			if truthy(m["success"]) {
				ok = append(ok, m["data"])
			} else {
				failed = append(failed, om("error", m["error"], "branchId", m["branchId"]))
			}
		}
		aggregated = om("allResults", results, "successfulResults", ok, "failedResults", failed)
	}
	succ, fail, dur := 0.0, 0.0, 0.0
	for _, x := range results {
		m := asMap(x)
		if truthy(m["success"]) {
			succ++
		} else {
			fail++
		}
		d, _ := num(m, "duration")
		dur += d
	}
	avg := math.NaN()
	if len(results) > 0 {
		avg = dur / float64(len(results))
	}
	summary := om("total", float64(len(results)), "success", succ, "failed", fail)
	if !math.IsNaN(avg) {
		jsSet(summary, "avgDuration", avg)
	} else {
		jsSet(summary, "avgDuration", nil)
	}
	return om("__isAggregate", true, "__aggregateType", "fan-in", "status", "completed",
		"results", aggregated, "summary", summary), nil
}

// ── JS helpers ───────────────────────────────────────────────────────────────

func newVM(r *Run, ctx *Ctx) *goja.Runtime {
	vm := goja.New()
	vm.SetFieldNameMapper(goja.TagFieldNameMapper("json", true))
	console := vm.NewObject()
	logFn := func(level string) func(goja.FunctionCall) goja.Value {
		return func(c goja.FunctionCall) goja.Value {
			parts := make([]string, len(c.Arguments))
			for i, a := range c.Arguments {
				parts[i] = a.String()
			}
			r.log(level, "", strings.Join(parts, " "), nil)
			return goja.Undefined()
		}
	}
	_ = console.Set("log", logFn("info"))
	_ = console.Set("info", logFn("info"))
	_ = console.Set("warn", logFn("warn"))
	_ = console.Set("error", logFn("error"))
	_ = vm.Set("console", console)
	return vm
}

// contextObject gives transform code the parts of the TS ExecutionContext it
// can use: variables/nodeResults with get/has, input and flow.
func contextObject(vm *goja.Runtime, r *Run, ctx *Ctx) goja.Value {
	o := vm.NewObject()
	vars := vm.NewObject()
	_ = vars.Set("get", func(k string) goja.Value {
		v, ok := ctx.Vars[k]
		if !ok {
			return goja.Undefined()
		}
		return jsIn(vm, v)
	})
	_ = vars.Set("has", func(k string) bool { _, ok := ctx.Vars[k]; return ok })
	_ = vars.Set("set", func(k string, v goja.Value) { ctx.set(k, jsOut(v)) })
	results := vm.NewObject()
	_ = results.Set("get", func(k string) any {
		if res, ok := r.results.get(k); ok {
			b, _ := json.Marshal(res)
			var m any
			_ = json.Unmarshal(b, &m)
			return m
		}
		return nil
	})
	_ = o.Set("variables", vars)
	_ = o.Set("nodeResults", results)
	_ = o.Set("input", jsIn(vm, ctx.Input))
	_ = o.Set("flow", map[string]any{"operationId": r.flow.OperationID})
	return o
}

// needsNode is true when JS code touched something only Node provides.
func needsNode(err error) bool {
	var ex *goja.Exception
	if errors.As(err, &ex) {
		msg := ex.Value().String()
		for _, g := range []string{"Buffer", "require", "process", "setTimeout", "TextEncoder", "URL"} {
			if strings.Contains(msg, "ReferenceError: "+g+" is not defined") {
				return true
			}
		}
	}
	return false
}

func jsErr(err error) string {
	var ex *goja.Exception
	if errors.As(err, &ex) {
		v := ex.Value()
		if o, ok := v.(*goja.Object); ok {
			if m := o.Get("message"); m != nil {
				return m.String()
			}
		}
		return v.String()
	}
	return err.Error()
}

// exportValue turns a goja value into plain JSON-like Go data.
func exportValue(v goja.Value) any {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return nil
	}
	b, err := json.Marshal(v.Export())
	if err != nil {
		return v.Export()
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// varsObject is Object.fromEntries(context.variables): a new object whose
// values are the live variable values.
func varsObject(ctx *Ctx) map[string]any {
	m := make(map[string]any, len(ctx.Vars))
	for k, v := range ctx.Vars {
		m[k] = v
	}
	return m
}

// processExecutionExists ports ConditionExecutor.processExecutionExists:
// "year={{year}}" or "'year', {{year}}".
func processExecutionExists(r *Run, ctx *Ctx, args string) bool {
	var key string
	var val any
	found := false
	if m := existsKeyValue.FindStringSubmatch(args); m != nil {
		key = m[1]
		val, found = ctx.valueByPath(existsTplEnds.ReplaceAllString(strings.TrimSpace(m[2]), ""))
	} else {
		parts := strings.Split(args, ",")
		if len(parts) >= 2 {
			key = strings.Trim(strings.TrimSpace(parts[0]), `'"`)
			val, found = ctx.valueByPath(existsTplEnds.ReplaceAllString(strings.TrimSpace(parts[1]), ""))
		}
	}
	if key == "" || !found {
		log.Printf("[ConditionExecutor] Invalid executions.exists() format: %s", args)
		return false
	}
	exists := checkDuplicateExecution(r.flow.OperationID, key, jsString(val))
	ctx.set("executionsExists", exists)
	ctx.set("executionsCheckKey", key)
	ctx.set("executionsCheckValue", val)
	return exists
}

// checkDuplicateExecution: did a successful run of this flow in the last 365
// days use parameter key=value? (last 50 runs, like the TypeScript).
func checkDuplicateExecution(flowID, key, value string) bool {
	rows, err := appQuery(`SELECT result FROM executions WHERE "flowId" = $1 AND status = 'Success'
		AND "startedAt" >= $2 ORDER BY "startedAt" DESC LIMIT 50`, flowID, time.Now().AddDate(0, 0, -365))
	if err != nil {
		log.Printf("[ConditionExecutor] Error checking duplicate execution: %v", err)
		return false
	}
	for _, row := range rows {
		s, _ := row["result"].(string)
		if s == "" {
			continue
		}
		res, err := jsDecode([]byte(s))
		if err != nil {
			continue
		}
		params := asMap(asMap(asMap(res)["trigger"])["parameters"])
		if v, ok := params[key]; ok && jsString(v) == value {
			log.Printf("[ConditionExecutor] Duplicate found: Flow %s already executed with %s=%s", flowID, key, value)
			return true
		}
	}
	return false
}
