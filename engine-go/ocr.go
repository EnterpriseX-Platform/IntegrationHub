package main

// Port of server/src/sdk/execution/executors/OcrExecutor.ts (ABBYY FineReader
// Server 14 REST: workflows → multipart upload → poll job → result). The
// requests, polling, result handling and their quirks are kept as in TS.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func init() { nativeExecutors["ocr"] = execOCR }

// pxAxiosError is an axios error: message plus the response when there was one.
type pxAxiosError struct {
	msg    string
	status int // 0 = no response
	data   any
}

func (e *pxAxiosError) Error() string { return e.msg }

type pxAxiosResp struct {
	status  int
	headers map[string]string
	data    any    // parsed like axios responseType 'json'
	raw     []byte // responseType 'arraybuffer'
}

// pxAxios performs one request the way axios 1.x does for the OCR executor.
func pxAxios(method, u string, headers map[string]string, body []byte, timeout time.Duration, arraybuffer bool) (*pxAxiosResp, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, u, rd)
	if err != nil {
		return nil, &pxAxiosError{msg: axiosNetErr(err, httpReq{url: u, timeout: timeout}).Error()}
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("User-Agent", axiosUA)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	client := &http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	res, err := client.Do(req)
	if err != nil {
		return nil, &pxAxiosError{msg: axiosNetErr(err, httpReq{url: u, timeout: timeout}).Error()}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, &pxAxiosError{msg: axiosNetErr(err, httpReq{url: u, timeout: timeout}).Error()}
	}
	out := &pxAxiosResp{status: res.StatusCode, headers: map[string]string{}, raw: raw}
	for k, v := range res.Header {
		out.headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	if parsed, err := jsDecode(raw); len(bytes.TrimSpace(raw)) > 0 && err == nil {
		out.data = parsed
	} else {
		out.data = string(raw)
	}
	if arraybuffer {
		out.data = raw
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		data := out.data
		if arraybuffer {
			data = raw
		}
		return nil, &pxAxiosError{msg: fmt.Sprintf("Request failed with status code %d", res.StatusCode), status: res.StatusCode, data: data}
	}
	return out, nil
}

func pxOr(vals ...any) any {
	for _, v := range vals {
		if truthy(v) && v != undefinedV {
			return v
		}
	}
	return vals[len(vals)-1]
}

func execOCR(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	op := str(d, "operation")
	if op == "" {
		op = "process"
	}
	base, err := pxOCRBaseURL(r, d, ctx)
	if err != nil {
		return nil, err
	}
	if base == "" {
		return nil, errors.New("OCR service URL is required. Provide connectionId or url.")
	}
	auth := pxOCRAuth(d, ctx)
	r.log("info", node.ID, fmt.Sprintf("OCR %s: %s", op, base), nil)
	var out any
	switch op {
	case "process":
		out, err = pxOCRProcess(r, node, d, ctx, base, auth)
	case "status":
		out, err = pxOCRStatus(d, ctx, base, auth)
	case "result":
		out, err = pxOCRResult(d, ctx, base, auth)
	default:
		return nil, fmt.Errorf("Unknown OCR operation: %s", op)
	}
	if err != nil {
		return nil, err
	}
	return pxClean(out), nil
}

func pxTrimSlash(s string) string { return strings.TrimSuffix(s, "/") }

func pxOCRBaseURL(r *Run, d map[string]any, ctx *Ctx) (string, error) {
	if u := str(d, "url"); u != "" {
		return pxTrimSlash(jsString(ctx.resolveTemplate(u))), nil
	}
	if id := str(d, "connectionId"); id != "" {
		conn, err := r.fallback.connection(id)
		if err != nil {
			return "", err
		}
		cfg := conn["config"]
		if s, ok := cfg.(string); ok {
			var m any
			if json.Unmarshal([]byte(s), &m) == nil {
				cfg = m
			}
		}
		v := pxOr(prop(cfg, "baseUrl"), prop(cfg, "url"), prop(cfg, "host"), "")
		s, ok := v.(string)
		if !ok {
			return "", errors.New("(config.baseUrl || config.url || config.host || \"\").replace is not a function")
		}
		return pxTrimSlash(s), nil
	}
	return "", nil
}

func pxTpl(ctx *Ctx, s string) string {
	v := ctx.resolveTemplate(s)
	if v == nil {
		return "undefined"
	}
	return jsString(v)
}

func pxOCRAuth(d map[string]any, ctx *Ctx) map[string]string {
	h := map[string]string{}
	switch strOr(d, "authType", "none") {
	case "basic":
		h["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(pxTpl(ctx, str(d, "username"))+":"+pxTpl(ctx, str(d, "password"))))
	case "bearer":
		h["Authorization"] = "Bearer " + pxTpl(ctx, str(d, "token"))
	case "api-key":
		h[strOr(d, "apiKeyHeader", "X-API-Key")] = pxTpl(ctx, str(d, "apiKey"))
	}
	return h
}

func pxJoinURL(base, ep string) string {
	if !strings.HasPrefix(ep, "/") {
		ep = "/" + ep
	}
	return pxTrimSlash(base) + ep
}

func pxOCRFilePath(d map[string]any, ctx *Ctx) any {
	if fp := str(d, "filePath"); fp != "" {
		return ctx.resolveTemplate(fp)
	}
	pick := func(v any) any {
		if s, ok := v.(string); ok {
			return s
		}
		for _, k := range []string{"path", "localPath", "filePath"} {
			if p := prop(v, k); truthy(p) {
				return p
			}
		}
		return nil
	}
	if fs := str(d, "fileSource"); fs != "" {
		v, ok := ctx.standardValue(fs)
		if ok {
			if p := pick(v); p != nil && (truthy(p) || pxIsStr(p)) {
				return p
			}
		}
	}
	if cf, ok := ctx.Vars["currentFile"]; ok && truthy(cf) {
		if p := pick(cf); p != nil {
			return p
		}
	}
	return nil
}

func pxIsStr(v any) bool { _, ok := v.(string); return ok }

var pxGUIDRe = regexp.MustCompile(`^[{]?[0-9a-fA-F-]{36}[}]?$`)

func pxOCRProcess(r *Run, node *Node, d map[string]any, ctx *Ctx, base string, auth map[string]string) (any, error) {
	fpV := pxOCRFilePath(d, ctx)
	if !truthy(fpV) {
		return nil, errors.New("File path is required. Provide filePath or fileSource.")
	}
	filePath := jsString(fpV)
	st, err := os.Stat(filePath)
	if err != nil {
		return nil, fmt.Errorf("File not found: %s", filePath)
	}
	fileName := filepath.Base(filePath)
	loc := strOr(d, "serverLocation", "localhost")
	r.log("info", node.ID, fmt.Sprintf("OCR processing file: %s (%s KB)", fileName, pxToFixed(float64(st.Size())/1024, 1)), nil)

	var workflow any
	if w, ok := d["workflowName"]; ok && truthy(w) {
		workflow = w
	}
	if workflow == nil {
		wfURL := pxJoinURL(base, "/api/workflows?serverLocation="+loc)
		r.log("debug", node.ID, "Fetching workflows from: "+wfURL, nil)
		resp, err := pxAxios("GET", wfURL, auth, nil, 15*time.Second, false)
		if err != nil {
			r.log("warn", node.ID, fmt.Sprintf("Could not fetch workflows: %s. Using default.", err.Error()), nil)
		} else {
			wfs := resp.data
			if arr, ok := wfs.([]any); ok && len(arr) > 0 {
				workflow = pxOr(prop(arr[0], "name"), prop(arr[0], "Name"), arr[0])
				r.log("info", node.ID, fmt.Sprintf("Using workflow: %s (auto-detected from %d available)", pxJSString(workflow), len(arr)), nil)
			} else if wfs == nil {
				r.log("warn", node.ID, "Could not fetch workflows: Cannot read properties of null (reading 'workflows'). Using default.", nil)
			} else if pxJSTypeof(wfs) == "object" && truthy(prop(wfs, "workflows")) {
				if list, ok := prop(wfs, "workflows").([]any); ok && len(list) > 0 {
					workflow = pxOr(prop(list[0], "name"), prop(list[0], "Name"), list[0])
					r.log("info", node.ID, "Using workflow: "+pxJSString(workflow), nil)
				}
			}
		}
	}
	if !truthy(workflow) {
		workflow = "Default"
		r.log("info", node.ID, "No workflow found, using default: Default", nil)
	}
	wfName := pxJSString(workflow)
	ep := "/api/workflows/" + pxEncodeURIComponent(wfName) + "/input/multipart"
	if ue := str(d, "uploadEndpoint"); ue != "" {
		ep = strings.Replace(ue, "{workflowName}", pxEncodeURIComponent(wfName), 1)
	}
	uploadURL := pxJoinURL(base, ep) + "?serverLocation=" + loc
	logData := om("fileName", fileName, "workflowName", wfName)
	if l, ok := d["language"]; ok {
		jsSet(logData, "language", l)
	}
	r.log("info", node.ID, "Uploading to: "+uploadURL, logData)

	if !pxExists(filePath) {
		return nil, fmt.Errorf("OCR upload failed: OCR input file no longer exists on disk: %s (status: unknown)", filePath)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("OCR upload failed: %s (status: unknown)", pxFsErr(err, "open", filePath).Error())
	}
	boundary := pxFormBoundary()
	var body bytes.Buffer
	body.WriteString("--" + boundary + "\r\n")
	body.WriteString(`Content-Disposition: form-data; name="file"; filename="` + fileName + "\"\r\n")
	body.WriteString("Content-Type: application/pdf\r\n\r\n")
	body.Write(content)
	body.WriteString("\r\n--" + boundary + "--\r\n")
	hdr := map[string]string{}
	for k, v := range auth {
		hdr[k] = v
	}
	hdr["content-type"] = "multipart/form-data; boundary=" + boundary
	resp, err := pxAxios("POST", uploadURL, hdr, body.Bytes(), 120*time.Second, false)
	if err != nil {
		var ae *pxAxiosError
		msg, status := err.Error(), "unknown"
		if errors.As(err, &ae) && ae.status != 0 {
			status = strconv.Itoa(ae.status)
			if m := pxOr(prop(ae.data, "message"), prop(ae.data, "Message"), prop(ae.data, "error"), undefinedV); truthy(m) {
				msg = pxJSString(m)
			}
		}
		return nil, fmt.Errorf("OCR upload failed: %s (status: %s)", msg, status)
	}

	up := resp.data
	if s, ok := up.(string); ok {
		r.log("info", node.ID, "Upload response", map[string]any{"data": s})
	} else {
		js := string(jsonStringify(up, nil))
		if len([]rune(js)) > 200 { // substring counts UTF-16 units; equal for BMP text
			js = string([]rune(js)[:200])
		}
		r.log("info", node.ID, "Upload response", map[string]any{"data": js})
	}

	var jobID any
	if s, ok := up.(string); ok {
		cleaned := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(s, `"`), `"`))
		if pxGUIDRe.MatchString(cleaned) {
			jobID = cleaned
		}
	}
	if jobID == nil && pxJSTypeof(up) == "object" {
		if up == nil {
			return nil, errors.New("Cannot read properties of null (reading 'text')")
		}
		if t := pxOr(prop(up, "text"), prop(up, "result"), prop(up, "content")); truthy(t) {
			text, isS := t.(string)
			n := 0
			if isS {
				n = pxUTF16Len(text)
			} else {
				text = string(jsonStringify(t, nil))
			}
			r.log("info", node.ID, fmt.Sprintf("OCR completed (sync): %d chars extracted", n), nil)
			return om(
				"success", true, "text", text, "confidence", prop(up, "confidence"),
				"pages", pxOr(prop(up, "pages"), prop(up, "pageCount")), "fileName", fileName,
				"processingTime", float64(0), "mode", "sync", "rawResponse", up,
			), nil
		}
		if j := pxOr(prop(up, "id"), prop(up, "jobId"), prop(up, "taskId"), prop(up, "Id"), prop(up, "JobId"), prop(up, "requestId")); truthy(j) {
			jobID = j
		}
	}
	if jobID == nil {
		r.log("warn", node.ID, "No jobId or text in OCR response, returning raw", nil)
		return om("success", true, "text", string(jsonStringify(up, nil)), "fileName", fileName, "mode", "raw", "rawResponse", up), nil
	}
	r.log("info", node.ID, fmt.Sprintf("OCR job created: %s, polling for completion...", pxJSString(jobID)), nil)
	return pxOCRPoll(r, node, d, base, auth, pxJSString(jobID), fileName, loc)
}

