package main

// Port of server/src/sdk/execution/executors/HttpRequestExecutor.ts. Request
// building and the returned shape follow axios 1.x, which the Node executor
// uses: JSON responses are parsed (raw text otherwise), status >= 400 fails
// with "Request failed with status code N", header names come back lower-case.

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const axiosUA = "axios/1.13.4"

func init() { nativeExecutors["http-request"] = execHTTPRequest }

type connHTTP struct {
	BaseURL  string            `json:"baseUrl"`
	AuthType string            `json:"authType"`
	Auth     map[string]string `json:"auth"`
	Headers  map[string]string `json:"headers"`
	Timeout  float64           `json:"timeout"`
}

func execHTTPRequest(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	var conn *connHTTP
	if id := str(d, "connectionId"); id != "" {
		raw, err := r.fallback.connection(id)
		if err != nil {
			return nil, err
		}
		conn = &connHTTP{}
		b, _ := json.Marshal(raw["config"])
		_ = json.Unmarshal(b, conn)
		r.log("debug", node.ID, "Using connection: "+id, om("baseUrl", conn.BaseURL, "authType", conn.AuthType))
	}

	rawURL := str(d, "url")
	if conn != nil && conn.BaseURL != "" {
		base := strings.TrimSuffix(conn.BaseURL, "/")
		if rawURL != "" && !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
			if !strings.HasPrefix(rawURL, "/") {
				rawURL = "/" + rawURL
			}
			rawURL = base + rawURL
		} else if rawURL == "" {
			rawURL = base
		}
	}
	if rawURL == "" {
		return nil, errors.New("URL is required. Provide a URL directly or select a connection.")
	}
	u := httpTemplate(ctx, rawURL)

	method := strings.ToUpper(str(d, "method"))
	if method == "" {
		method = "GET"
	}

	if truthy(d["uploadFile"]) && str(d, "uploadFilePath") != "" {
		return httpUpload(r, node, ctx, u, conn)
	}

	headers := mergedHeaders(d, conn, ctx)
	timeout := 30000.0
	if t, ok := num(d, "timeout"); ok && t > 0 {
		timeout = t
	} else if conn != nil && conn.Timeout > 0 {
		timeout = conn.Timeout
	}
	insecure := d["insecure"] == true || d["rejectUnauthorized"] == false
	if insecure {
		r.log("warn", node.ID, "TLS certificate verification DISABLED for this request", map[string]any{"url": u})
	}

	var params map[string]any
	if q, ok := d["queryParams"].(map[string]any); ok {
		params = asMap(resolveObject(ctx, q))
	}
	var body any
	var bodyRawStr json.RawMessage
	hasBody := false
	if (method == "POST" || method == "PUT" || method == "PATCH") && truthy(d["body"]) {
		hasBody = true
		if s, ok := d["body"].(string); ok {
			resolved := httpTemplate(ctx, s)
			var parsed any
			if err := json.Unmarshal([]byte(resolved), &parsed); err == nil {
				body = parsed
				bodyRawStr = json.RawMessage(resolved)
			} else {
				body = resolved
			}
		} else {
			body = resolveObject(ctx, d["body"])
		}
	}

	req := httpReq{method: method, url: u, headers: headers, params: params, paramOrder: node.keyOrder("queryParams"), body: body, bodyRaw: firstRaw(bodyRawStr, node.field("body")), hasBody: hasBody,
		timeout: time.Duration(timeout) * time.Millisecond, insecure: insecure, stream: truthy(d["downloadFile"])}
	logData := om("url", u, "method", strings.ToLower(method), "headers", headers, "queryParams", params, "body", body, "timeout", timeout)
	r.log("debug", node.ID, fmt.Sprintf("HTTP Request: %s %s", method, u), logData)

	if truthy(d["paginate"]) && !truthy(d["downloadFile"]) {
		return httpPaginated(r, node, req, d)
	}

	resp, err := req.do()
	if err != nil {
		return nil, err
	}
	defer resp.raw.Body.Close()
	if req.stream {
		r.log("debug", node.ID, fmt.Sprintf("HTTP Response: %d %s", resp.status, resp.statusText), om("status", float64(resp.status), "statusText", resp.statusText, "headers", resp.headers, "data", "<stream>"))
		return httpDownload(r, node, ctx, resp, u)
	}
	r.log("debug", node.ID, fmt.Sprintf("HTTP Response: %d %s", resp.status, resp.statusText), om("status", float64(resp.status), "statusText", resp.statusText, "headers", resp.headers, "data", resp.data))
	return om(
		"status", float64(resp.status), "statusText", resp.statusText, "headers", resp.headers,
		"data", resp.data, "url", u, "timestamp", isoNow(),
	), nil
}

