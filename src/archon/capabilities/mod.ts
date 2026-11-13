// Capabilities: one module per spec. Every host carries foundation().

import type { Capability } from "../model/types.ts";
import { platform } from "./platform.ts";
import { accounts } from "./accounts.ts";
import { ssh } from "./ssh.ts";
import { firewall } from "./firewall.ts";
import { updates } from "./updates.ts";
import { tools } from "./tools.ts";
import { shell } from "./shell.ts";
import { cli } from "./cli.ts";
import { ops } from "./ops.ts";
import { state } from "./state.ts";
import { backup } from "./backup.ts";
import { guests } from "./guests.ts";
import { workstation } from "./workstation.ts";
import { observability } from "./observability.ts";
import { cockpit } from "./cockpit.ts";
import { notify } from "./notify.ts";
import { doctor } from "./doctor.ts";
import { mail } from "./mail.ts";
import { web } from "./web.ts";
import { etckeeper } from "./etckeeper.ts";
import { smb } from "./smb.ts";
import { pg } from "./pg.ts";
import { services } from "./services.ts";
import { passwords } from "./passwords.ts";
import { containers } from "./containers.ts";
import { osquery } from "./osquery.ts";
import { data } from "./data.ts";

export {
  accounts,
  backup,
  cli,
  cockpit,
  containers,
  data,
  doctor,
  etckeeper,
  firewall,
  guests,
  mail,
  notify,
  observability,
  ops,
  osquery,
  passwords,
  pg,
  platform,
  services,
  shell,
  smb,
  ssh,
  state,
  tools,
  updates,
  web,
  workstation,
};

/** What every Archon host carries; grows spec by spec. */
export function foundation(): Capability[] {
  return [
    platform(),
    accounts(),
    ssh(),
    firewall(),
    updates(),
    tools(),
    shell(),
    cli(),
    ops(),
    state(),
    backup(),
    guests(),
    observability(),
    cockpit(),
    mail(),
    notify(),
    doctor(),
    web(),
    etckeeper(),
    smb(),
    passwords(),
    services(),
    pg(),
    containers(),
    osquery(),
    data(),
  ];
}