// pxFormBoundary matches form-data 4: 26 dashes + 12 random bytes in hex.
func pxFormBoundary() string {
	return "--------------------------" + pxRandHex(12)
}

func pxNumOr(d map[string]any, k string, def float64) float64 {
	if v, ok := d[k].(float64); ok && v != 0 {
		return v
	}
	if v, ok := d[k]; ok && truthy(v) {
		if n, ok := pxNumber(v).(float64); ok {
			return n
		}
	}
	return def
}

var (
	pxDoneStates = map[string]bool{"js_complete": true, "js_completed": true, "completed": true, "done": true, "finished": true, "success": true, "js_exported": true}
	pxFailStates = map[string]bool{"processingfailed": true, "failed": true, "error": true, "cancelled": true, "timeout": true, "js_processingfailed": true}
)

func pxOCRPoll(r *Run, node *Node, d map[string]any, base string, auth map[string]string, jobID, fileName, loc string) (any, error) {
	pollInterval := pxNumOr(d, "pollInterval", 5000)
	maxWait := pxNumOr(d, "maxWaitTime", 300000)
	start := time.Now()
	enc := pxEncodeURIComponent(jobID)
	statusURL := pxJoinURL(base, strings.Replace(strOr(d, "statusEndpoint", "/api/jobs/{jobId}"), "{jobId}", enc, 1)) + "?serverLocation=" + loc
	elapsed := func() float64 { return float64(time.Since(start).Milliseconds()) }

	lastStatus := ""
	polls := 0
	next := pollInterval
	if next > 250 {
		next = 250
	}
	for elapsed() < maxWait {
		polls++
		resp, err := pxAxios("GET", statusURL, auth, nil, 15*time.Second, false)
		var pollErr error
		if err != nil {
			pollErr = err
		} else {
			sd := resp.data
			status := pxJSString(pxOr(prop(sd, "State"), prop(sd, "state"), prop(sd, "status"), prop(sd, "Status"), ""))
			lower := strings.ToLower(status)
			if status != lastStatus {
				r.log("info", node.ID, fmt.Sprintf("OCR job %s: %s (poll #%d)", jobID, status, polls), nil)
				lastStatus = status
			}
			if pxDoneStates[lower] {
				resultURL := pxJoinURL(base, strings.Replace(strOr(d, "resultEndpoint", "/api/jobs/{jobId}/result"), "{jobId}", enc, 1)) + "?serverLocation=" + loc
				var text any = ""
				rr, rerr := pxAxios("GET", resultURL, auth, nil, 30*time.Second, true)
				if rerr == nil {
					text = pxOCRExtract(r, node, rr.raw)
				} else {
					r.log("warn", node.ID, fmt.Sprintf("Could not fetch result file: %s. Using status data.", rerr.Error()), nil)
					text = pxOr(prop(sd, "text"), prop(sd, "result"), prop(sd, "content"), "")
				}
				pt := elapsed()
				lenStr := "undefined"
				switch t := text.(type) {
				case string:
					lenStr = strconv.Itoa(pxUTF16Len(t))
				case []any:
					lenStr = strconv.Itoa(len(t))
				}
				r.log("info", node.ID, fmt.Sprintf("OCR completed: %s chars in %sms", lenStr, jsNumber(pt)), nil)
				ts, ok := text.(string)
				if !ok {
					ts = string(jsonStringify(text, nil))
				}
				return om(
					"success", true, "text", ts,
					"confidence", pxOr(prop(sd, "confidence"), prop(sd, "Confidence")),
					"pages", pxOr(prop(sd, "pages"), prop(sd, "Pages"), prop(sd, "pageCount"), prop(sd, "PageCount")),
					"jobId", jobID, "fileName", fileName, "processingTime", pt, "mode", "async", "rawResponse", sd,
				), nil
			}
			if pxFailStates[lower] {
				m := pxOr(prop(sd, "error"), prop(sd, "Error"), prop(sd, "message"), prop(sd, "Message"), undefinedV)
				msg := "OCR processing failed with status: " + status
				if truthy(m) {
					msg = pxJSString(m)
				}
				pollErr = errors.New(msg)
			}
		}
		if pollErr != nil {
			var ae *pxAxiosError
			if errors.As(pollErr, &ae) && ae.status == 404 {
				return nil, fmt.Errorf("OCR job not found: %s", jobID)
			}
			if strings.Contains(pollErr.Error(), "OCR processing failed") || strings.Contains(pollErr.Error(), "OCR job not found") {
				return nil, pollErr
			}
			r.log("warn", node.ID, fmt.Sprintf("Poll error (will retry): %s", pollErr.Error()), nil)
		}
		remaining := maxWait - elapsed()
		if remaining <= 0 {
			break
		}
		wait := next
		if remaining < wait {
			wait = remaining
		}
		time.Sleep(time.Duration(wait * float64(time.Millisecond)))
		next = next * 2
		if next > pollInterval {
			next = pollInterval
		}
	}
	return nil, fmt.Errorf("OCR processing timed out after %ss (%d polls)", jsNumber(maxWait/1000), polls)
}