// httpTemplate is HttpRequestExecutor.resolveTemplate: always a string.
func httpTemplate(ctx *Ctx, s string) string {
	if !strings.Contains(s, "{{") && !strings.Contains(s, "${") {
		return s
	}
	v := ctx.resolveTemplate(s)
	if v == nil {
		return ""
	}
	if str, ok := v.(string); ok {
		return str
	}
	// TS returns the raw value here; callers use it as a string.
	return jsString(v)
}

func resolveObject(ctx *Ctx, v any) any {
	switch t := v.(type) {
	case string:
		if !strings.Contains(t, "{{") && !strings.Contains(t, "${") {
			return t
		}
		return ctx.resolveTemplate(t)
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = resolveObject(ctx, x)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			out[k] = resolveObject(ctx, x)
		}
		copyOrder(out, t)
		return out
	}
	return v
}

// mergedHeaders: connection headers < connection auth < node headers.
func mergedHeaders(d map[string]any, conn *connHTTP, ctx *Ctx) map[string]any {
	h := map[string]any{}
	if conn != nil {
		for k, v := range conn.Headers {
			h[k] = v
		}
		if conn.AuthType != "" && conn.AuthType != "none" && conn.Auth != nil {
			switch conn.AuthType {
			case "basic":
				h["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(conn.Auth["username"]+":"+conn.Auth["password"]))
			case "bearer":
				if conn.Auth["token"] != "" {
					h["Authorization"] = "Bearer " + conn.Auth["token"]
				}
			case "api-key":
				name := conn.Auth["apiKeyHeader"]
				if name == "" {
					name = "X-API-Key"
				}
				if conn.Auth["apiKey"] != "" {
					h[name] = conn.Auth["apiKey"]
				}
			}
		}
	}
	if raw := d["headers"]; raw != nil {
		var node map[string]any
		switch t := raw.(type) {
		case string:
			if err := json.Unmarshal([]byte(t), &node); err != nil {
				node = map[string]any{}
			}
		case map[string]any:
			node = t
		}
		for k, v := range asMap(resolveObject(ctx, node)) {
			h[k] = v
		}
	}
	return h
}

// ── axios-compatible request ─────────────────────────────────────────────────

type httpReq struct {
	method, url string
	headers     map[string]any
	params      map[string]any
	paramOrder  []string
	body        any
	bodyRaw     json.RawMessage // flow JSON of the body, for key order
	hasBody     bool
	timeout     time.Duration
	insecure    bool
	stream      bool
	rawBody     io.Reader // multipart upload
	contentType string
}

type httpResp struct {
	status     int
	statusText string
	headers    map[string]any
	data       any
	raw        *http.Response
}

func (q httpReq) do() (*httpResp, error) {
	full := q.url
	if qs := axiosQuery(q.params, q.paramOrder); qs != "" {
		if i := strings.Index(full, "#"); i >= 0 {
			full = full[:i]
		}
		if strings.Contains(full, "?") {
			full += "&" + qs
		} else {
			full += "?" + qs
		}
	}
	var reader io.Reader
	ctype := ""
	if q.rawBody != nil {
		reader, ctype = q.rawBody, q.contentType
	} else if q.hasBody && q.body != nil {
		switch b := q.body.(type) {
		case string:
			reader, ctype = strings.NewReader(b), "application/x-www-form-urlencoded"
		default:
			reader, ctype = bytes.NewReader(jsonStringify(b, q.bodyRaw)), "application/json"
		}
	}
	req, err := http.NewRequest(q.method, full, reader)
	if err != nil {
		return nil, axiosNetErr(err, q)
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("User-Agent", axiosUA)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	for k, v := range q.headers {
		if v == nil {
			continue
		}
		req.Header.Set(k, jsString(v))
	}
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{InsecureSkipVerify: q.insecure}}
	client := &http.Client{Transport: tr, Timeout: q.timeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, axiosNetErr(err, q)
	}
	out := &httpResp{status: res.StatusCode, statusText: strings.TrimSpace(strings.TrimPrefix(res.Status, strconv.Itoa(res.StatusCode))), raw: res}
	out.headers = map[string]any{}
	keys := make([]string, 0, len(res.Header))
	for k := range res.Header {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		lk := strings.ToLower(k)
		vals := res.Header[k]
		if lk == "set-cookie" {
			arr := make([]any, len(vals))
			for i, v := range vals {
				arr[i] = v
			}
			out.headers[lk] = arr
		} else {
			out.headers[lk] = strings.Join(vals, ", ")
		}
	}
	if !q.stream || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if parsed, err := jsDecode(raw); len(bytes.TrimSpace(raw)) > 0 && err == nil {
			out.data = parsed
		} else {
			out.data = string(raw)
		}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("Request failed with status code %d", res.StatusCode)
	}
	return out, nil
}

