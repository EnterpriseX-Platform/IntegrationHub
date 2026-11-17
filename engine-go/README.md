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
- Node types with a native Go executor run in Go: `api-input`, `delay`,
  `transform` (JavaScript through goja), `condition`, `for-each`,
  `aggregate-split`, `aggregate-join`.
- Every other node type (database, http-request, file-read/write,
  sftp-action, basket-*, email, ocr, encrypt/decrypt, api-output, …) is run
  on the Node server with its original TypeScript executor. The Node server
  keeps the real context objects, so values JSON cannot carry (Set, Map,
  Buffer, Date) are not lost; only changed variables travel.
- A transform whose code uses a Node-only global (`Buffer`, `require`,
  `process`, …) and a condition using `executions.exists()` /
  `checkDuplicate` are handed to Node as well.

Moving another node type to Go means adding it to `nativeExecutors` in
`executors.go`; nothing else changes.

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
| `FLOW_FOREACH_MAX_ITEMS` | engine-go | `0` | same as on the Node engine |

If engine-go is not reachable, the server runs the flow on the Node engine
and logs a warning, so turning `ENGINE=go` on never stops flows from running.

## Known differences

- JavaScript syntax errors in a condition are worded by goja, not V8
  (`SyntaxError: Unexpected identifier at 1:6` instead of
  `Unexpected identifier 'is'`). Both fail the node the same way.
- With two aggregate-split nodes feeding one join, the join picks the split
  by sorted id instead of insertion order.