func pxUTF16Len(s string) int {
	n := 0
	for _, c := range s {
		if c >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func pxOCRJobURL(d map[string]any, ctx *Ctx, base, key, def, what string) (string, string, error) {
	jobID := ""
	if fp := str(d, "filePath"); fp != "" {
		v := ctx.resolveTemplate(fp)
		if truthy(v) {
			jobID = jsString(v)
		}
	}
	if jobID == "" {
		return "", "", fmt.Errorf("Job ID required for %s (provide in filePath)", what)
	}
	loc := strOr(d, "serverLocation", "localhost")
	ep := strings.Replace(strOr(d, key, def), "{jobId}", pxEncodeURIComponent(jobID), 1)
	return pxJoinURL(base, ep) + "?serverLocation=" + loc, jobID, nil
}

func pxOCRStatus(d map[string]any, ctx *Ctx, base string, auth map[string]string) (any, error) {
	u, _, err := pxOCRJobURL(d, ctx, base, "statusEndpoint", "/api/jobs/{jobId}", "status check")
	if err != nil {
		return nil, err
	}
	resp, err := pxAxios("GET", u, auth, nil, 15*time.Second, false)
	if err != nil {
		return nil, err
	}
	return resp.data, nil
}

func pxOCRResult(d map[string]any, ctx *Ctx, base string, auth map[string]string) (any, error) {
	u, jobID, err := pxOCRJobURL(d, ctx, base, "resultEndpoint", "/api/jobs/{jobId}/result", "result retrieval")
	if err != nil {
		return nil, err
	}
	resp, err := pxAxios("GET", u, auth, nil, 30*time.Second, true)
	if err != nil {
		return nil, err
	}
	ct := resp.headers["content-type"]
	return om(
		"success", true, "text", strings.ToValidUTF8(string(resp.raw), "�"), "jobId", jobID,
		"rawResponse", om("contentType", ct, "size", float64(len(resp.raw))),
	), nil
}

type pxOutFile struct {
	name string
	data []byte
}

var (
	pxTextExt = regexp.MustCompile(`(?i)\.(txt|text|xml|csv|htm|html)$`)
	pxPDFExt  = regexp.MustCompile(`(?i)\.pdf$`)
)

func pxOCRExtract(r *Run, node *Node, body []byte) string {
	asString := strings.ToValidUTF8(string(body), "�")
	var env any
	if err := json.Unmarshal([]byte(asString), &env); err != nil {
		return asString
	}
	if !truthy(env) || pxJSTypeof(env) != "object" {
		return asString
	}
	var found []pxOutFile
	takeDocs := func(docs any) {
		arr, _ := docs.([]any)
		for _, doc := range arr {
			files, _ := prop(doc, "Files").([]any)
			for _, f := range files {
				c, ok := prop(f, "FileContents").(string)
				if !ok || c == "" {
					continue
				}
				name := ""
				if n := prop(f, "FileName"); truthy(n) {
					name = pxJSString(n)
				}
				found = append(found, pxOutFile{name, pxNodeBase64(c)})
			}
		}
	}
	if inputs, ok := prop(env, "InputFiles").([]any); ok {
		for _, in := range inputs {
			takeDocs(prop(in, "OutputDocuments"))
		}
	}
	takeDocs(prop(env, "OutputDocuments"))
	if len(found) == 0 {
		r.log("warn", node.ID, "OCR result envelope contained no output files; using the raw response.", nil)
		return asString
	}
	for _, f := range found {
		if pxTextExt.MatchString(f.name) {
			r.log("info", node.ID, fmt.Sprintf(`OCR result: reading text export "%s"`, f.name), nil)
			return strings.ToValidUTF8(string(f.data), "�")
		}
	}
	pdf := found[0]
	for _, f := range found {
		if pxPDFExt.MatchString(f.name) {
			pdf = f
			break
		}
	}
	r.log("info", node.ID, fmt.Sprintf(`OCR result: extracting text layer from "%s" (%d bytes)`, pdf.name, len(pdf.data)), nil)
	return pxPDFToText(r, node, pdf.data)
}

func pxRand36() string {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 52))
	return strconv.FormatInt(n.Int64(), 36)
}

func pxPDFToText(r *Run, node *Node, pdf []byte) string {
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("ocr-%d-%s.pdf", time.Now().UnixMilli(), pxRand36()))
	_ = os.WriteFile(tmp, pdf, 0o644)
	defer os.Remove(tmp)
	cmd := exec.Command("pdftotext", "-layout", "-enc", "UTF-8", tmp, "-")
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		msg := err.Error()
		if errors.Is(err, exec.ErrNotFound) {
			msg = "spawn pdftotext ENOENT"
		} else if _, ok := err.(*exec.ExitError); ok {
			msg = fmt.Sprintf("Command failed: pdftotext -layout -enc UTF-8 %s -\n%s", tmp, stderr.String())
		}
		r.log("warn", node.ID, fmt.Sprintf("pdftotext failed (%s); no text extracted from the PDF output.", msg), nil)
		return ""
	}
	if out.Len() > 64*1024*1024 {
		r.log("warn", node.ID, "pdftotext failed (stdout maxBuffer length exceeded); no text extracted from the PDF output.", nil)
		return ""
	}
	return strings.ToValidUTF8(out.String(), "�")
}
