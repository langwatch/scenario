import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * Creates a mock ReadableSpan for testing.
 */
export function createSpan(params: {
  spanId: string;
  name: string;
  startTime: [number, number];
  endTime: [number, number];
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{
    name: string;
    attributes?: Record<string, unknown>;
    time?: [number, number];
  }>;
  status?: { code: number; message?: string };
}): ReadableSpan {
  return {
    name: params.name,
    spanContext: () => ({ spanId: params.spanId, traceId: "trace-1" }),
    parentSpanContext: params.parentSpanId
      ? { spanId: params.parentSpanId }
      : undefined,
    startTime: params.startTime,
    endTime: params.endTime,
    attributes: params.attributes ?? {},
    events: (params.events ?? []).map((e) => ({
      ...e,
      time: e.time ?? params.startTime,
    })),
    status: params.status ?? { code: 0 },
  } as unknown as ReadableSpan;
}
