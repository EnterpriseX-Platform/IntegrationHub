package main

import (
	"bytes"
	"encoding/json"
	"time"
)

// Flow, node and edge shapes mirror server/src/sdk/execution/types.ts.

type Node struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Data map[string]any `json:"data"`

	rawData json.RawMessage // original JSON of data, for key order
}

func (n *Node) UnmarshalJSON(b []byte) error {
	var aux struct {
		ID   string          `json:"id"`
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	n.ID, n.Type, n.rawData = aux.ID, aux.Type, aux.Data
	n.Data = nil
	if len(aux.Data) > 0 && string(aux.Data) != "null" {
		v, err := jsDecode(aux.Data)
		if err != nil {
			return err
		}
		n.Data, _ = v.(map[string]any)
	}
	return nil
}

// MarshalJSON sends the node with its data exactly as received.
func (n Node) MarshalJSON() ([]byte, error) {
	data := []byte(n.rawData)
	if len(data) == 0 {
		data = jsEncode(n.Data)
	}
	var buf bytes.Buffer
	buf.WriteString(`{"id":`)
	writeScalar(&buf, n.ID)
	buf.WriteString(`,"type":`)
	writeScalar(&buf, n.Type)
	buf.WriteString(`,"data":`)
	buf.Write(data)
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// keyOrder returns the keys of the object at data.<field> in their original
// order (Go maps do not keep it; JavaScript objects do).
func (n *Node) keyOrder(field string) []string {
	var m map[string]json.RawMessage
	if json.Unmarshal(n.rawData, &m) != nil {
		return nil
	}
	return objectKeys(m[field])
}

// field returns the raw JSON of data.<name>.
func (n *Node) field(name string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(n.rawData, &m) != nil {
		return nil
	}
	return m[name]
}

func objectKeys(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	var keys []string
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return keys
		}
		keys = append(keys, t.(string))
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}

type Edge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Label  string `json:"label,omitempty"`
}

type Flow struct {
	OperationID string `json:"operationId"`
	Nodes       []Node `json:"nodes"`
	Edges       []Edge `json:"edges"`
}

func (f *Flow) node(id string) *Node {
	for i := range f.Nodes {
		if f.Nodes[i].ID == id {
			return &f.Nodes[i]
		}
	}
	return nil
}

type NodeResult struct {
	NodeID     string    `json:"nodeId"`
	NodeType   string    `json:"nodeType"`
	Success    bool      `json:"success"`
	Output     any       `json:"output,omitempty"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	EndedAt    time.Time `json:"endedAt"`
	DurationMs int64     `json:"durationMs"`
}

type LogEntry struct {
	Timestamp time.Time `json:"timestamp"`
	Level     string    `json:"level"`
	NodeID    string    `json:"nodeId,omitempty"`
	Message   string    `json:"message"`
	Data      any       `json:"data,omitempty"`
}

type ExecutionResult struct {
	Success    bool   `json:"success"`
	StatusCode int    `json:"statusCode"`
	Data       any    `json:"data,omitempty"`
	Error      string `json:"error,omitempty"`
	Metadata   struct {
		OperationID string       `json:"operationId"`
		StartedAt   time.Time    `json:"startedAt"`
		EndedAt     time.Time    `json:"endedAt"`
		DurationMs  int64        `json:"durationMs"`
		NodeResults []NodeResult `json:"nodeResults"`
	} `json:"metadata"`
}

// ExecuteRequest is what the Node server posts to /execute.
type ExecuteRequest struct {
	RunID         string         `json:"runId"`
	Flow          Flow           `json:"flow"`
	Input         any            `json:"input"`
	Variables     map[string]any `json:"variables"`
	DeadlineAt    int64          `json:"deadlineAt"` // epoch ms, 0 = none
	CallbackURL   string         `json:"callbackUrl"`
	CallbackToken string         `json:"callbackToken"`
	ApiSpec       any            `json:"apiSpec,omitempty"` // OpenAPI spec for api-output (context.apiSpec)
}
