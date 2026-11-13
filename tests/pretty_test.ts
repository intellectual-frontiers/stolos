// Spec 004 (Article 19): the boot server's window, and emoji on Windows terminals.
import { assert, assertEquals } from "./assert.ts";
import { pretty, resetPretty } from "../src/archon-boot/pretty.ts";
import { describe } from "../src/archon-boot/progress.ts";
import { emojiTerminal } from "../src/archon/core/ui.ts";

// deno-lint-ignore no-control-regex
const strip = (s?: string) => s?.replace(/\x1b\[[0-9;]*m/g, "");

Deno.test("boot window: GRUB's harmless probing stays in boot.log, repeats are shown once", () => {
  resetPretty();
  const t = Date.parse("2026-11-12T17:35:28Z");
  assertEquals(pretty("10.0.30.57 TFTP /revocations.efi: not found", t, false), undefined);
  assertEquals(
    pretty("10.0.30.57 TFTP /grub/x86_64-efi/fs.lst: not found", t, false),
    undefined,
  );
  assert(pretty("10.0.30.57 TFTP /revocations.efi: not found", t, true), "shown when verbose");
  resetPretty();
  assert(pretty("10.0.30.57 TFTP bootx64.efi", t, false));
  assertEquals(pretty("10.0.30.57 TFTP bootx64.efi", t + 500, false), undefined);
  assert(pretty("10.0.30.57 TFTP bootx64.efi", t + 5000, false), "again later is a new event");
});

Deno.test("boot window: the host in its own column, the address after, no doubled marks", () => {
  resetPretty();
  const t = Date.parse("2026-11-12T17:35:28Z");
  const ready = strip(
    pretty("10.0.30.57 alpha: ✓ Ready: 82/82 checks · ssh alpha", t, false),
  )!;
  assert(/alpha\s+Ready: 82\/82 checks · ssh alpha {2}10\.0\.30\.57$/.test(ready), ready);
  assert(!ready.includes("✓ Ready"), "the ✓ is the icon, not repeated");
  const warn = strip(pretty("warning: Windows Firewall blocks UDP 69", t + 1, false))!;
  assert(/boot server\s+Windows Firewall blocks UDP 69$/.test(warn), warn);
  const tftp = strip(pretty("10.0.30.57 TFTP linux", t + 2, false))!;
  assert(/10\.0\.30\.57\s+TFTP linux$/.test(tftp), tftp);
  const next = strip(
    pretty("  connect   ssh alpha   (or ssh alice@10.0.30.57)", t + 3, false),
  )!;
  assert(next.includes("│ connect") && next.includes("ssh alpha"), next);
});

Deno.test("installer: an unnamed failure subiquity recovers from is not a red line", () => {
  const seen = new Set<string>();
  assertEquals(
    describe({ event_type: "finish", result: "FAIL", name: "", description: "" }, seen),
    undefined,
  );
  assertEquals(
    describe({
      event_type: "finish",
      result: "FAIL",
      name: "subiquity/Install/install",
      description: "",
    }, seen),
    "✗ installer: subiquity/Install/install (FAIL)",
  );
});

Deno.test("emoji: Windows Terminal shows them without a UTF-8 locale", () => {
  const keep = ["ARCHON_PLAIN", "ARCHON_EMOJI", "LANG", "LC_ALL", "LC_CTYPE", "WT_SESSION"].map((
    k,
  ) => [k, Deno.env.get(k)] as const);
  try {
    for (const [k] of keep) Deno.env.delete(k);
    Deno.env.set("ARCHON_EMOJI", "1");
    assert(emojiTerminal());
    Deno.env.delete("ARCHON_EMOJI");
    Deno.env.set("LANG", "C.UTF-8");
    assert(emojiTerminal());
    Deno.env.set("ARCHON_PLAIN", "1");
    assert(!emojiTerminal());
  } finally {
    for (const [k, v] of keep) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
});

Deno.test("boot window: arming and a reinstall's reboot are announced", async () => {
  resetPretty();
  const t = Date.parse("2026-11-12T17:35:28Z");
  assert(strip(pretty("alpha: armed for one install", t, false))!.includes("alpha"));
  assert(
    pretty("alpha: armed for one install", t, false) === undefined,
    "a repeat within 3 s is shown once",
  );
  assert(
    strip(
      pretty(
        "alpha: rebooting from the network (boot reinstall); its install starts when it network-boots",
        t + 5000,
        false,
      ),
    )!.includes("rebooting"),
  );
  // The boot server accepts these only from this PC.
  const { handler } = await import("../src/archon-boot/server.ts");
  const lines: string[] = [];
  const h = handler({} as never, { port: 8080, log: (l: string) => lines.push(l) } as never);
  const post = (from: string) =>
    h(
      new Request("http://127.0.0.1:8080/local/event", {
        method: "POST",
        body: JSON.stringify({ line: "alpha: armed for one install" }),
      }),
      from,
    );
  assertEquals((await post("127.0.0.1")).status, 200);
  assertEquals((await post("10.0.30.57")).status, 403);
  assertEquals(lines, ["alpha: armed for one install"]);
});
