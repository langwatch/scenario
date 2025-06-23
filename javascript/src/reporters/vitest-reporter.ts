import { Subscription } from 'rxjs';
import type { TestCase,  Reporter } from 'vitest/node';
import { EventBus } from '../events/event-bus';
import type { ScenarioEvent, ScenarioRunStartedEvent, ScenarioRunFinishedEvent, ScenarioMessageSnapshotEvent } from '../events/schema';

// Map from test file+name to collected events
const scenarioEventsMap = new Map<string, ScenarioEvent[]>();
const busSubscriptions = new Map<EventBus, Subscription>();

function getTestKey(test: TestCase) {
  return test.fullName;
}

export default class VitestReporter implements Reporter {
  async onTestCaseReady(test: TestCase) {
    const key = getTestKey(test);
    scenarioEventsMap.set(key, []);
    for (const bus of Array.from(EventBus.getAllBuses())) {
      if (!busSubscriptions.has(bus)) {
        const sub = bus.eventsObservable.subscribe((event: ScenarioEvent) => {
          for (const events of Array.from(scenarioEventsMap.values())) {
            events.push(event);
          }
        });
        busSubscriptions.set(bus, sub);
      }
    }
  }

  async onTestCaseResult(test: TestCase) {
    const key = getTestKey(test);
    const events = scenarioEventsMap.get(key) ?? [];
    if (!events.length) return;

    // Group events by scenarioRunId
    const runs = new Map<string, ScenarioEvent[]>();
    for (const event of events) {
      // TODO: Upstream types for ScenarioEvent do not guarantee scenarioRunId
      const runId = (event as { scenarioRunId?: string }).scenarioRunId ?? 'unknown';
      if (!runs.has(runId)) runs.set(runId, []);
      runs.get(runId)!.push(event);
    }

    for (const [runId, runEvents] of Array.from(runs.entries())) {
      const started = runEvents.find(e => e.type === 'SCENARIO_RUN_STARTED') as ScenarioRunStartedEvent | undefined;
      const finished = runEvents.find(e => e.type === 'SCENARIO_RUN_FINISHED') as ScenarioRunFinishedEvent | undefined;
      const messages = runEvents.filter(e => e.type === 'SCENARIO_MESSAGE_SNAPSHOT') as ScenarioMessageSnapshotEvent[];

      // Use console.log for output
      console.log(`\n--- Scenario Run: ${started?.metadata?.name ?? runId} ---`);
      if (started) {
        console.log(`Description: ${started.metadata?.description ?? ''}`);
      }
      if (messages.length) {
        console.log('Chat log:');
        for (const msg of messages) {
          // TODO: Upstream types for ScenarioMessageSnapshotEvent do not guarantee messages
          for (const m of (msg as { messages?: { role: string; content: string }[] }).messages ?? []) {
            console.log(`  [${m.role}] ${m.content}`);
          }
        }
      }
      if (finished) {
        console.log('--- Verdict ---');
        console.log(`Status: ${finished.status}`);
        if (finished.results) {
          console.log(`Verdict: ${finished.results.verdict}`);
          if (finished.results.reasoning) console.log(`Reasoning: ${finished.results.reasoning}`);
          if (finished.results.metCriteria?.length) console.log(`Met criteria: ${finished.results.metCriteria.join(', ')}`);
          if (finished.results.unmetCriteria?.length) console.log(`Unmet criteria: ${finished.results.unmetCriteria.join(', ')}`);
          if (finished.results.error) console.log(`Error: ${finished.results.error}`);
        }
      }
      console.log('-----------------------------\n');
    }
  }

  async onTestRunEnd() {
    // Clean up subscriptions
    for (const sub of Array.from(busSubscriptions.values())) {
      sub.unsubscribe();
    }
    busSubscriptions.clear();
    scenarioEventsMap.clear();
  }
};
