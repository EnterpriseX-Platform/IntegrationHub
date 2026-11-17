package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
)

type pxABBYY struct {
	mu       sync.Mutex
	polls    int
	scenario string
	reqs     []string
}

func (a *pxABBYY) reset(s string) {
	a.mu.Lock()
	a.polls, a.scenario, a.reqs = 0, s, nil
	a.mu.Unlock()
}

var pxBoundaryRe = regexp.MustCompile(`-{26}[0-9a-f]{24}`)

func (a *pxABBYY) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	a.reqs = append(a.reqs, pxBoundaryRe.ReplaceAllString(fmt.Sprintf("%s %s auth=%s ct=%s ua=%s accept=%s len=%s body=%q",
		r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), r.Header.Get("Content-Type"), r.Header.Get("User-Agent"),
		r.Header.Get("Accept"), r.Header.Get("Content-Length"), body), "BOUNDARY"))
	js := func(code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	p := r.URL.Path
	switch {
	case p == "/api/workflows":
		if a.scenario == "wf-fail" {
			js(500, map[string]any{"x": 1})
			return
		}
		js(200, []any{map[string]any{"Name": "WF 1"}})
	case strings.HasSuffix(p, "/input/multipart"):
		switch a.scenario {
		case "sync":
			js(200, map[string]any{"text": "สวัสดี", "confidence": 0.9, "pageCount": 3})
		case "raw":
			js(200, map[string]any{"foo": "bar"})
		case "upload-500":
			js(500, map[string]any{"Message": "license expired"})
		case "objid":
			js(200, map[string]any{"JobId": "job-77"})
		default:
			js(200, "{2E3EE669-6EAF-4025-8549-23ADB684FD9B}")
		}
	case strings.HasSuffix(p, "/result"):
		files := []any{map[string]any{"FileName": "out.txt", "FileContents": base64.StdEncoding.EncodeToString([]byte("recognised ข้อความ"))}}
		if a.scenario == "pdf" {
			files = []any{map[string]any{"FileName": "out.pdf", "FileContents": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 not really"))}}
		}
		if a.scenario == "result-500" {
			js(500, "nope")
			return
		}
		if a.scenario == "plain" {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("just text"))
			return
		}
		js(200, map[string]any{"InputFiles": []any{map[string]any{"OutputDocuments": []any{map[string]any{"Files": files}}}}})
	case strings.HasPrefix(p, "/api/jobs/"):
		a.polls++
		switch a.scenario {
		case "404":
			js(404, map[string]any{})
		case "failed":
			js(200, map[string]any{"State": "ProcessingFailed"})
		case "failed-msg":
			js(200, map[string]any{"State": "Failed", "Message": "engine crashed"})
		case "poll-500":
			js(500, "x")
		default:
			if a.polls < 2 {
				js(200, map[string]any{"State": "InProgress"})
			} else {
				js(200, map[string]any{"State": "JS_Complete", "Pages": 2, "text": "fallback text"})
			}
		}
	default:
		js(404, nil)
	}
}

var pxMsNorm = regexp.MustCompile(`\d+ms|ocr-\d+-[a-z0-9]+\.pdf`)

var pxPollsNorm = regexp.MustCompile(`\(\d+ polls\)`)

// pxNormLogs removes timing: durations, temp names, poll counts and the
// number of identical retry lines (how many polls fit in maxWaitTime).
func pxNormLogs(res pxTSResult) pxTSResult {
	var logs []map[string]any
	for _, l := range res.Logs {
		if m, ok := l["message"].(string); ok {
			l["message"] = pxMsNorm.ReplaceAllString(m, "N")
		}
		if n := len(logs); n > 0 && reflect.DeepEqual(logs[n-1], l) {
			continue
		}
		logs = append(logs, l)
	}
	res.Logs = logs
	res.Error = pxPollsNorm.ReplaceAllString(res.Error, "(N polls)")
	return res
}

func TestPxportOCRDifferential(t *testing.T) {
	mock := &pxABBYY{}
	srv := httptest.NewServer(mock)
	defer srv.Close()
	dir := t.TempDir()
	pdf := filepath.Join(dir, "risk report.pdf")
	_ = os.WriteFile(pdf, []byte("%PDF-1.4 fake pdf bytes"), 0o644)

	base := map[string]any{"url": srv.URL + "/", "pollInterval": float64(100), "maxWaitTime": float64(1500)}
	with := func(kv ...any) map[string]any {
		m := map[string]any{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	cases := []struct {
		name, scenario string
		data           map[string]any
		vars           map[string]any
	}{
		{"process-txt", "ok", with("filePath", "{{currentFile.path}}", "authType", "basic", "username", "u", "password", "{{pw}}"), map[string]any{"currentFile": map[string]any{"path": pdf}, "pw": "p@ss"}},
		{"process-currentFile", "ok", with("workflowName", "My WF", "authType", "bearer", "token", "tok"), map[string]any{"currentFile": map[string]any{"localPath": pdf}}},
		{"process-fileSource", "pdf", with("fileSource", "vars.f", "authType", "api-key", "apiKey", "k1"), map[string]any{"f": pdf}},
		{"process-sync", "sync", with("filePath", pdf), nil},
		{"process-raw", "raw", with("filePath", pdf), nil},
		{"process-objid", "objid", with("filePath", pdf), nil},
		{"upload-500", "upload-500", with("filePath", pdf), nil},
		{"wf-fail", "wf-fail", with("filePath", pdf), nil},
		{"poll-404", "404", with("filePath", pdf), nil},
		{"poll-failed", "failed", with("filePath", pdf), nil},
		{"poll-failed-msg-retries", "failed-msg", with("filePath", pdf, "maxWaitTime", float64(600)), nil},
		{"poll-500-timeout", "poll-500", with("filePath", pdf, "maxWaitTime", float64(500)), nil},
		{"result-500", "result-500", with("filePath", pdf), nil},
		{"missing-file", "ok", with("filePath", "/nonexistent/a.pdf"), nil},
		{"no-file", "ok", with(), nil},
		{"status-op", "ok", with("operation", "status", "filePath", "{abc}"), nil},
		{"result-op", "plain", with("operation", "result", "filePath", "{abc}"), nil},
		{"result-op-nojob", "plain", with("operation", "result"), nil},
		{"bad-op", "ok", with("operation", "zap"), nil},
		{"no-url", "ok", map[string]any{"filePath": pdf}, nil},
		{"custom-endpoints", "ok", with("filePath", pdf, "uploadEndpoint", "api/workflows/{workflowName}/input/multipart", "statusEndpoint", "/api/jobs/{jobId}", "serverLocation", "srv1"), nil},
	}
	for _, c := range cases {
		spec := map[string]any{
			"flow":      map[string]any{"nodes": []any{}, "edges": []any{}},
			"node":      map[string]any{"id": "ocr1", "type": "ocr", "data": c.data},
			"input":     map[string]any{},
			"variables": c.vars,
		}
		mock.reset(c.scenario)
		ts := pxNormLogs(pxRunTS(t, "OcrExecutor.ts", "OcrExecutor", spec, "DATABASE_URL", pxTestDB))
		tsReqs := mock.reqs
		mock.reset(c.scenario)
		gor := pxNormLogs(pxGoRun(t, execOCR, spec))
		goReqs := mock.reqs
		pxCompare(t, c.name, ts, gor, "processingTime")
		if !reflect.DeepEqual(pxDedupe(tsReqs), pxDedupe(goReqs)) {
			t.Fatalf("%s: requests differ\nTS: %s\nGo: %s", c.name, strings.Join(tsReqs, "\n"), strings.Join(goReqs, "\n"))
		}
	}
}

func pxDedupe(in []string) []string {
	var out []string
	for _, s := range in {
		if len(out) == 0 || out[len(out)-1] != s {
			out = append(out, s)
		}
	}
	return out
}
