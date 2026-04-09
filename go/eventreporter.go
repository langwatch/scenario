package scenario

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// EventReporter posts scenario events to the LangWatch API via HTTP.
type EventReporter struct {
	endpoint string
	apiKey   string
	client   *http.Client
	enabled  bool
}

// NewEventReporter creates an EventReporter. It is only enabled when both endpoint and apiKey are non-empty.
func NewEventReporter(endpoint, apiKey string) *EventReporter {
	return &EventReporter{
		endpoint: endpoint,
		apiKey:   apiKey,
		client:   &http.Client{Timeout: 10 * time.Second},
		enabled:  endpoint != "" && apiKey != "",
	}
}

// eventPayload is the JSON structure sent to the API.
type eventPayload struct {
	Type           string      `json:"type"`
	Timestamp      int64       `json:"timestamp"`
	BatchRunID     string      `json:"batchRunId,omitempty"`
	ScenarioID     string      `json:"scenarioId,omitempty"`
	ScenarioRunID  string      `json:"scenarioRunId,omitempty"`
	ScenarioSetID  string      `json:"scenarioSetId,omitempty"`
	Metadata       interface{} `json:"metadata,omitempty"`
	Messages       interface{} `json:"messages,omitempty"`
	Status         ScenarioRunStatus `json:"status,omitempty"`
	Results        interface{} `json:"results,omitempty"`
}

type runFinishedResults struct {
	Verdict       string   `json:"verdict"`
	MetCriteria   []string `json:"metCriteria"`
	UnmetCriteria []string `json:"unmetCriteria"`
	Reasoning     string   `json:"reasoning,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// postResult holds the parsed response from the API.
type postResult struct {
	SetURL string
}

// ReportEvents consumes events from the bus and posts them. Blocks until the channel is closed.
// When onSetURL is non-nil, it is called once with the first non-empty setUrl from the API.
func (r *EventReporter) ReportEvents(ch <-chan ScenarioEvent, onSetURL func(string)) {
	if !r.enabled {
		// Drain the channel even if disabled
		for range ch {
		}
		return
	}

	setURLSent := false
	for event := range ch {
		result := r.postEvent(event)
		if !setURLSent && result.SetURL != "" && onSetURL != nil {
			onSetURL(result.SetURL)
			setURLSent = true
		}
	}
}

func (r *EventReporter) postEvent(event ScenarioEvent) postResult {
	payload := r.buildPayload(event)
	if payload == nil {
		return postResult{}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return postResult{}
	}

	url := fmt.Sprintf("%s/api/scenario-events", r.endpoint)
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return postResult{}
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Auth-Token", r.apiKey)

	resp, err := r.client.Do(req)
	if err != nil {
		return postResult{}
	}
	defer resp.Body.Close()

	// Parse response for setUrl
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return postResult{}
	}

	var respData struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(respBody, &respData); err != nil {
		return postResult{}
	}

	return postResult{SetURL: respData.URL}
}

func (r *EventReporter) buildPayload(event ScenarioEvent) *eventPayload {
	ts := event.Timestamp().UnixMilli()

	switch e := event.(type) {
	case RunStartedEvent:
		metadata := map[string]any{
			"name":        e.ScenarioName,
			"description": e.Description,
		}
		for k, v := range e.Metadata {
			metadata[k] = v
		}
		return &eventPayload{
			Type:          string(EventRunStarted),
			Timestamp:     ts,
			BatchRunID:    e.BatchRunID,
			ScenarioID:    e.ScenarioID,
			ScenarioRunID: e.ScenarioRunID,
			ScenarioSetID: e.ScenarioSetID,
			Metadata:      metadata,
		}

	case MessageSnapshotEvent:
		return &eventPayload{
			Type:          string(EventMessageSnapshot),
			Timestamp:     ts,
			BatchRunID:    e.BatchRunID,
			ScenarioID:    e.ScenarioID,
			ScenarioRunID: e.ScenarioRunID,
			ScenarioSetID: e.ScenarioSetID,
			Messages:      e.Messages,
		}

	case RunFinishedEvent:
		status := ScenarioRunStatusFailed
		verdict := "failure"
		if e.Result != nil && e.Result.Success {
			status = ScenarioRunStatusSuccess
			verdict = "success"
		}
		if e.Result != nil && e.Result.Error != nil {
			status = ScenarioRunStatusError
		}

		var results *runFinishedResults
		if e.Result != nil {
			reasoning := ""
			if e.Result.Reasoning != nil {
				reasoning = *e.Result.Reasoning
			}
			errStr := ""
			if e.Result.Error != nil {
				errStr = *e.Result.Error
			}
			results = &runFinishedResults{
				Verdict:       verdict,
				MetCriteria:   e.Result.MetCriteria,
				UnmetCriteria: e.Result.UnmetCriteria,
				Reasoning:     reasoning,
				Error:         errStr,
			}
		}

		return &eventPayload{
			Type:          string(EventRunFinished),
			Timestamp:     ts,
			BatchRunID:    e.BatchRunID,
			ScenarioID:    e.ScenarioID,
			ScenarioRunID: e.ScenarioRunID,
			ScenarioSetID: e.ScenarioSetID,
			Status:        status,
			Results:       results,
		}

	default:
		return nil
	}
}
