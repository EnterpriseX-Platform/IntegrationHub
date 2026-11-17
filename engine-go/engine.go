package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Run holds one flow execution. The traversal is a line-by-line port of
// server/src/sdk/execution/ExecutionEngine.ts so both engines take the same
// path through a flow.
type Run struct {
	req       *ExecuteRequest
	flow      *Flow
	adjacency map[string][]string
	results   *Results
	logsMu    sync.Mutex
	logs      []LogEntry
	ctxSeq    int64
	emit      func(event map[string]any)
	fallback  *Fallback
}

func newRun(req *ExecuteRequest, emit func(map[string]any)) *Run {
	r := &Run{req: req, flow: &req.Flow, adjacency: map[string][]string{}, results: newResults(), emit: emit}
	for _, e := range req.Flow.Edges {
		r.adjacency[e.Source] = append(r.adjacency[e.Source], e.Target)
	}
	r.fallback = newFallback(req.CallbackURL, req.CallbackToken, req.RunID)
	return r
}

func (r *Run) newCtxID() string {
	return "c" + strconv.FormatInt(atomic.AddInt64(&r.ctxSeq, 1), 10)
}

func (r *Run) log(level, nodeID, msg string, data any) {
	r.logsMu.Lock()
	r.logs = append(r.logs, LogEntry{Timestamp: time.Now(), Level: level, NodeID: nodeID, Message: msg, Data: data})
	r.logsMu.Unlock()
}

// nodeLog is the engine's 'node:log' event (progress lines in the run log).
func (r *Run) nodeLog(nodeID, msg string) {
	r.emit(om("event", "node:log", "nodeId", nodeID, "message", msg))
}

