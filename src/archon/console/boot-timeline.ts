/**
 * Spec 066: the boot server's installs as a timeline, from boot.log (each
 * line `<ISO time> [address] [host:] message`, spec 049): for each machine,
 * the furthest of the eleven steps of docs/install-timeline.md it reached,
 * and whether one failed.
 *
 * @module
 */

import { type Html, html } from "./html.ts";

/** The eleven steps of an install, and the boot.log lines that show each was reached. */
export const INSTALL_STEPS: Array<{ label: string; seen: RegExp }> = [
  { label: "Network boot", seen: /DHCP|PXE/i },
  { label: "Boot files", seen: /TFTP (bootx64|grubx64|shim)/i },
  { label: "Recognized", seen: /claimed by|armed, starting/i },
  { label: "Kernel", seen: /TFTP (linux|initrd)|kernel and initrd/i },
  { label: "Ubuntu image", seen: /installer image/i },
  { label: "Install config", seen: /install config sent/i },
  { label: "Installing", seen: /installer: /i },
  { label: "Installed", seen: /install finished/i },
  { label: "First boot", seen: /first boot/i },
  { label: "Configuring", seen: /(✓|\[ok\]) \w|verify/i },
  { label: "Ready", seen: /\bReady\b/ },
];

/** One machine's install, as the log shows it. */
export interface InstallProgress {
  /** The host. */
  host: string;
  /** The furthest step reached (1 to 11). */
  step: number;
  /** A step failed. */
  failed: boolean;
  /** The last line, and when. */
  last: string;
  /** When (ISO). */
  at: string;
}

const LINE =
  /^(\d{4}-\d\d-\d\dT\S+)\s+(?:(\d{1,3}(?:\.\d{1,3}){3})\s+)?(?:([a-z][a-z0-9-]*):\s+)?(.*)$/;

/** Every machine's progress, newest install last. */
export function parseBootLog(text: string): InstallProgress[] {
  const byHost = new Map<string, InstallProgress>();
  const hostAt = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, at, address, named, message] = m;
    const host = named ?? (address ? hostAt.get(address) : undefined);
    if (named && address) hostAt.set(address, named);
    if (!host) continue;
    let p = byHost.get(host);
    // Armed again after Ready (or a failure): a new install.
    if (p && /armed, starting|claimed by/i.test(message) && (p.step >= 11 || p.failed)) {
      p = undefined;
    }
    p ??= { host, step: 1, failed: false, last: "", at };
    INSTALL_STEPS.forEach((s, i) => {
      if (i + 1 > p!.step && s.seen.test(message) && !(i + 1 === 10 && p!.step < 9)) {
        p!.step = i + 1;
      }
    });
    if (/✗|\[FAIL\]|Done with problems|failed/i.test(message)) p.failed = true;
    p.last = message;
    p.at = at;
    byHost.set(host, p);
  }
  return [...byHost.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Each machine's install as a row of steps. */
export function installCards(ps: InstallProgress[]): Html {
  return html`<div class="stack" id="boothosts">${
    ps.length
      ? ps.map((p) =>
        html`
          <div class="card">
            <div class="row spread"><h2>${p.host}</h2>${p.step >= 11
              ? html`<span class="pill ok">Ready</span>`
              : p.failed
              ? html`<span class="pill bad">stopped at: ${INSTALL_STEPS[p.step - 1].label}</span>`
              : html`<span class="pill warn">${INSTALL_STEPS[p.step - 1].label} ...</span>`}</div>
            <ol class="steps" aria-label="${p.host}'s install steps">${INSTALL_STEPS.map((s, i) =>
              html`<li class="${
                i + 1 < p.step || p.step >= 11
                  ? "ok"
                  : i + 1 === p.step
                  ? (p.failed ? "bad" : "now")
                  : ""
              }" title="${s.label}">${s.label}</li>`
            )}</ol>
            <div class="sub mono">${p.at.slice(11, 19)} ${p.last}</div>
          </div>
        `
      )
      : html`
        <div class="card">
          <p
            class="sub">No install yet. Arm one (Actions, Servers: host add), start the boot server (<span class="mono">deno task stolos boot serve</span>, in a terminal), and power the machine on: its steps appear here as they happen.</p>
        </div>
      `
  }</div>`;
}
