package main

// Port of server/src/sdk/execution/executors/ApiOutputExecutor.ts: the HTTP
// response of a rest-api flow. Priority: file download mode, auto-detected
// file download, OpenAPI-schema transform (context.apiSpec), auto transform
// with field mappings, legacy JavaScript mapping, static body, previous
// node's output. JavaScript `undefined` is tracked with undefinedV and
// dropped (like JSON.stringify) before the result leaves the executor.

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/dop251/goja"
)

func init() { nativeExecutors["api-output"] = execAPIOutput }

func execAPIOutput(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	if str(d, "responseMode") == "file" {
		return pxClean(pxFileDownload(r, node, d)), nil
	}

	prev := pxPrevNodeOutput(r, node.ID)
	if fd := prop(prev, "_fileDownload"); truthy(fd) && fd != undefinedV {
		r.log("info", node.ID, "API Output: Auto-detected file download from input", nil)
		return pxClean(om("statusCode", pxStatus(d), "body", prev)), nil
	}

	var body any
	mode := "default"
	if d["useApiSpecSchema"] != false && truthy(r.req.ApiSpec) {
		body = pxSchemaTransform(r, node.ID)
		mode = "schema"
	} else if truthy(d["autoTransform"]) {
		body = pxAutoTransform(d, r, node.ID)
		mode = "auto"
	} else if m, ok := d["mapping"]; ok && truthy(m) {
		var err error
		body, err = pxMapping(r, node, ctx, jsString(m))
		if err != nil {
			return nil, err
		}
		mode = "mapping"
	} else if b, ok := d["body"]; ok {
		body = pxResolveBody(b, ctx)
		mode = "static"
	} else {
		body = pxPrevNodeOutput(r, node.ID)
		mode = "previous"
	}

	body = pxConvertResponseType(body, str(d, "responseType"))

	if truthy(d["wrapInDataKey"]) && !truthy(prop(body, "data")) {
		res := map[string]any{"data": body}
		if truthy(d["includeMetadata"]) {
			res["_meta"] = pxMetadata(body)
		}
		body = res
	}

	headers := d["headers"]
	if !truthy(headers) {
		headers = map[string]any{"Content-Type": "application/json"}
	}
	resp := om("statusCode", pxStatus(d), "body", body, "headers", headers)
	logData := om("statusCode", resp["statusCode"], "headers", headers, "body", body, "transformMode", mode)
	if fm, ok := d["fieldMappings"]; ok {
		logData["fieldMappings"] = fm
	}
	r.log("debug", node.ID, "API Output Response", pxClean(logData))
	return pxClean(resp), nil
}

func pxStatus(d map[string]any) any {
	if v := d["statusCode"]; truthy(v) {
		return v
	}
	return float64(200)
}

// pxPrevNodeOutput ports getFromPreviousNode: the output of the node on the
// first incoming edge when truthy, else the output of the last node that ran.
func pxPrevNodeOutput(r *Run, nodeID string) any {
	for _, e := range r.flow.Edges {
		if e.Target == nodeID {
			if res, ok := r.results.get(e.Source); ok && truthy(res.Output) {
				return res.Output
			}
			break
		}
	}
	list := r.results.list()
	if len(list) > 0 {
		if list[len(list)-1].Output == nil {
			return undefinedV
		}
		return list[len(list)-1].Output
	}
	return undefinedV
}

// ── schema transform ─────────────────────────────────────────────────────────

func pxJSTypeof(v any) string {
	switch v.(type) {
	case *undefinedT:
		return "undefined"
	case string:
		return "string"
	case float64, int, int64:
		return "number"
	case bool:
		return "boolean"
	}
	return "object"
}

