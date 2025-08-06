import { generate } from 'xksuid';

export default function setup() {
  const scenarioBatchRunId = `batch_${generate()}`;

  process.env.SCENARIO_BATCH_RUN_ID = scenarioBatchRunId;
}
