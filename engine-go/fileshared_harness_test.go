package main

// Test helpers: run the original TypeScript executors (FileReadExecutor /
// FileWriteExecutor) in Node with @prisma/client stubbed out, and the Go
// ports on the same node config, then compare.

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

const fioHarnessJS = `
const Module = require('module');
const path = require('path');
const serverDir = process.argv[2];
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '@prisma/client') return { PrismaClient: class { constructor() { return new Proxy({}, { get() { throw new Error('prisma not available in harness'); } }); } } };
  return origLoad.apply(this, arguments);
};
require(path.join(serverDir, 'node_modules/ts-node')).register({ transpileOnly: true, project: path.join(serverDir, 'tsconfig.json') });
const { FileReadExecutor } = require(path.join(serverDir, 'src/sdk/execution/executors/FileReadExecutor.ts'));
const { FileWriteExecutor } = require(path.join(serverDir, 'src/sdk/execution/executors/FileWriteExecutor.ts'));
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', async () => {
  const cases = JSON.parse(raw);
  const results = [];
  for (const c of cases) {
    const ex = c.kind === 'read' ? new FileReadExecutor() : new FileWriteExecutor();
    const context = { flow: { operationId: 'op_fileport', nodes: [], edges: [] }, input: c.input, variables: new Map(Object.entries(c.vars || {})), nodeResults: new Map(), logs: [] };
    const origLog = console.log; console.log = () => {};
    try {
      const out = await ex.executeNode({ id: 'n1', type: 'file-' + c.kind, data: c.data }, context);
      results.push({ ok: true, out: JSON.parse(JSON.stringify(out === undefined ? null : out)), logs: context.logs.map(l => l.message) });
    } catch (e) {
      results.push({ ok: false, error: e && e.message !== undefined ? e.message : String(e) });
    } finally { console.log = origLog; }
  }
  process.stdout.write(JSON.stringify(results));
});
`

type fioCase struct {
	Kind  string         `json:"kind"`
	Data  map[string]any `json:"data"`
	Input any            `json:"input"`
	Vars  map[string]any `json:"vars"`
}

type fioCaseResult struct {
	OK    bool     `json:"ok"`
	Out   any      `json:"out"`
	Error string   `json:"error"`
	Logs  []string `json:"logs"`
}

func fioServerDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "server")
}

func fioNode(t *testing.T) string {
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".nvm/versions/node/v23.1.0/bin/node")
	if _, err := os.Stat(p); err != nil {
		if lp, err := exec.LookPath("node"); err == nil {
			return lp
		}
		t.Skip("node not available")
	}
	return p
}

// fioRunTS runs the cases on the TypeScript executors.
func fioRunTS(t *testing.T, cases []fioCase) []fioCaseResult {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "harness.js")
	if err := os.WriteFile(script, []byte(fioHarnessJS), 0o644); err != nil {
		t.Fatal(err)
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command(fioNode(t), script, fioServerDir())
	cmd.Dir = fioServerDir()
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node harness: %v\n%s", err, stderr.String())
	}
	var res []fioCaseResult
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("harness output: %v\n%s", err, out)
	}
	return res
}

// fioRunGo runs the cases on the Go executors.
func fioRunGo(t *testing.T, cases []fioCase) []fioCaseResult {
	t.Helper()
	var res []fioCaseResult
	for _, c := range cases {
		req := &ExecuteRequest{Flow: Flow{OperationID: "op_fileport"}}
		r := newRun(req, func(map[string]any) {})
		// round-trip through JSON so values look like what the engine holds
		var data map[string]any
		b, _ := json.Marshal(c.Data)
		_ = json.Unmarshal(b, &data)
		var input any
		b, _ = json.Marshal(c.Input)
		_ = json.Unmarshal(b, &input)
		vars := map[string]any{}
		b, _ = json.Marshal(c.Vars)
		_ = json.Unmarshal(b, &vars)
		ctx := &Ctx{ID: "c0", Input: input, Vars: vars, dirty: map[string]bool{}, run: r}
		node := &Node{ID: "n1", Type: "file-" + c.Kind, Data: data}
		var out any
		var err error
		if c.Kind == "read" {
			out, err = execFileRead(r, node, ctx)
		} else {
			out, err = execFileWrite(r, node, ctx)
		}
		if err != nil {
			res = append(res, fioCaseResult{OK: false, Error: err.Error()})
			continue
		}
		var norm any
		b, _ = json.Marshal(out)
		_ = json.Unmarshal(b, &norm)
		logs := []string{}
		for _, l := range r.logs {
			logs = append(logs, l.Message)
		}
		res = append(res, fioCaseResult{OK: true, Out: norm, Logs: logs})
	}
	return res
}

// fioStrip removes keys whose values depend on the clock.
func fioStrip(v any, keys ...string) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			skip := false
			for _, s := range keys {
				if k == s {
					skip = true
				}
			}
			if !skip {
				out[k] = fioStrip(x, keys...)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = fioStrip(x, keys...)
		}
		return out
	}
	return v
}

func fioJSONText(v any) string {
	b, _ := json.MarshalIndent(v, "", " ")
	return string(b)
}
