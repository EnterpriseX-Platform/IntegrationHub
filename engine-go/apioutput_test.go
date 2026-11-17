package main

import (
	"os"
	"path/filepath"
	"testing"
)

func pxAOSpec(nodeData map[string]any, prevOut any, extra map[string]any) map[string]any {
	results := []any{}
	if prevOut != nil {
		results = append(results, map[string]any{"nodeId": "db", "nodeType": "database", "success": true, "output": prevOut})
	}
	spec := map[string]any{
		"flow": map[string]any{"operationId": "getAgencies",
			"nodes": []any{map[string]any{"id": "db", "type": "database", "data": map[string]any{}}, map[string]any{"id": "out", "type": "api-output", "data": nodeData}},
			"edges": []any{map[string]any{"id": "e1", "source": "db", "target": "out"}}},
		"node":      map[string]any{"id": "out", "type": "api-output", "data": nodeData},
		"input":     map[string]any{"params": map[string]any{"year": "2567"}, "query": map[string]any{"q": "x"}, "body": map[string]any{"name": "n"}, "headers": map[string]any{"authorization": "B"}},
		"variables": map[string]any{"db": prevOut, "greeting": "hello", "nul": nil},
		"results":   results,
	}
	for k, v := range extra {
		spec[k] = v
	}
	return spec
}

