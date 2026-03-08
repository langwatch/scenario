import { generate, setEnvironment } from '@langwatch/ksuid';

export default function setup() {
  setEnvironment(process.env.ENVIRONMENT ?? "prod");

  const scenarioBatchRunId = generate("scenariobatch").toString();

  process.env.SCENARIO_BATCH_RUN_ID = scenarioBatchRunId;
}
