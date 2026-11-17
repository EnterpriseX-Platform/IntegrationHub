# engine-go

Flow execution engine in Go. It replaces the Node `ExecutionEngine` without
changing behaviour: same traversal, same `{{...}}` templates, same results.

## How it works

```
Node server ──POST /execute (flow, input, variables)──▶ engine-go
            ◀──────── NDJSON events: node:start / node:log / node:error / done ──
engine-go  ──POST /internal/engine/node (one node)────▶ Node server
            ◀──────── node result + changed variables ──
```

- engine-go walks the flow graph: start node, condition routing, for-each
  (sequential and parallel workers), condition fan-out, aggregate split/join,
  deadlines, `varName` handling.
- Every node type has a native Go executor: api-input, api-output,
  condition (incl. `executions.exists()` / `checkDuplicate`), transform
  (JavaScript through goja), delay, for-each, aggregate-split/join,
  http-request, database (PostgreSQL through pgx, Oracle through go-ora),
  file-read, file-write, sftp-action, basket-action, basket-trigger,
  file-encrypt, file-decrypt, email-action, ocr.
- What is still not identical to the TypeScript executors is listed in
  [DIFFERENCES.md](DIFFERENCES.md). A few cases (e.g. a transform that uses
  `Buffer`) are handed to the Node server, which runs the original executor
  through a loopback callback; the Node side keeps the real context objects.
- JavaScript key order is kept (order.go, jsbridge.go): row columns, CSV and
  xlsx headers, JSON from APIs and files, and objects returned from JS.

A native executor registers itself in `nativeExecutors` from an `init()` in
its own file.

## Running

```bash
cd engine-go && go build -o engine . && ./engine        # listens on 127.0.0.1:8140
ENGINE=go npm run server:dev                             # Node server uses it
```

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `ENGINE` | server | `node` | `go` sends flows to engine-go |
| `ENGINE_GO_URL` | server | `http://127.0.0.1:8140` | engine-go address |
| `ENGINE_CALLBACK_URL` | server | `http://127.0.0.1:$PORT/internal/engine/node` | address engine-go calls back on (set it when they run in separate containers) |
| `ENGINE_CALLBACK_TOKEN` | server | random per process | shared secret for the callback; set the same value when running more than one server replica |
| `ENGINE_GO_ADDR` | engine-go | `127.0.0.1:8140` | listen address |
| `DATABASE_URL` | engine-go | — | the application database (baskets, sessions, executions); same value as the server |
| `APP_NAME`, `BASKETS_DIR`, `ORACLE_CALL_TIMEOUT_MS` | engine-go | as on the server | give engine-go the same values as the server; set `BASKETS_DIR` absolute |
| `FLOW_FOREACH_MAX_ITEMS` | engine-go | `0` | same as on the Node engine |

If engine-go is not reachable, the server runs the flow on the Node engine
and logs a warning, so turning `ENGINE=go` on never stops flows from running.

## Known differences

See [DIFFERENCES.md](DIFFERENCES.md). Also: with two aggregate-split nodes
feeding one join, the join picks the split by sorted id.
