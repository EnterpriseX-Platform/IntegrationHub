package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// errUseFallback lets a native executor hand a node back to the Node server
// (e.g. a transform that uses a Node-only global like Buffer).
var errUseFallback = errors.New("use node executor")

// Fallback runs node types Go has no native executor for on the Node server,
// with the original TypeScript executors. Node keeps the real context objects
// (Sets, Buffers, Dates survive there), so only changed variables travel.
type Fallback struct {
	url, token, runID string
	client            *http.Client
}

func newFallback(url, token, runID string) *Fallback {
	return &Fallback{url: url, token: token, runID: runID, client: &http.Client{Timeout: 0}}
}

type fallbackRequest struct {
	RunID         string                `json:"runId"`
	CtxID         string                `json:"ctxId"`
	ParentCtxID   string                `json:"parentCtxId,omitempty"`
	Node          *Node                 `json:"node"`
	Input         jsVal                 `json:"input"`
	VarUpdates    map[string]jsVal      `json:"varUpdates"`
	ResultUpdates map[string]NodeResult `json:"resultUpdates"`
}

type fallbackResponse struct {
	Result     NodeResult     `json:"result"`
	VarChanges map[string]any `json:"varChanges"`
	Logs       []LogEntry     `json:"logs"`
	Error      string         `json:"error"`
}

func (f *Fallback) execute(node *Node, ctx *Ctx) (NodeResult, error) {
	if f.url == "" {
		return NodeResult{}, fmt.Errorf("No executor registered for node type: %s", node.Type)
	}
	updates := map[string]jsVal{}
	for k := range ctx.dirty {
		updates[k] = jsVal{fbTagDates(ctx.Vars[k])}
	}
	sent := ctx.run.results.takeUnsent()
	for id, r := range sent {
		r.Output = fbTagDates(r.Output)
		sent[id] = r
	}
	req := fallbackRequest{
		RunID: f.runID, CtxID: ctx.ID, ParentCtxID: ctx.Parent, Node: node, Input: jsVal{fbTagDates(ctx.Input)},
		VarUpdates: updates, ResultUpdates: sent,
	}
	body, err := json.Marshal(req)
	if err != nil {
		return NodeResult{}, fmt.Errorf("engine: cannot send node %s to the Node server: %w", node.ID, err)
	}
	hr, _ := http.NewRequest(http.MethodPost, f.url, bytes.NewReader(body))
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("X-Engine-Token", f.token)
	started := time.Now()
	resp, err := f.client.Do(hr)
	if err != nil {
		return NodeResult{}, fmt.Errorf("engine: Node server unreachable for node %s: %w", node.ID, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out fallbackResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return NodeResult{}, fmt.Errorf("engine: bad reply from the Node server (HTTP %d) for node %s", resp.StatusCode, node.ID)
	}
	// Values again with their JavaScript key order.
	if ordered, err := jsDecode(raw); err == nil {
		om := asMap(ordered)
		if vc, ok := om["varChanges"].(map[string]any); ok {
			out.VarChanges = vc
		}
		if res, ok := om["result"].(map[string]any); ok {
			out.Result.Output = res["output"]
		}
	}
	for k, v := range out.VarChanges {
		out.VarChanges[k] = fbUntagDates(v)
	}
	out.Result.Output = fbUntagDates(out.Result.Output)
	for i := range out.Logs {
		out.Logs[i].Data = fbUntagDates(out.Logs[i].Data)
	}
	// Node now knows this context and all pending changes.
	ctx.Parent = ""
	ctx.dirty = map[string]bool{}
	for k, v := range out.VarChanges {
		ctx.Vars[k] = v
	}
	ctx.run.logsMu.Lock()
	ctx.run.logs = append(ctx.run.logs, out.Logs...)
	ctx.run.logsMu.Unlock()

	res := out.Result
	if res.NodeID == "" {
		res = NodeResult{NodeID: node.ID, NodeType: node.Type, StartedAt: started, EndedAt: time.Now()}
	}
	if out.Error != "" || !res.Success {
		msg := out.Error
		if msg == "" {
			msg = res.Error
		}
		res.Success = false
		res.Error = msg
		return res, errors.New(msg)
	}
	return res, nil
}

// connection fetches a stored connection (config, type, status, name) from
// the Node server, so connection settings are read from one place.
func (f *Fallback) connection(id string) (map[string]any, error) {
	if f.url == "" {
		return nil, fmt.Errorf("Connection not found: %s", id)
	}
	u := strings.TrimSuffix(f.url, "/node") + "/connection/" + url.PathEscape(id)
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("X-Engine-Token", f.token)
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("engine: Node server unreachable: %w", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("engine: bad connection reply for %s", id)
	}
	if e, _ := out["error"].(string); e != "" {
		return nil, errors.New(e)
	}
	return out, nil
}

// Dates cross the fallback as {"$ixDate": ISO} so the Node side gets Date
// objects back (plain JSON would turn them into strings), and the reply's
// dates become time.Time again.
const fbDateKey = "$ixDate"

func fbTagDates(v any) any {
	switch t := v.(type) {
	case time.Time:
		return om(fbDateKey, jsISO(t))
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = fbTagDates(x)
		}
		copyOrder(out, t)
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = fbTagDates(x)
		}
		return out
	}
	return v
}

func fbUntagDates(v any) any {
	switch t := v.(type) {
	case map[string]any:
		if s, ok := t[fbDateKey].(string); ok && len(t) == 1 {
			if d, err := time.Parse(time.RFC3339Nano, s); err == nil {
				return d.UTC()
			}
		}
		for k, x := range t {
			t[k] = fbUntagDates(x)
		}
	case []any:
		for i, x := range t {
			t[i] = fbUntagDates(x)
		}
	}
	return v
}