func pxSchemaTransform(r *Run, nodeID string) any {
	input := pxPrevNodeOutput(r, nodeID)
	spec := r.req.ApiSpec
	opID := r.flow.OperationID
	_, isArr := input.([]any)
	logData := om("input", input, "inputType", pxJSTypeof(input), "isArray", isArr, "hasApiSpec", truthy(spec), "operationId", opID)
	ops, _ := prop(spec, "operations").([]any)
	if ops != nil {
		ids := make([]any, len(ops))
		for i, o := range ops {
			ids[i] = prop(o, "id")
		}
		logData["availableOperations"] = ids
	}
	r.log("debug", nodeID, "API Output Schema Transform", pxClean(logData))

	var operation any = undefinedV
	for _, o := range ops {
		if id, ok := prop(o, "id").(string); ok && id == opID {
			operation = o
			break
		}
	}
	if operation == undefinedV {
		r.log("debug", nodeID, "API Output: No operation found in apiSpec, using auto-detect", nil)
		return pxAutoDetect(input)
	}
	var success any = undefinedV
	if resps, ok := prop(operation, "responses").([]any); ok {
		for _, x := range resps {
			if c, ok := prop(x, "code").(string); ok && (c == "200" || c == "201") {
				success = x
				break
			}
		}
	}
	schema := prop(prop(prop(success, "content"), "application/json"), "schema")
	if !truthy(schema) {
		fmt.Println("[ApiOutputExecutor] No response schema found, using auto-detect")
		return pxAutoDetect(input)
	}
	props, _ := prop(schema, "properties").(map[string]any)
	keys := []any{}
	if truthy(prop(schema, "properties")) {
		for _, k := range pxSortedMapKeys(props) {
			keys = append(keys, k)
		}
	}
	r.log("debug", nodeID, "API Output: Transforming with schema", pxClean(om(
		"schemaType", prop(schema, "type"), "hasProperties", truthy(prop(schema, "properties")), "propertyKeys", keys)))

	source := input
	if rows, ok := prop(input, "rows").([]any); ok {
		source = rows
	}
	stype := prop(schema, "type")
	srcArr, srcIsArr := source.([]any)
	switch {
	case stype == "array" && srcIsArr:
		items := prop(schema, "items")
		if !truthy(items) {
			items = map[string]any{"type": "object"}
		}
		out := make([]any, len(srcArr))
		for i, it := range srcArr {
			out[i] = pxItemBySchema(it, items)
		}
		return out
	case stype == "object" && srcIsArr:
		if prop(prop(schema, "properties"), "data") != undefinedV && prop(prop(prop(schema, "properties"), "data"), "type") == "array" {
			res := map[string]any{}
			for _, k := range pxSortedMapKeys(props) {
				ps := props[k]
				switch {
				case k == "data" && prop(ps, "type") == "array":
					items := prop(ps, "items")
					if !truthy(items) {
						items = map[string]any{"type": "object"}
					}
					out := make([]any, len(srcArr))
					for i, it := range srcArr {
						out[i] = pxItemBySchema(it, items)
					}
					res[k] = out
				case k == "total" && prop(ps, "type") == "integer":
					if rc := prop(input, "rowCount"); truthy(rc) {
						res[k] = rc
					} else if len(srcArr) > 0 {
						res[k] = float64(len(srcArr))
					} else {
						res[k] = float64(0)
					}
				default:
					res[k] = pxValueBySchema(prop(input, k), ps)
				}
			}
			return res
		}
		var first any = undefinedV
		if len(srcArr) > 0 {
			first = srcArr[0]
		}
		return pxItemBySchema(first, schema)
	case stype == "object" && pxJSTypeof(source) == "object":
		return pxItemBySchema(source, schema)
	}
	r.log("debug", nodeID, "API Output: Schema transform - no match, returning as-is", pxClean(om(
		"schemaType", prop(schema, "type"), "sourceDataType", pxJSTypeof(source), "isArray", srcIsArr)))
	return source
}

func pxSortedMapKeys(m map[string]any) []string { return jsKeys(m) }

func pxItemBySchema(item, schema any) any {
	if !truthy(item) || pxJSTypeof(item) != "object" {
		return item
	}
	props, ok := prop(schema, "properties").(map[string]any)
	if !truthy(prop(schema, "properties")) {
		return item
	}
	res := map[string]any{}
	if !ok {
		return res
	}
	for _, name := range pxSortedMapKeys(props) {
		res[name] = pxValueBySchema(pxFindField(item, name), props[name])
	}
	return res
}

var (
	pxUpperRe      = regexp.MustCompile(`[A-Z]`)
	pxUnderLowerRe = regexp.MustCompile(`_([a-z])`)
)

