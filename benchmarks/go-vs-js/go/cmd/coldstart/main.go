// Command coldstart sets up the SDK, runs the trivial scenario once and
// exits, printing its peak RSS. The driver (js/coldstart-driver.mjs) times
// the whole process from the outside, so the Go runtime start, package
// initialization and the first run are all inside the measurement.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/langwatch/scenario/benchmarks/go-vs-js/fake"
	"github.com/langwatch/scenario/benchmarks/go-vs-js/stats"
)

func main() {
	if err := fake.Setup(); err != nil {
		fmt.Fprintln(os.Stderr, "setup:", err)
		os.Exit(1)
	}
	if err := fake.RunTrivial(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "run:", err)
		os.Exit(1)
	}
	fmt.Printf("{\"maxrss_bytes\":%d}\n", stats.MaxRSSBytes())
}
