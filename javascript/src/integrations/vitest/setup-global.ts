import type { TestProject } from 'vitest/node'
import { generate } from 'xksuid';

export default function setup(project: TestProject) {
  const scenarioBatchRunId = `scenariobatchrun_${generate()}`;

  // Inject the scenario batch run id into the environment
  project.provide('scenarioBatchRunId', scenarioBatchRunId);
  project.provide('reportingEnabled', true);
}

declare module 'vitest' {
  export interface ProvidedContext {
    scenarioBatchRunId: string;
    reportingEnabled: boolean;
  }
}
