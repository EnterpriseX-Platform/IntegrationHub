package main

import "time"

// Flow, node and edge shapes mirror server/src/sdk/execution/types.ts.

type Node struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
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
}