func pxFindField(source any, target string) any {
	if !truthy(source) || pxJSTypeof(source) != "object" {
		return undefinedV
	}
	if v := prop(source, target); v != undefinedV {
		return v
	}
	snake := pxUpperRe.ReplaceAllStringFunc(target, func(s string) string { return "_" + strings.ToLower(s) })
	if v := prop(source, snake); v != undefinedV {
		return v
	}
	upper := strings.TrimPrefix(strings.ToUpper(pxUpperRe.ReplaceAllString(target, "_$0")), "_")
	if v := prop(source, upper); v != undefinedV {
		return v
	}
	camel := pxUnderLowerRe.ReplaceAllStringFunc(target, func(s string) string { return strings.ToUpper(s[1:]) })
	if v := prop(source, camel); v != undefinedV {
		return v
	}
	lt := strings.ReplaceAll(strings.ToLower(target), "_", "")
	switch t := source.(type) {
	case map[string]any:
		for _, k := range pxSortedMapKeys(t) {
			if strings.ReplaceAll(strings.ToLower(k), "_", "") == lt {
				return t[k]
			}
		}
	case []any:
		for i, v := range t {
			if strconv.Itoa(i) == lt {
				return v
			}
		}
	}
	return undefinedV
}

func pxValueBySchema(v, schema any) any {
	if v == undefinedV || v == nil {
		return v
	}
	typ := prop(schema, "type")
	if !truthy(typ) {
		typ = "string"
	}
	switch typ {
	case "string":
		return pxJSString(v)
	case "integer", "number":
		return pxNumber(v)
	case "boolean":
		return truthy(v)
	case "array":
		if arr, ok := v.([]any); ok {
			items := prop(schema, "items")
			if !truthy(items) {
				items = map[string]any{"type": "object"}
			}
			out := make([]any, len(arr))
			for i, x := range arr {
				out[i] = pxValueBySchema(x, items)
			}
			return out
		}
		return []any{v}
	case "object":
		if truthy(prop(schema, "properties")) && pxJSTypeof(v) == "object" {
			return pxItemBySchema(v, schema)
		}
		return v
	}
	return v
}

// pxJSString is String(v) including undefined inside arrays.
func pxJSString(v any) string {
	if v == undefinedV {
		return "undefined"
	}
	return jsString(v)
}