// axiosQuery serialises params the way axios's buildURL does.
func axiosQuery(p map[string]any, order []string) string {
	if len(p) == 0 {
		return ""
	}
	// axios keeps the object's key order: use the order from the flow JSON,
	// then any keys added later (pagination) in the order they were added.
	var keys []string
	seen := map[string]bool{}
	for _, k := range order {
		if _, ok := p[k]; ok && !seen[k] {
			keys, seen[k] = append(keys, k), true
		}
	}
	var rest []string
	for k := range p {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	keys = append(keys, rest...)
	var parts []string
	for _, k := range keys {
		v := p[k]
		if v == nil {
			continue
		}
		key := k
		vals := []any{v}
		if arr, ok := v.([]any); ok {
			key = k + "[]"
			vals = arr
		}
		for _, x := range vals {
			var s string
			switch t := x.(type) {
			case map[string]any, []any:
				b, _ := json.Marshal(t)
				s = string(b)
			default:
				s = jsString(t)
			}
			parts = append(parts, axiosEncode(key)+"="+axiosEncode(s))
		}
	}
	return strings.Join(parts, "&")
}

var axiosKeep = strings.NewReplacer("%3A", ":", "%24", "$", "%2C", ",", "%20", "+")

func axiosEncode(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	// encodeURIComponent leaves !'()* alone
	for _, c := range []string{"!", "'", "(", ")", "*"} {
		e = strings.ReplaceAll(e, url.QueryEscape(c), c)
	}
	return axiosKeep.Replace(e)
}

// axiosNetErr words transport errors like Node/axios do.
func axiosNetErr(err error, q httpReq) error {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("timeout of %dms exceeded", q.timeout.Milliseconds())
	}
	u, _ := url.Parse(q.url)
	host := ""
	if u != nil {
		host = u.Hostname()
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return fmt.Errorf("getaddrinfo ENOTFOUND %s", host)
	}
	var op *net.OpError
	if errors.Is(err, syscall.ECONNREFUSED) && errors.As(err, &op) && op.Addr != nil {
		return fmt.Errorf("connect ECONNREFUSED %s", op.Addr.String())
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return errors.New("socket hang up")
	}
	return err
}

// ── download / upload / paginate ─────────────────────────────────────────────

var dispositionName = regexp.MustCompile(`filename[^;=\n]*=((['"]).*?['"]|[^;\n]*)`)