func (r *Run) checkDeadline() error {
	if d := r.req.DeadlineAt; d > 0 && time.Now().UnixMilli() > d {
		return fmt.Errorf("Execution timeout: exceeded the maximum run time (deadline %s)",
			time.UnixMilli(d).UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	return nil
}

// Execute runs the flow and returns the final result plus the root context.
func (r *Run) Execute() (ExecutionResult, *Ctx) {
	started := time.Now()
	root := &Ctx{ID: "root", Input: r.req.Input, Vars: r.req.Variables, dirty: map[string]bool{}, run: r}
	if root.Vars == nil {
		root.Vars = map[string]any{}
	}
	var res ExecutionResult
	res.Metadata.OperationID = r.flow.OperationID
	res.Metadata.StartedAt = started

	status, body, err := r.executeFlow(root)
	ended := time.Now()
	res.Metadata.EndedAt = ended
	res.Metadata.DurationMs = ended.Sub(started).Milliseconds()
	res.Metadata.NodeResults = r.results.list()
	if err != nil {
		res.Success = false
		res.StatusCode = 500
		res.Error = err.Error()
	} else {
		res.Success = true
		res.StatusCode = status
		res.Data = body
	}
	return res, root
}

func (r *Run) executeFlow(ctx *Ctx) (int, any, error) {
	flow := r.flow
	incoming := map[string]bool{}
	for _, e := range flow.Edges {
		incoming[e.Target] = true
	}
	current := ""
	for _, n := range flow.Nodes {
		if n.Type == "api-input" {
			current = n.ID
			break
		}
	}
	if current == "" {
		for _, n := range flow.Nodes {
			if !incoming[n.ID] {
				current = n.ID
				break
			}
		}
	}
	if current == "" {
		return 0, nil, errors.New("No start node found in flow")
	}

	var final any
	visited := map[string]bool{}
	for current != "" && !visited[current] {
		if err := r.checkDeadline(); err != nil {
			return 0, nil, err
		}
		visited[current] = true
		node := flow.node(current)
		if node == nil {
			return 0, nil, fmt.Errorf("Node not found: %s", current)
		}
		result, err := r.executeNode(node, ctx)
		if err != nil {
			return 0, nil, err
		}
		final = result.Output
		ctx.Input = result.Output
		next := r.adjacency[current]

		switch node.Type {
		case "condition":
			cond := asMap(result.Output)
			isTrue := truthy(cond["result"])
			var matching []Edge
			for _, e := range flow.Edges {
				if e.Source != current {
					continue
				}
				if isTrue && (e.Label == "true" || e.Label == "yes") ||
					!isTrue && (e.Label == "false" || e.Label == "no" || e.Label == "") {
					matching = append(matching, e)
				}
			}
			switch len(matching) {
			case 0:
				current = ""
			case 1:
				current = matching[0].Target
			default:
				targets := make([]string, len(matching))
				for i, e := range matching {
					targets[i] = e.Target
				}
				r.nodeLog(node.ID, fmt.Sprintf("Condition fan-out: %d branches", len(targets)))
				join := r.findJoin(targets)
				var wg sync.WaitGroup
				ok := int64(0)
				for i, t := range targets {
					wg.Add(1)
					go func(i int, start string) {
						defer wg.Done()
						bctx := ctx.fork()
						r.nodeLog(node.ID, fmt.Sprintf("Branch %d: starting at %s", i+1, start))
						var berr error
						if join != "" {
							berr = r.chainUntil(start, bctx, join)
						} else {
							berr = r.chain(start, bctx)
						}
						if berr != nil {
							r.nodeLog(node.ID, fmt.Sprintf("Branch %d error: %s", i+1, berr.Error()))
							return
						}
						atomic.AddInt64(&ok, 1)
					}(i, t)
				}
				wg.Wait()
				r.nodeLog(node.ID, fmt.Sprintf("Condition fan-out completed: %d/%d succeeded", ok, len(targets)))
				current = join
			}

		case "for-each":
			if err := r.runForEach(node, ctx, asMap(result.Output)); err != nil {
				return 0, nil, err
			}
			current = ""
			for _, e := range flow.Edges {
				if e.Source == node.ID && e.Label != "body" {
					current = e.Target
					break
				}
			}

		case "aggregate-split":
			current = r.runAggregateSplit(node, ctx, next)

		case "api-output":
			out := asMap(result.Output)
			status := 200
			if s, ok := num(out, "statusCode"); ok {
				status = int(s)
			}
			return status, out["body"], nil

		default:
			if len(next) > 0 {
				current = next[0]
			} else {
				current = ""
			}
		}
	}
	return 200, final, nil
}

func (r *Run) runForEach(node *Node, ctx *Ctx, fe map[string]any) error {
	items, _ := fe["items"].([]any)
	workers := 1
	if w, ok := num(fe, "workers"); ok && w > 1 {
		workers = int(w)
	}
	itemVar := str(fe, "itemVar")
	indexVar := str(fe, "indexVar")
	if indexVar == "" {
		indexVar = "loopIndex"
	}
	body := ""
	for _, e := range r.flow.Edges {
		if e.Source == node.ID && e.Label == "body" {
			body = e.Target
			break
		}
	}
	msg := fmt.Sprintf("For-each: %d items to process (workers: %d)", len(items), workers)
	if d, _ := num(fe, "deferredItems"); d > 0 {
		m, _ := num(fe, "matchedItems")
		mx, _ := num(fe, "maxItems")
		msg += fmt.Sprintf(" — %s of %s deferred by maxItems=%s", jsNumber(d), jsNumber(m), jsNumber(mx))
	}
	r.nodeLog(node.ID, msg)

	if workers <= 1 {
		for i, item := range items {
			if err := r.checkDeadline(); err != nil {
				return err
			}
			ctx.set(itemVar, item)
			ctx.set(indexVar, float64(i))
			ctx.set("loopTotal", float64(len(items)))
			r.nodeLog(node.ID, fmt.Sprintf("Loop iteration %d/%d", i+1, len(items)))
			if body != "" {
				if err := r.chain(body, ctx); err != nil {
					return err
				}
			}
		}
		return nil
	}

	var results []any
	var errs []any
	var mu sync.Mutex
	for start := 0; start < len(items); start += workers {
		if err := r.checkDeadline(); err != nil {
			return err
		}
		end := start + workers
		if end > len(items) {
			end = len(items)
		}
		r.nodeLog(node.ID, fmt.Sprintf("Batch %d: items %d-%d/%d (%d workers)", start/workers+1, start+1, end, len(items), end-start))
		batch := make([]map[string]any, end-start)
		var wg sync.WaitGroup
		for bi := start; bi < end; bi++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				w := ctx.fork()
				w.set(itemVar, items[idx])
				w.set(indexVar, float64(idx))
				w.set("loopTotal", float64(len(items)))
				var err error
				if body != "" {
					err = r.chain(body, w)
				}
				if err != nil {
					mu.Lock()
					errs = append(errs, om("index", float64(idx), "error", err.Error()))
					mu.Unlock()
					r.nodeLog(node.ID, fmt.Sprintf("Worker error at item %d: %s", idx+1, err.Error()))
					batch[idx-start] = om("index", float64(idx), "success", false, "error", err.Error())
					return
				}
				last := r.lastInChain(body)
				var item any
				if last != "" {
					item = w.Vars[last]
				}
				batch[idx-start] = om("index", float64(idx), "success", true, "result", item)
			}(bi)
		}
		wg.Wait()
		for _, b := range batch {
			results = append(results, b)
		}
	}
	okCount := 0
	for _, x := range results {
		if truthy(asMap(x)["success"]) {
			okCount++
		}
	}
	if results == nil {
		results = []any{}
	}
	if errs == nil {
		errs = []any{}
	}
	ctx.set("loopResults", results)
	ctx.set("loopErrors", errs)
	ctx.set("loopTotal", float64(len(items)))
	ctx.set("loopSuccessCount", float64(okCount))
	ctx.set("loopErrorCount", float64(len(errs)))
	r.nodeLog(node.ID, fmt.Sprintf("For-each completed: %d success, %d errors", okCount, len(errs)))
	return nil
}

