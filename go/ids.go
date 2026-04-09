package scenario

import (
	"context"
	"os"
	"sync"

	"github.com/langwatch/scenario/go/internal/libraries/ksuid"
)

func generateThreadID(ctx context.Context) string {
	return ksuid.Generate(ctx, "thread").String()
}

func generateScenarioRunID(ctx context.Context) string {
	return ksuid.Generate(ctx, "scenariorun").String()
}

func generateScenarioID(ctx context.Context) string {
	return ksuid.Generate(ctx, "scenario").String()
}

func generateBatchRunID(ctx context.Context) string {
	return ksuid.Generate(ctx, "scenariobatch").String()
}

// cachedBatchRunID caches the batch run ID per process so all scenarios share one.
var (
	cachedBatchRunID     string
	cachedBatchRunIDOnce sync.Once
)

func getBatchRunID(ctx context.Context) string {
	cachedBatchRunIDOnce.Do(func() {
		if v := os.Getenv("SCENARIO_BATCH_RUN_ID"); v != "" {
			cachedBatchRunID = v
		} else {
			cachedBatchRunID = generateBatchRunID(ctx)
		}
	})
	return cachedBatchRunID
}

// getCachedBatchRunID returns the cached batch run ID without generating a new one.
// Returns empty string if getBatchRunID has not been called yet.
func getCachedBatchRunID() string {
	return cachedBatchRunID
}