func httpDownload(r *Run, node *Node, ctx *Ctx, resp *httpResp, u string) (any, error) {
	d := node.Data
	original := ""
	if disp, _ := resp.headers["content-disposition"].(string); disp != "" {
		if m := dispositionName.FindStringSubmatch(disp); m != nil {
			original = strings.NewReplacer(`"`, "", "'", "").Replace(m[1])
		}
	}
	if original == "" {
		if pu, err := url.Parse(u); err == nil {
			parts := strings.Split(pu.Path, "/")
			original = parts[len(parts)-1]
		}
	}
	if original == "" {
		original = fmt.Sprintf("download-%d", time.Now().UnixMilli())
	}
	name := original
	if fn := str(d, "fileName"); fn != "" {
		name = strings.ReplaceAll(httpTemplate(ctx, fn), "{{original}}", original)
	}
	save := "/data/incoming"
	if sp := str(d, "savePath"); sp != "" {
		save = strings.ReplaceAll(httpTemplate(ctx, sp), "{{basket}}", "/data/incoming")
	}
	full := filepath.Join(save, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return nil, err
	}
	f, err := os.Create(full)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(f, resp.raw.Body); err != nil {
		f.Close()
		return nil, err
	}
	f.Close()
	st, _ := os.Stat(full)
	out := om("status", float64(resp.status), "url", u, "localPath", full, "fileName", name,
		"size", float64(st.Size()), "timestamp", isoNow())
	if ct, ok := resp.headers["content-type"]; ok {
		out["contentType"] = ct
	}
	return out, nil
}

func httpUpload(r *Run, node *Node, ctx *Ctx, u string, conn *connHTTP) (any, error) {
	d := node.Data
	path := httpTemplate(ctx, str(d, "uploadFilePath"))
	st, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("Upload file not found: %s", path)
	}
	field := strOr(d, "uploadFieldName", "file")
	name := filepath.Base(path)
	r.log("info", node.ID, fmt.Sprintf("Uploading file: %s (%.1f KB) to %s", name, float64(st.Size())/1024, u), nil)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile(field, name)
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("File to upload no longer exists on disk: %s", path)
	}
	_, _ = io.Copy(fw, f)
	f.Close()
	if ff, ok := d["formFields"].(map[string]any); ok {
		for k, v := range asMap(resolveObject(ctx, ff)) {
			_ = mw.WriteField(k, jsString(v))
		}
	}
	mw.Close()

	timeout := 60000.0
	if t, ok := num(d, "timeout"); ok && t > 0 {
		timeout = t
	} else if conn != nil && conn.Timeout > 0 {
		timeout = conn.Timeout
	}
	method := strings.ToUpper(strOr(d, "method", "POST"))
	var params map[string]any
	if q, ok := d["queryParams"].(map[string]any); ok {
		params = asMap(resolveObject(ctx, q))
	}
	req := httpReq{method: method, url: u, headers: mergedHeaders(d, conn, ctx), params: params, paramOrder: node.keyOrder("queryParams"),
		timeout: time.Duration(timeout) * time.Millisecond, rawBody: &buf, contentType: mw.FormDataContentType()}
	r.log("debug", node.ID, fmt.Sprintf("Upload request: %s %s", method, u), om("fileName", name, "fileSize", float64(st.Size()), "fieldName", field, "formFields", d["formFields"]))
	resp, err := req.do()
	if err != nil {
		return nil, err
	}
	r.log("debug", node.ID, fmt.Sprintf("Upload response: %d", resp.status), resp.data)
	return om("status", float64(resp.status), "statusText", resp.statusText, "headers", resp.headers,
		"data", resp.data, "url", u, "uploadedFile", name, "uploadedSize", float64(st.Size()), "timestamp", isoNow()), nil
}

