package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	Input         any                   `json:"input"`
	VarUpdates    map[string]any        `json:"varUpdates"`
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
	updates := map[string]any{}
	for k := range ctx.dirty {
		updates[k] = ctx.Vars[k]
	}
	req := fallbackRequest{
		RunID: f.runID, CtxID: ctx.ID, ParentCtxID: ctx.Parent, Node: node, Input: ctx.Input,
		VarUpdates: updates, ResultUpdates: ctx.run.results.takeUnsent(),
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
