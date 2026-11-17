package main

// Port of server/src/sdk/execution/executors/BasketTriggerExecutor.ts.
// Triggers on basket SESSION status (open -> published -> processing ->
// completed/archived) and publishes the trigger variables downstream nodes
// and the Node proxy (session auto-close via `triggerSessionIds`) rely on.

import (
	"errors"
	"fmt"
	"strings"
)

func init() { nativeExecutors["basket-trigger"] = execBasketTrigger }

func sbSetEmptyTriggerVars(ctx *Ctx, basketID string) {
	ctx.set("triggerFiles", []any{})
	ctx.set("triggerSessions", []any{})
	ctx.set("triggerSessionIds", []any{})
	ctx.set("basketId", basketID)
	ctx.set("fileCount", float64(0))
	ctx.set("sessionCount", float64(0))
}

func execBasketTrigger(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	basketID := str(d, "basketId")
	if !truthy(d["basketId"]) {
		return nil, errors.New("Basket ID is required for basket-trigger")
	}
	basketID = sbStrOf(d["basketId"])

	triggerOn := "published"
	if truthy(d["triggerOn"]) {
		triggerOn = sbStrOf(d["triggerOn"])
	}
	filePattern := "*"
	if truthy(d["filePattern"]) {
		filePattern = sbStrOf(d["filePattern"])
	}

	// A specific session passed from the publish auto-trigger.
	in := asMap(ctx.Input)
	var target any = asMap(in["body"])["_sessionId"]
	if !truthy(target) {
		target = asMap(in["params"])["_sessionId"]
	}
	targetID := ""
	if truthy(target) {
		targetID = sbStrOf(target)
	}

	basket, err := sbBasket(basketID)
	if err != nil {
		return nil, err
	}
	if basket == nil {
		return nil, fmt.Errorf("Basket not found: %s", basketID)
	}

	var runOn []string
	if arr, ok := d["runOnStatuses"].([]any); ok {
		for _, s := range arr {
			if truthy(s) {
				runOn = append(runOn, sbStrOf(s))
			}
		}
	}
	pickByRun := targetID == "" && len(runOn) > 0

	q := `SELECT * FROM processing_sessions WHERE "basketId"=$1`
	args := []any{basketID}
	if pickByRun {
		q += ` AND "status" = ANY($2)`
		args = append(args, runOn)
	} else {
		q += ` AND "status" = $2`
		args = append(args, triggerOn)
	}
	if targetID != "" {
		q += ` AND "id" = $3`
		args = append(args, targetID)
	}
	q += ` ORDER BY "startedAt" DESC`
	sessions, err := appQuery(q, args...)
	if err != nil {
		return nil, err
	}
	if len(sessions) == 0 && targetID == "" && !pickByRun {
		sessions, err = appQuery(`SELECT * FROM processing_sessions WHERE "basketId"=$1 AND "status" = ANY($2) ORDER BY "startedAt" DESC`,
			basketID, []string{"open", "published", "processing"})
		if err != nil {
			return nil, err
		}
	}

	now := sbNow()
	if len(sessions) == 0 {
		sbSetEmptyTriggerVars(ctx, basketID)
		msg := fmt.Sprintf("No sessions with status '%s'", triggerOn)
		if pickByRun {
			msg = "No sessions with status " + strings.Join(runOn, " / ")
		}
		return om(
			"triggerType", "basket", "basketId", basketID, "basketName", sbS(basket, "name"),
			"triggerOn", triggerOn, "pattern", filePattern, "sessionsFound", float64(0),
			"files", []any{}, "triggered", false, "message", msg,
			"triggeredAt", sbISO(now), "triggeredDate", sbISO(now)[:10],
		), nil
	}

	re, err := sbGlobLoose(filePattern, false)
	if err != nil {
		return nil, err
	}

	var allFiles []map[string]any
	for _, s := range sessions {
		files, err := appQuery(`SELECT * FROM basket_files WHERE "sessionId"=$1 AND "status" = ANY($2)`,
			sbS(s, "id"), []string{"published", "uploaded", "pending"})
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if !re.MatchString(sbS(f, "fileName")) {
				continue
			}
			js := sbJSRow(f)
			js["sessionId"] = sbS(s, "id")
			js["sessionName"] = sbS(s, "batchName")
			js["sessionStatus"] = sbS(s, "status")
			allFiles = append(allFiles, js)
		}
	}

	if len(allFiles) == 0 {
		sbSetEmptyTriggerVars(ctx, basketID)
		return om(
			"triggerType", "basket", "basketId", basketID, "basketName", sbS(basket, "name"),
			"triggerOn", triggerOn, "pattern", filePattern, "sessionsFound", float64(len(sessions)),
			"filesFound", float64(0), "files", []any{}, "triggered", false,
			"message", fmt.Sprintf("Found %d session(s) with status '%s', but no ready files matching pattern", len(sessions), triggerOn),
			"triggeredAt", sbISO(now), "triggeredDate", sbISO(now)[:10],
		), nil
	}

	// Unique session ids in first-seen order (new Set(...)).
	var sessionIDs []any
	seen := map[string]bool{}
	for _, f := range allFiles {
		id := f["sessionId"].(string)
		if !seen[id] {
			seen[id] = true
			sessionIDs = append(sessionIDs, id)
		}
	}
	if triggerOn == "published" {
		for _, id := range sessionIDs {
			if err := sbUpdate("processing_sessions", id.(string), false, sbObj{{"status", "processing"}, {"publishMode", "auto"}}); err != nil {
				return nil, err
			}
		}
	}

	filesVar := make([]any, len(allFiles))
	outFiles := make([]any, len(allFiles))
	for i, f := range allFiles {
		filesVar[i] = f
		o := map[string]any{}
		for _, k := range []string{"id", "fileName", "originalName", "size", "status", "path", "sessionId", "sessionName", "createdAt"} {
			o[k] = f[k]
		}
		outFiles[i] = o
	}
	sessVar := make([]any, len(sessions))
	for i, s := range sessions {
		sessVar[i] = sbJSRow(s)
	}
	ctx.set("triggerFiles", filesVar)
	ctx.set("triggerSessions", sessVar)
	ctx.set("triggerSessionIds", sessionIDs)
	ctx.set("basketId", basketID)
	ctx.set("fileCount", float64(len(allFiles)))
	ctx.set("sessionCount", float64(len(sessions)))

	options := d["options"]
	if !truthy(options) {
		options = map[string]any{}
	}
	return om(
		"triggerType", "basket", "basketId", basketID, "basketName", sbS(basket, "name"),
		"triggerOn", triggerOn, "pattern", filePattern, "sessionsFound", float64(len(sessions)),
		"filesFound", float64(len(allFiles)), "files", outFiles, "triggered", true,
		"triggeredAt", sbISO(now), "triggeredDate", sbISO(now)[:10], "options", options,
	), nil
}
