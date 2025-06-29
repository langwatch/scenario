package scenario

import (
	"context"

	"github.com/langwatch/scenario/go/internal/libraries/ksuid"
)

func generateThreadID(ctx context.Context) string {
	return ksuid.Generate(ctx, "thread").String()
}