func httpPaginated(r *Run, node *Node, base httpReq, d map[string]any) (any, error) {
	pageSize := 1000.0
	if v, ok := num(d, "pageSize"); ok && v > 0 {
		pageSize = v
	}
	limitParam := strOr(d, "limitParam", "limit")
	offsetParam := strOr(d, "offsetParam", "offset")
	where := str(d, "paginationIn")
	if where == "" {
		if base.method == "POST" || base.method == "PUT" || base.method == "PATCH" {
			where = "body"
		} else {
			where = "query"
		}
	}
	itemsPath, totalPath := str(d, "itemsPath"), str(d, "totalPath")
	maxPages := 1000.0
	if v, ok := num(d, "maxPages"); ok && v > 0 {
		maxPages = v
	}
	offset, pages := 0.0, 0.0
	var total *float64
	all := []any{}
	prevSig := ""
	var last *httpResp
	for pages < maxPages {
		q := base
		if where == "body" {
			b := map[string]any{}
			jsAssign(b, asMap(base.body))
			jsSet(b, limitParam, pageSize)
			jsSet(b, offsetParam, offset)
			q.body, q.hasBody = b, true
		} else {
			p := map[string]any{}
			for k, v := range base.params {
				p[k] = v
			}
			p[limitParam], p[offsetParam] = pageSize, offset
			q.params = p
			q.paramOrder = append(append([]string{}, base.paramOrder...), limitParam, offsetParam)
		}
		resp, err := q.do()
		if err != nil {
			return nil, err
		}
		resp.raw.Body.Close()
		last = resp
		itemsVal := resp.data
		if itemsPath != "" {
			itemsVal, _ = walk(resp.data, strings.Split(itemsPath, "."))
		}
		pageItems, _ := itemsVal.([]any)
		if totalPath != "" {
			if tv, ok := walk(resp.data, strings.Split(totalPath, ".")); ok {
				if f, ok := num(map[string]any{"v": tv}, "v"); ok {
					total = &f
				}
			}
		}
		sigB, _ := json.Marshal(pageItems)
		sig := string(sigB)
		if pageItems == nil {
			sig = "[]"
		}
		if pages > 0 && sig == prevSig {
			break
		}
		prevSig = sig
		all = append(all, pageItems...)
		pages++
		tot := "?"
		if total != nil {
			tot = jsNumber(*total)
		}
		r.log("debug", node.ID, fmt.Sprintf("Paginated page %s: offset=%s got=%d accumulated=%d total=%s", jsNumber(pages), jsNumber(offset), len(pageItems), len(all), tot), nil)
		if len(pageItems) == 0 || total != nil && float64(len(all)) >= *total || total == nil && float64(len(pageItems)) < pageSize {
			break
		}
		offset += pageSize
	}
	finalTotal := float64(len(all))
	if total != nil {
		finalTotal = *total
	}
	var merged any = all
	if itemsPath != "" {
		var m any = map[string]any{}
		if last != nil && last.data != nil {
			b, _ := json.Marshal(last.data)
			_ = json.Unmarshal(b, &m)
		}
		setPath(m, itemsPath, all)
		if totalPath != "" {
			setPath(m, totalPath, finalTotal)
		}
		merged = m
	}
	r.log("info", node.ID, fmt.Sprintf("Paginated fetch complete: %d items across %s page(s)", len(all), jsNumber(pages)), om("url", base.url, "pages", pages, "total", finalTotal))
	out := om("status", 200.0, "statusText", "OK", "headers", map[string]any{}, "data", merged,
		"url", base.url, "pages", pages, "total", finalTotal, "timestamp", isoNow())
	if last != nil {
		out["status"], out["statusText"], out["headers"] = float64(last.status), last.statusText, last.headers
	}
	return out, nil
}

func setPath(obj any, path string, v any) {
	m, ok := obj.(map[string]any)
	if !ok {
		return
	}
	keys := strings.Split(path, ".")
	for _, k := range keys[:len(keys)-1] {
		next, ok := m[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			m[k] = next
		}
		m = next
	}
	m[keys[len(keys)-1]] = v
}

func firstRaw(a, b json.RawMessage) json.RawMessage {
	if len(a) > 0 {
		return a
	}
	return b
}
