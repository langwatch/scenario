//go:build integration

package bedrock_test

import (
	"context"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/langwatch/scenario/go/internal/livetest"
	scenariobedrock "github.com/langwatch/scenario/go/providers/bedrock"
)

// TestLiveBedrock runs the shared provider suite against the real Bedrock
// Converse API. Needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
// (AWS_SESSION_TOKEN optional) with Bedrock model access; AWS_REGION
// defaults to us-east-1 and SCENARIO_LIVE_BEDROCK_MODEL overrides the model.
func TestLiveBedrock(t *testing.T) {
	livetest.Require(t, "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
	creds := aws.Credentials{
		AccessKeyID:     os.Getenv("AWS_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
		SessionToken:    os.Getenv("AWS_SESSION_TOKEN"),
		Source:          "environment",
	}
	client := bedrockruntime.New(bedrockruntime.Options{
		Region: livetest.Env("AWS_REGION", livetest.Env("AWS_DEFAULT_REGION", "us-east-1")),
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return creds, nil
		}),
	})
	livetest.RunProviderSuite(t, livetest.Provider{
		Name:  "bedrock",
		LLM:   scenariobedrock.NewProvider(client),
		Model: livetest.Env("SCENARIO_LIVE_BEDROCK_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0"),
	})
}