// pxNumber is JavaScript's Number(v).
func pxNumber(v any) any {
	switch t := v.(type) {
	case *undefinedT:
		return math.NaN()
	case nil:
		return float64(0)
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case bool:
		if t {
			return float64(1)
		}
		return float64(0)
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return float64(0)
		}
		ls := strings.ToLower(s)
		if len(s) > 2 && (strings.HasPrefix(ls, "0x") || strings.HasPrefix(ls, "0o") || strings.HasPrefix(ls, "0b")) {
			if n, err := strconv.ParseInt(s[2:], map[byte]int{'x': 16, 'o': 8, 'b': 2}[ls[1]], 64); err == nil {
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
		if strings.ContainsAny(ls, "inx_") { // ParseFloat accepts "inf", "nan", hex, underscores; JS does not
			return math.NaN()
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return math.NaN()
		}
		return f
	case []any:
		switch len(t) {
		case 0:
			return float64(0)
		case 1:
			return pxNumber(pxJSString(t[0]))
		}
		return math.NaN()
	}
	return math.NaN()
}

// ── auto transform ───────────────────────────────────────────────────────────

func pxAutoTransform(d map[string]any, r *Run, nodeID string) any {
	input := pxPrevNodeOutput(r, nodeID)
	mappings, _ := d["fieldMappings"].([]any)
	if len(mappings) == 0 {
		return pxAutoDetect(input)
	}
	res := map[string]any{}
	for _, m := range mappings {
		mm := asMap(m)
		v := pxGetByPath(input, str(mm, "source"))
		v = pxTransformValue(v, str(mm, "transform"))
		pxSetByPath(res, jsString(mm["target"]), v)
	}
	return res
}

func pxAutoDetect(input any) any {
	if !truthy(input) {
		return input
	}
	if rows, ok := prop(input, "rows").([]any); ok {
		return rows
	}
	if prop(input, "data") != undefinedV && (truthy(prop(input, "status")) || truthy(prop(input, "statusCode"))) {
		return prop(input, "data")
	}
	if row := prop(input, "row"); truthy(row) && pxJSTypeof(row) == "object" {
		return row
	}
	return input
}

func pxTransformValue(v any, t string) any {
	if v == undefinedV || v == nil {
		return v
	}
	switch t {
	case "string", "date":
		return pxJSString(v)
	case "number":
		return pxNumber(v)
	case "boolean":
		return truthy(v)
	case "array":
		if _, ok := v.([]any); ok {
			return v
		}
		return []any{v}
	}
	return v
}

func pxGetByPath(obj any, path string) any {
	if path == "" {
		return obj
	}
	v := obj
	for _, key := range strings.Split(path, ".") {
		if v == nil || v == undefinedV {
			return undefinedV
		}
		if m := arrayPart.FindStringSubmatch(key); m != nil {
			arr, ok := prop(v, m[1]).([]any)
			if !ok {
				return undefinedV
			}
			i, _ := strconv.Atoi(m[2])
			if i >= len(arr) {
				return undefinedV
			}
			v = arr[i]
			continue
		}
		v = prop(v, key)
	}
	return v
}

func pxSetByPath(obj map[string]any, path string, v any) {
	keys := strings.Split(path, ".")
	cur := obj
	for _, k := range keys[:len(keys)-1] {
		next, ok := cur[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[k] = next
		}
		cur = next
	}
	cur[keys[len(keys)-1]] = v
}

func pxConvertResponseType(body any, t string) any {
	switch t {
	case "array":
		if _, ok := body.([]any); ok {
			return body
		}
		if truthy(body) {
			return []any{body}
		}
		return []any{}
	case "string":
		if s, ok := body.(string); ok {
			return s
		}
		if body == undefinedV {
			return undefinedV
		}
		return string(jsonStringify(pxClean(body), nil))
	case "number":
		return pxNumber(body)
	case "boolean":
		return truthy(body)
	}
	if pxJSTypeof(body) == "object" {
		return body
	}
	return map[string]any{"value": body}
}

func pxMetadata(body any) map[string]any {
	meta := map[string]any{"timestamp": isoNow()}
	switch t := body.(type) {
	case []any:
		meta["count"] = float64(len(t))
	case map[string]any:
		meta["count"] = float64(len(t))
	}
	return meta
}

// ── legacy JavaScript mapping ────────────────────────────────────────────────

func pxMapping(r *Run, node *Node, ctx *Ctx, mapping string) (any, error) {
	input := pxPrevNodeOutput(r, "")
	vm := newVM(r, ctx)
	in, _ := ctx.Input.(map[string]any)
	arg := func(k string) goja.Value {
		if v, ok := in[k]; ok {
			return jsIn(vm, v)
		}
		return goja.Undefined()
	}
	inputV := goja.Undefined()
	if input != undefinedV {
		inputV = jsIn(vm, input)
	}
	vars := make(map[string]any, len(ctx.Vars))
	for k, v := range ctx.Vars {
		vars[k] = v
	}
	var result any
	var jsError string
	fn, err := vm.RunString("(function anonymous(input,path,query,body,header,vars\n) {\n\n        \"use strict\";\n        return " + mapping + ";\n      \n})")
	if err != nil {
		jsError = jsErr(err)
	} else {
		call, _ := goja.AssertFunction(fn)
		ret, err := call(goja.Undefined(), inputV, arg("params"), arg("query"), arg("body"), arg("headers"), jsIn(vm, vars))
		if err != nil {
			if needsNode(err) {
				return nil, errUseFallback
			}
			jsError = jsErr(err)
		} else if goja.IsUndefined(ret) {
			result = undefinedV
		} else {
			result = jsOut(ret)
		}
	}
	r.log("debug", node.ID, "API Output: Executing mapping expression", pxClean(om("mapping", mapping, "input", input)))
	if jsError != "" {
		r.log("error", node.ID, "API Output: Mapping error", map[string]any{"error": jsError})
		return map[string]any{"error": "Invalid mapping expression"}, nil
	}
	r.log("debug", node.ID, "API Output: Mapping result", pxClean(map[string]any{"result": result}))
	return result, nil
}

// ── static body ──────────────────────────────────────────────────────────────

func pxResolveBody(body any, ctx *Ctx) any {
	switch t := body.(type) {
	case string:
		return pxTemplate(ctx, t)
	case map[string]any:
		res := map[string]any{}
		for k, v := range t {
			if s, ok := v.(string); ok {
				res[k] = pxTemplate(ctx, s)
			} else {
				res[k] = v
			}
		}
		copyOrder(res, t)
		return res
	case []any: // Object.entries over an array
		res := map[string]any{}
		for i, v := range t {
			if s, ok := v.(string); ok {
				res[strconv.Itoa(i)] = pxTemplate(ctx, s)
			} else {
				res[strconv.Itoa(i)] = v
			}
		}
		return res
	}
	return body
}

// pxTemplate is resolveTemplate keeping `undefined` apart from null.
func pxTemplate(ctx *Ctx, s string) any {
	v := ctx.resolveTemplate(s)
	if v != nil {
		return v
	}
	trimmed := strings.TrimSpace(s)
	depth, end := 0, -1
	for i := 0; i < len(trimmed)-1 && end < 0; i++ {
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
	}
	if end > 2 {
		if _, ok := ctx.standardValue(strings.TrimSpace(trimmed[2:end])); !ok {
			return undefinedV
		}
	}
	return nil
}

// ── file download ────────────────────────────────────────────────────────────

var pxMimeTypes = map[string]string{
	".zip":  "application/zip",
	".pdf":  "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls":  "application/vnd.ms-excel",
	".csv":  "text/csv",
	".json": "application/json",
	".xml":  "application/xml",
	".txt":  "text/plain",
}

func pxFileDownload(r *Run, node *Node, d map[string]any) any {
	input := pxPrevNodeOutput(r, node.ID)
	r.log("debug", node.ID, "API Output: File download mode", pxClean(map[string]any{"input": input}))

	var filePath, fileName any = undefinedV, undefinedV
	or := func(a, b any) any {
		if truthy(a) {
			return a
		}
		return b
	}
	if files, ok := prop(input, "files").([]any); ok && len(files) > 0 {
		f := files[0]
		fd := or(prop(f, "data"), f)
		filePath = prop(fd, "path")
		fileName = or(prop(fd, "fileName"), prop(fd, "name"))
	} else if p := prop(input, "path"); truthy(p) {
		filePath = p
		fileName = or(or(prop(input, "fileName"), prop(input, "name")), filepath.Base(jsString(p)))
	} else if p := prop(prop(input, "data"), "path"); truthy(p) {
		filePath = p
		dd := prop(input, "data")
		fileName = or(or(prop(dd, "fileName"), prop(dd, "name")), filepath.Base(jsString(p)))
	}

	fp, _ := filePath.(string)
	if !truthy(filePath) || !pxExists(fp) {
		r.log("error", node.ID, "API Output: File not found for download", pxClean(om("filePath", filePath, "input", input)))
		return om(
			"statusCode", float64(404),
			"body", om("error", "File not found", "path", filePath), "headers", map[string]any{"Content-Type": "application/json"},
		)
	}
	mime := pxMimeTypes[strings.ToLower(pxExtname(fp))]
	if mime == "" {
		mime = "application/octet-stream"
	}
	st, _ := os.Stat(fp)
	size := st.Size()
	name := filepath.Base(fp)
	if truthy(fileName) {
		name = jsString(fileName)
	}
	r.log("info", node.ID, fmt.Sprintf("API Output: File download - %s (%d bytes)", name, size), om("filePath", fp, "fileName", name, "mimeType", mime, "fileSize", float64(size)))
	return om(
		"statusCode", pxStatus(d),
		"body", om(
			"_fileDownload", om("filePath", fp, "fileName", name, "mimeType", mime, "fileSize", float64(size)), "headers", om(
				"Content-Type", mime,
				"Content-Disposition", `attachment; filename="`+pxEncodeURIComponent(name)+`"`,
				"Content-Length", strconv.FormatInt(size, 10),
			),
		),
	)
}

// pxEncodeURIComponent is JavaScript's encodeURIComponent.
func pxEncodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// pxClean drops undefined like JSON.stringify: object keys removed, array
// items become null, NaN/Infinity become null.
func pxClean(v any) any {
	switch t := v.(type) {
	case *undefinedT:
		return nil
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			if x == undefinedV {
				continue
			}
			out[k] = pxClean(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = pxClean(x)
		}
		return out
	}
	return v
}
