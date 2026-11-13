# Research: Deno's built-in OpenTelemetry (spike, 2026-11-13)

Deno 2.9.6, `OTEL_DENO=true`, OTLP `http/json` to a local sink, with `@opentelemetry/api` 1.9.0
(`npm:` specifier) for our own signals.

| Question                 | Finding                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is it on without a flag? | Yes: `OTEL_DENO=true` alone (no `--unstable-otel`). Minimum Deno for the engine: 2.9.                                                                                                                                                                                                 |
| Our spans                | `trace.getTracer().startSpan()` with attributes is exported (`/v1/traces`).                                                                                                                                                                                                           |
| Automatic spans          | `fetch` gets a client span (method, URL, status) as a **child of the active span**: context propagates inside the process.                                                                                                                                                            |
| Logs                     | Each `console.log`/`warn`/`error` is a log record (`/v1/logs`) with severity (INFO, WARN, ERROR) and the **active trace and span ids**. Its only attribute is `log.iostream`: console logs cannot carry custom attributes, so a run's attributes go on its spans and on the resource. |
| Metrics                  | Counters and histograms from `metrics.getMeter()` are exported (`/v1/metrics`), with `OTEL_METRIC_EXPORT_INTERVAL`; Deno adds `v8js.gc.duration`.                                                                                                                                     |
| Resource attributes      | `OTEL_RESOURCE_ATTRIBUTES` is honored (`service.namespace`, `vcs.ref.head.revision`, ...) next to `service.name` and the runtime's own.                                                                                                                                               |

## Decisions for 049-telemetry

- Per-run facts that every signal should carry (fleet, host, engine version, applied commit,
  approver) are **resource attributes**, set by the launcher through `OTEL_RESOURCE_ATTRIBUTES`;
  per-step facts are span attributes.
- Logs stay `console` output (Article 19's calm lines), linked to their span by trace id; no
  separate log API.
- Across processes (SSH, MCP, the install), the trace context is passed explicitly as a W3C
  `traceparent` (an environment variable or MCP `_meta`), since only in-process context is
  automatic.
