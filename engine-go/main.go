// Command engine runs IntegrationX flows. The Node server posts a flow to
// /execute and reads the progress events back as NDJSON; node types this
// engine does not implement natively are run on the Node server through the
// callback URL given in the request.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"
)

func main() {
	addr := os.Getenv("ENGINE_GO_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8140"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","engine":"go"}`))
	})
	mux.HandleFunc("/execute", handleExecute)
	log.Printf("engine listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	// Decode straight into the struct: numbers become float64 like in
	// JavaScript, and Node.rawData keeps each node's original key order.
	var req ExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	flusher, _ := w.(http.Flusher)
	var mu sync.Mutex
	enc := json.NewEncoder(w)
	emit := func(ev map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		if err := enc.Encode(ev); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}

	run := newRun(&req, emit)
	result, root := run.Execute()

	// Variables the Node side has not seen yet (set natively in Go).
	changed := map[string]any{}
	for k := range root.dirty {
		changed[k] = root.Vars[k]
	}
	run.logsMu.Lock()
	logs := run.logs
	run.logsMu.Unlock()
	emit(map[string]any{"event": "done", "result": result, "varChanges": changed, "logs": logs})
}
