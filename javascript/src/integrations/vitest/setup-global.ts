import { generate } from 'xksuid';

export default function setup() {
  const scenarioBatchRunId = `scenariobatch_${generate()}`;

  process.env.SCENARIO_BATCH_RUN_ID = scenarioBatchRunId;
}