func (r *Run) runAggregateSplit(node *Node, ctx *Ctx, targets []string) string {
	r.nodeLog(node.ID, fmt.Sprintf("Fan-out: %d branches", len(targets)))
	join := r.findJoin(targets)
	outcomes := make([]map[string]any, len(targets))
	summary := make([]any, len(targets))
	branchCtx := make([]*Ctx, len(targets))
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func(i int, start string) {
			defer wg.Done()
			b := ctx.fork()
			branchCtx[i] = b
			r.nodeLog(node.ID, fmt.Sprintf("Branch %d: starting at %s", i+1, start))
			began := time.Now()
			if err := r.chainUntil(start, b, join); err != nil {
				r.nodeLog(node.ID, fmt.Sprintf("Branch %d error: %s", i+1, err.Error()))
				outcomes[i] = om("branchId", start, "success", false, "error", err.Error(), "duration", float64(time.Since(began).Milliseconds()))
				summary[i] = om("branch", float64(i), "success", false, "error", err.Error())
				branchCtx[i] = nil
				return
			}
			outcomes[i] = om("branchId", start, "success", true, "data", b.Input, "duration", float64(time.Since(began).Milliseconds()))
			summary[i] = om("branch", float64(i), "success", true)
		}(i, t)
	}
	wg.Wait()
	// Node outputs of the branches stay reachable as {{nodeId}} after the join.
	for _, b := range branchCtx {
		if b == nil {
			continue
		}
		for k, v := range b.Vars {
			if _, exists := ctx.Vars[k]; !exists && !hasPrefix(k, "__aggregate_") {
				ctx.set(k, v)
			}
		}
	}
	ok := 0
	res := []any{}
	for i := range outcomes {
		if outcomes[i] != nil {
			res = append(res, outcomes[i])
			if truthy(outcomes[i]["success"]) {
				ok++
			}
		}
	}
	ctx.set("__aggregate_branches_summary", summary)
	ctx.set("__aggregate_"+node.ID+"_results", res)
	if info, isMap := ctx.Vars["__aggregate_"+node.ID+"_branches"].(map[string]any); isMap {
		cp := map[string]any{}
		for k, v := range info {
			cp[k] = v
		}
		copyOrder(cp, info)
		jsSet(cp, "totalBranches", float64(len(targets)))
		ctx.set("__aggregate_"+node.ID+"_branches", cp)
	}
	r.nodeLog(node.ID, fmt.Sprintf("Fan-out completed: %d/%d succeeded", ok, len(targets)))
	return join
}