func TestPxportApiOutputDifferential(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "report.xlsx")
	_ = os.WriteFile(file, []byte("xlsxdata"), 0o644)
	dbOut := map[string]any{"rows": []any{
		map[string]any{"agc_code": "01", "AGC_NAME": "A", "budget_amt": "12.50", "is_active": float64(1), "tags": "x", "nested": map[string]any{"in_value": "5"}},
		map[string]any{"agc_code": "02", "AGC_NAME": "B", "budget_amt": "abc", "is_active": float64(0), "tags": []any{"a", "b"}, "nested": nil},
	}, "rowCount": float64(2)}
	itemSchema := map[string]any{"type": "object", "properties": map[string]any{
		"agcCode": map[string]any{"type": "string"}, "agcName": map[string]any{"type": "string"}, "budgetAmt": map[string]any{"type": "number"},
		"isActive": map[string]any{"type": "boolean"}, "tags": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"nested": map[string]any{"type": "object", "properties": map[string]any{"inValue": map[string]any{"type": "integer"}}}, "missing": map[string]any{"type": "string"},
	}}
	spec := func(schema map[string]any) map[string]any {
		return map[string]any{"operations": []any{map[string]any{"id": "getAgencies", "responses": []any{
			map[string]any{"code": "200", "content": map[string]any{"application/json": map[string]any{"schema": schema}}}}}, map[string]any{"id": "other"}}}
	}

	cases := []struct {
		name  string
		data  map[string]any
		prev  any
		extra map[string]any
	}{
		{"schema-array", map[string]any{"statusCode": float64(200)}, dbOut, map[string]any{"apiSpec": spec(map[string]any{"type": "array", "items": itemSchema})}},
		{"schema-object-data-total", map[string]any{}, dbOut, map[string]any{"apiSpec": spec(map[string]any{"type": "object", "properties": map[string]any{
			"data": map[string]any{"type": "array", "items": itemSchema}, "total": map[string]any{"type": "integer"}, "rowCount": map[string]any{"type": "string"}}})}},
		{"schema-object-first", map[string]any{}, dbOut, map[string]any{"apiSpec": spec(itemSchema)}},
		{"schema-no-op", map[string]any{}, dbOut, map[string]any{"apiSpec": map[string]any{"operations": []any{map[string]any{"id": "zzz"}}}}},
		{"schema-no-schema", map[string]any{}, dbOut, map[string]any{"apiSpec": map[string]any{"operations": []any{map[string]any{"id": "getAgencies", "responses": []any{}}}}}},
		{"schema-disabled-auto", map[string]any{"useApiSpecSchema": false, "autoTransform": true}, dbOut, map[string]any{"apiSpec": spec(itemSchema)}},
		{"auto-mappings", map[string]any{"autoTransform": true, "fieldMappings": []any{
			map[string]any{"source": "rows[0].agc_code", "target": "data.code"}, map[string]any{"source": "rowCount", "target": "meta.total", "transform": "string"},
			map[string]any{"source": "rows[1].budget_amt", "target": "amt", "transform": "number"}, map[string]any{"source": "rows[5].x", "target": "gone"},
			map[string]any{"source": "rows[0].tags", "target": "tags", "transform": "array"}, map[string]any{"source": "rowCount", "target": "flag", "transform": "boolean"}}}, dbOut, nil},
		{"auto-detect-http", map[string]any{"autoTransform": true}, map[string]any{"data": map[string]any{"x": float64(1)}, "status": float64(200)}, nil},
		{"mapping", map[string]any{"mapping": "{ total: input.rowCount, year: path.year, q: query.q, who: body.name, auth: header.authorization, g: vars.greeting, first: input.rows[0].agc_code }"}, dbOut, nil},
		{"mapping-error", map[string]any{"mapping": "input.nope.deeper"}, dbOut, nil},
		{"mapping-undefined", map[string]any{"mapping": "undefined"}, dbOut, nil},
		{"mapping-array-wrap-meta", map[string]any{"mapping": "input.rows", "wrapInDataKey": true, "includeMetadata": true}, dbOut, nil},
		{"static", map[string]any{"statusCode": float64(201), "headers": map[string]any{"X-A": "1"}, "body": map[string]any{"msg": "{{greeting}} {{path.year}}", "raw": "{{nothing}}", "n": float64(3), "nul": "{{nul}}"}}, dbOut, nil},
		{"static-string-undefined", map[string]any{"body": "{{nothing}}"}, dbOut, nil},
		{"static-array", map[string]any{"body": []any{"{{greeting}}", float64(2)}}, dbOut, nil},
		{"static-null", map[string]any{"body": nil}, dbOut, nil},
		{"previous-string", map[string]any{"responseType": "string"}, dbOut, nil},
		{"previous-number", map[string]any{"responseType": "number"}, "42", nil},
		{"previous-scalar-wrap", map[string]any{}, "plain", nil},
		{"previous-array-type", map[string]any{"responseType": "array"}, map[string]any{"a": float64(1)}, nil},
		{"previous-boolean", map[string]any{"responseType": "boolean"}, float64(0), nil},
		{"wrap-has-data", map[string]any{"wrapInDataKey": true}, map[string]any{"data": "x"}, nil},
		{"no-previous", map[string]any{}, nil, nil},
		{"file-mode-path", map[string]any{"responseMode": "file"}, map[string]any{"path": file}, nil},
		{"file-mode-files", map[string]any{"responseMode": "file", "statusCode": float64(200)}, map[string]any{"files": []any{map[string]any{"data": map[string]any{"path": file, "fileName": "รายงาน 2567.xlsx"}}}}, nil},
		{"file-mode-missing", map[string]any{"responseMode": "file"}, map[string]any{"data": map[string]any{"path": "/nonexistent/x.csv"}}, nil},
		{"file-mode-nothing", map[string]any{"responseMode": "file"}, map[string]any{"x": float64(1)}, nil},
		{"auto-file-download", map[string]any{"statusCode": float64(206)}, map[string]any{"_fileDownload": map[string]any{"filePath": file}}, nil},
	}
	for _, c := range cases {
		s := pxAOSpec(c.data, c.prev, c.extra)
		ts := pxRunTS(t, "ApiOutputExecutor.ts", "ApiOutputExecutor", s)
		gor := pxGoRun(t, execAPIOutput, s)
		mask := []string{"timestamp"}
		if c.name == "mapping-error" { // goja words JS errors differently from V8
			mask = append(mask, "error")
			t.Logf("mapping error text: TS %q / Go %q", ts.Logs[1]["data"], gor.Logs[1]["data"])
		}
		pxCompare(t, c.name, ts, gor, mask...)
	}
}
