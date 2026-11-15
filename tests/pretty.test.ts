/**
 * Spec 004 (Article 19), spec 049: the boot server's window renders structured
 * events; it never parses text. Emoji on Windows terminals.
 *
 * @module
 */
import { width } from "@intellectual-frontiers/ifc-ts/kernel";
import { proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assertExists,
  assert,
  assertEquals,
  test,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { render, resetPretty } from "../src/archon-boot/pretty.ts";
import { describe } from "../src/archon-boot/progress.ts";
import { emojiTerminal } from "../src/archon/core/ui.ts";
import {
  type ArchonEvent,
  fromLogRecord,
  plainLine,
  toLogRecord,
  toLogsRequest,
} from "../src/archon/telemetry/events.ts";

/** The text without its escape sequences (colors). */
const strip = (s?: string): string | undefined =>
  s === undefined
    ? undefined
    : width
        .tokens(s)
        .filter((t) => t.kind === "text")
        .map((t) => t.text)
        .join("");
const t = Date.parse("2026-11-12T17:35:28Z");
const ev = (e: Omit<ArchonEvent, "time">, dt = 0): ArchonEvent => ({ ...e, time: t + dt });

proves(
  ["019-output FR-005", "049-telemetry FR-008"],
  "boot window: debug events stay recorded but out of the window; repeats shown once",
  () => {
    resetPretty();
    const probe = ev({
      name: "boot.file.probe",
      address: "10.0.30.57",
      message: "TFTP /revocations.efi: not found",
      attrs: { via: "TFTP", file: "/revocations.efi" },
    });
    assertEquals(render(probe, false), undefined);
    assert(render(probe, true), "shown when verbose");
    resetPretty();
    const shim = (dt: number) =>
      ev(
        {
          name: "boot.file",
          address: "10.0.30.57",
          message: "TFTP bootx64.efi",
          attrs: { via: "TFTP", file: "bootx64.efi" },
        },
        dt,
      );
    assert(render(shim(0), false));
    assertEquals(render(shim(500), false), undefined);
    assert(render(shim(5000), false), "again later is a new event");
  },
);

proves(
  ["019-output FR-005", "049-telemetry FR-008"],
  "boot window: the host in its own column, the address after; tone from the event",
  () => {
    resetPretty();
    const ready = strip(
      render(
        ev({
          name: "boot.ready",
          host: "alpha",
          address: "10.0.30.57",
          message: "Ready: 82/82 checks · ssh alpha",
        }),
        false,
      ),
    );
    assertExists(ready);
    assert(/alpha\s+Ready: 82\/82 checks · ssh alpha {2}10\.0\.30\.57$/.test(ready), ready);
    const warn = strip(
      render(ev({ name: "boot.firewall", message: "Windows Firewall blocks UDP 69" }, 1), false),
    );
    assertExists(warn);
    assert(/boot server\s+Windows Firewall blocks UDP 69$/.test(warn), warn);
    const tftp = strip(
      render(
        ev(
          {
            name: "boot.file",
            address: "10.0.30.57",
            message: "TFTP linux",
            attrs: { via: "TFTP", file: "linux" },
          },
          2,
        ),
        false,
      ),
    );
    assertExists(tftp);
    assert(/10\.0\.30\.57\s+TFTP linux$/.test(tftp), tftp);
    const next = strip(
      render(
        ev(
          {
            name: "boot.next",
            host: "alpha",
            message: "connect   ssh alpha   (or ssh alice@10.0.30.57)",
            attrs: { step: true },
          },
          3,
        ),
        false,
      ),
    );
    assertExists(next);
    assert(next.includes("│ connect") && next.includes("ssh alpha"), next);
  },
);

proves(
  ["049-telemetry FR-008"],
  "events: an OTLP log record is the source; the window and boot.log render it",
  () => {
    resetPretty();
    const e = ev({
      name: "boot.config",
      severity: "warn",
      host: "alpha",
      address: "10.0.30.57",
      message: "its carried certificate is too close to expiry",
      attrs: { n: 2 },
    });
    const rec = toLogRecord(e);
    assertEquals(rec["severityText"], "WARN");
    assertEquals(rec["severityNumber"], 13);
    const back = fromLogRecord(rec);
    assertExists(back);
    assertEquals(back, e);
    const fromRecord = strip(render(back, false));
    resetPretty();
    assertEquals(fromRecord, strip(render(e, false)), "the same line from the record");
    assertEquals(plainLine(e), "10.0.30.57 alpha: its carried certificate is too close to expiry");
    const req = toLogsRequest([e], { "service.name": "archon-boot" }, "archon-boot") as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    assertEquals(req.resourceLogs[0]?.scopeLogs[0]?.logRecords.length, 1);
    assertEquals(fromLogRecord({ attributes: [], body: { stringValue: "x" } }), undefined);
  },
);

test("installer: an unnamed failure subiquity recovers from is not recorded", () => {
  const seen = new Set<string>();
  assertEquals(
    describe({ event_type: "finish", result: "FAIL", name: "", description: "" }, seen),
    undefined,
  );
  assertEquals(
    describe(
      {
        event_type: "finish",
        result: "FAIL",
        name: "subiquity/Install/install",
        description: "",
      },
      seen,
    )?.message,
    "installer: subiquity/Install/install (FAIL)",
  );
});

proves(["019-output FR-004"], "emoji: Windows Terminal shows them without a UTF-8 locale", () => {
  const keep = ["ARCHON_PLAIN", "ARCHON_EMOJI", "LANG", "LC_ALL", "LC_CTYPE", "WT_SESSION"].map(
    (k) => [k, proc.env.get(k)] as const,
  );
  try {
    for (const [k] of keep) proc.env.delete(k);
    proc.env.set("ARCHON_EMOJI", "1");
    assert(emojiTerminal());
    proc.env.delete("ARCHON_EMOJI");
    proc.env.set("LANG", "C.UTF-8");
    assert(emojiTerminal());
    proc.env.set("ARCHON_PLAIN", "1");
    assert(!emojiTerminal());
  } finally {
    for (const [k, v] of keep) v === undefined ? proc.env.delete(k) : proc.env.set(k, v);
  }
});

proves(
  ["049-telemetry FR-008"],
  "boot window: this PC's commands announce events; only from this PC",
  async () => {
    resetPretty();
    const armed = ev({ name: "boot.armed", host: "alpha", message: "armed for one install" });
    assert(strip(render(armed, false))?.includes("alpha"));
    assertEquals(render(armed, false), undefined, "a repeat within 3 s is shown once");
    const { handler } = await import("../src/archon-boot/server.ts");
    const got: ArchonEvent[] = [];
    const h = handler({} as never, { port: 8080, emit: (e: ArchonEvent) => got.push(e) });
    const post = (from: string, body: unknown) =>
      h(
        new Request("http://127.0.0.1:8080/local/event", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        from,
      );
    const body = { name: "boot.armed", host: "alpha", message: "armed for one install" };
    assertEquals((await post("127.0.0.1", body)).status, 200);
    assertEquals((await post("10.0.30.57", body)).status, 403);
    assertEquals((await post("127.0.0.1", { line: "free text" })).status, 400, "not an event");
    assertEquals(got, [{ name: "boot.armed", host: "alpha", message: "armed for one install" }]);
  },
);