func (r *Run) nextInChain(node *Node, id string, out any) string {
	if node.Type == "condition" {
		isTrue := truthy(asMap(out)["result"])
		for _, e := range r.flow.Edges {
			if e.Source != id {
				continue
			}
			if isTrue && e.Label == "true" || !isTrue && (e.Label == "false" || e.Label == "") {
				return e.Target
			}
		}
		return ""
	}
	if n := r.adjacency[id]; len(n) > 0 {
		return n[0]
	}
	return ""
}

// chain runs a body chain (stops at another for-each, like the TS engine).
func (r *Run) chain(start string, ctx *Ctx) error {
	seen := map[string]bool{}
	for id := start; id != "" && !seen[id]; {
		seen[id] = true
		node := r.flow.node(id)
		if node == nil || node.Type == "for-each" {
			return nil
		}
		res, err := r.executeNode(node, ctx)
		if err != nil {
			return err
		}
		ctx.Input = res.Output
		id = r.nextInChain(node, id, res.Output)
	}
	return nil
}

func (r *Run) chainUntil(start string, ctx *Ctx, stop string) error {
	seen := map[string]bool{}
	for id := start; id != "" && !seen[id]; {
		if stop != "" && id == stop {
			return nil
		}
		seen[id] = true
		node := r.flow.node(id)
		if node == nil {
			return nil
		}
		res, err := r.executeNode(node, ctx)
		if err != nil {
			return err
		}
		ctx.Input = res.Output
		id = r.nextInChain(node, id, res.Output)
	}
	return nil
}

func (r *Run) lastInChain(start string) string {
	last := start
	seen := map[string]bool{}
	for id := start; id != "" && !seen[id]; {
		seen[id] = true
		node := r.flow.node(id)
		if node == nil || node.Type == "for-each" {
			break
		}
		last = id
		if n := r.adjacency[id]; len(n) > 0 {
			id = n[0]
		} else {
			id = ""
		}
	}
	return last
}

func (r *Run) findJoin(targets []string) string {
	for _, start := range targets {
		seen := map[string]bool{}
		for id := start; id != "" && !seen[id]; {
			seen[id] = true
			if n := r.flow.node(id); n != nil && n.Type == "aggregate-join" {
				return id
			}
			if n := r.adjacency[id]; len(n) > 0 {
				id = n[0]
			} else {
				id = ""
			}
		}
	}
	return ""
}

// executeNode runs one node natively when Go has an executor for it, and on
// the Node server otherwise. Either way the result is stored the same way as
// NodeExecutor.execute does in TS.
func (r *Run) executeNode(node *Node, ctx *Ctx) (NodeResult, error) {
	r.emit(om("event", "node:start", "nodeId", node.ID))
	started := time.Now()

	var (
		res    NodeResult
		err    error
		native bool
	)
	if fn, ok := nativeExecutors[node.Type]; ok {
		var out any
		out, err = fn(r, node, ctx)
		if errors.Is(err, errUseFallback) {
			res, err = r.fallback.execute(node, ctx)
		} else {
			native = true
			res = NodeResult{NodeID: node.ID, NodeType: node.Type, Success: err == nil, Output: out, StartedAt: started, EndedAt: time.Now()}
			res.DurationMs = res.EndedAt.Sub(started).Milliseconds()
			if err != nil {
				res.Error = err.Error()
				res.Output = nil
			}
		}
	} else {
		res, err = r.fallback.execute(node, ctx)
	}

	if native {
		r.results.set(res, true)
		if err == nil {
			varName := str(node.Data, "varName")
			if varName == "" {
				varName = node.ID
			}
			ctx.set(varName, res.Output)
			if varName != node.ID {
				ctx.set(node.ID, res.Output)
			}
			r.log("info", node.ID, fmt.Sprintf("Node %s (%s) completed successfully", node.ID, varName), nil)
		} else {
			r.log("error", node.ID, fmt.Sprintf("Node %s failed: %s", node.ID, res.Error), nil)
		}
	} else if res.NodeID != "" {
		r.results.set(res, false)
	}

	if err != nil {
		r.emit(om("event", "node:error", "nodeId", node.ID, "error", err.Error()))
		return res, err
	}
	r.emit(om("event", "node:complete", "nodeId", node.ID, "result", res))
	return res, nil
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }

// mustJSON is used for debug logging only.
func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
