package main

// Differential harness: runs the original TypeScript executor (through
// ts-node, transpile-only) on the same node, input, variables and previous
// results as the Go executor, so tests can compare outputs and logs.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const pxHarness = `
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const fs = require('fs');
const [execFile, className, specFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const Cls = require(execFile)[className];
const ex = new Cls();
const ctx = {
  flow: spec.flow, input: spec.input, variables: new Map(Object.entries(spec.variables || {})),
  nodeResults: new Map((spec.results || []).map(r => [r.nodeId, r])), logs: [], apiSpec: spec.apiSpec,
};
(async () => {
  let out, error;
  try { out = await ex.executeNode(spec.node, ctx); } catch (e) { error = e.message; }
  process.stdout.write('\n@@' + JSON.stringify({ out, error, logs: ctx.logs.map(l => ({ level: l.level, message: l.message, data: l.data })) }));
  process.exit(0);
})();`

type pxTSResult struct {
	Out   any              `json:"out"`
	Error string           `json:"error"`
	Logs  []map[string]any `json:"logs"`
}

func pxRunTS(t *testing.T, executor, class string, spec map[string]any, env ...string) pxTSResult {
	t.Helper()
	dir := t.TempDir()
	sf := filepath.Join(dir, "spec.json")
	b, _ := json.Marshal(spec)
	_ = os.WriteFile(sf, b, 0o644)
	if os.Getenv("PXPORT_SERVER_DIR") != "" {
		pxServerDir = os.Getenv("PXPORT_SERVER_DIR")
	}
	for i := 0; i+1 < len(env); i += 2 {
		t.Setenv(env[i], env[i+1])
	}
	out := pxNode(t, pxHarness, filepath.Join(pxServerDir, "src/sdk/execution/executors", executor), class, sf)
	i := strings.LastIndex(out, "\n@@")
	if i < 0 {
		t.Fatalf("harness output: %s", out)
	}
	var res pxTSResult
	if err := json.Unmarshal([]byte(out[i+3:]), &res); err != nil {
		t.Fatalf("harness json: %v\n%s", err, out)
	}
	return res
}

// pxGoRun runs a native executor the same way and returns the same shape.
func pxGoRun(t *testing.T, fn nativeFn, spec map[string]any) pxTSResult {
	t.Helper()
	b, _ := json.Marshal(spec)
	var req struct {
		Flow      Flow           `json:"flow"`
		Node      Node           `json:"node"`
		Input     any            `json:"input"`
		Variables map[string]any `json:"variables"`
		Results   []NodeResult   `json:"results"`
		ApiSpec   any            `json:"apiSpec"`
	}
	if err := json.Unmarshal(b, &req); err != nil {
		t.Fatal(err)
	}
	if req.Variables == nil {
		req.Variables = map[string]any{}
	}
	er := &ExecuteRequest{RunID: "t", Flow: req.Flow, Input: req.Input, Variables: req.Variables, ApiSpec: req.ApiSpec}
	r := newRun(er, func(map[string]any) {})
	for _, res := range req.Results {
		r.results.set(res, false)
	}
	ctx := &Ctx{ID: "root", Input: req.Input, Vars: req.Variables, dirty: map[string]bool{}, run: r}
	out, err := fn(r, &req.Node, ctx)
	res := pxTSResult{Logs: []map[string]any{}}
	if err != nil {
		res.Error = err.Error()
	} else {
		res.Out = pxRoundTrip(out)
	}
	for _, l := range r.logs {
		m := map[string]any{"level": l.Level, "message": l.Message}
		if l.Data != nil {
			m["data"] = pxRoundTrip(l.Data)
		}
		res.Logs = append(res.Logs, m)
	}
	return res
}

func pxRoundTrip(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// pxMask replaces values under the given keys (timestamps etc.) everywhere.
func pxMask(v any, keys ...string) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			masked := false
			for _, m := range keys {
				if k == m {
					masked = true
				}
			}
			if masked {
				out[k] = "<masked>"
			} else {
				out[k] = pxMask(x, keys...)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = pxMask(x, keys...)
		}
		return out
	}
	return v
}

func pxCompare(t *testing.T, name string, ts, gor pxTSResult, mask ...string) {
	t.Helper()
	a := pxMask(pxRoundTrip(ts), mask...)
	b := pxMask(pxRoundTrip(gor), mask...)
	if !reflect.DeepEqual(a, b) {
		ja, _ := json.MarshalIndent(a, "", " ")
		jb, _ := json.MarshalIndent(b, "", " ")
		t.Fatalf("%s differs\nTS: %s\nGo: %s", name, ja, jb)
	}
}
