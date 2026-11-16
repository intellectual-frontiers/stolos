/**
 * 037-smb, 039-pg-identity: one PAM hook keeps the copies of a person's Linux
 * password that other protocols need in step with Linux: Samba's NT hash (SMB
 * clients cannot prove a password any other way) and PostgreSQL's SCRAM
 * verifier (for a published instance). Run by PAM, through Ubuntu's own
 * pam-auth-update, after a password is accepted (auth: a login with a password,
 * sudo, Cockpit) or changed (passwd). Real accounts only (UID 1000 and up; not
 * root or ops); service accounts have no password.
 *
 * @module
 */
// Spec: 037-smb
// Spec: 039-pg-identity

import type { Capability } from "../model/types.ts";

const SPEC = "039-pg-identity" as const;

/** Where the password hook's files are. */
export const PASSWORDS = {
  hook: "/usr/local/libexec/archon/password-sync",
  profile: "/usr/share/pam-configs/archon-passwords",
  profileName: "archon-passwords",
} as const;

/** The PAM hook: keeps Samba's and PostgreSQL's copies of a person's password in step with Linux. */
export const PASSWORD_SYNC = `#!/bin/sh
# Rendered by archon from specs 037-smb and 039-pg-identity. Do not edit.
# Run by PAM (pam_exec expose_authtok) after a password was accepted (auth) or
# changed (password): Samba and PostgreSQL get the same password for the same
# account. Nothing is stored anywhere else.
case "\${PAM_TYPE:-}" in auth|password) ;; *) exit 0 ;; esac
u="\${PAM_USER:-}"
[ -n "$u" ] && [ "$u" != ops ] && [ "$u" != root ] || exit 0
uid=$(id -u "$u" 2>/dev/null) || exit 0
[ "$uid" -ge 1000 ] || exit 0
pw=$(tr -d '\\000')
[ -n "$pw" ] || exit 0
if [ -x /usr/bin/smbpasswd ]; then
  printf '%s\\n%s\\n' "$pw" "$pw" | /usr/bin/smbpasswd -s -a "$u" >/dev/null 2>&1
fi
# PostgreSQL, only while it is on (an opt-in service); in the background, so a login never waits.
if [ -x /usr/local/bin/archon ] && /usr/bin/systemctl is-enabled --quiet postgresql.service 2>/dev/null; then
  # PAM gives the hook almost no environment: archon gets root's.
  ( printf '%s' "$pw" | HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
      /usr/local/bin/archon pg passwd-sync "$u" >/dev/null 2>&1 & )
fi
exit 0
`;

/**
 * seteuid: PAM runs a command as the calling program's real user, which for
 * sudo and passwd is the person, not root; the hook needs root.
 */
export const PASSWORDS_PROFILE = `Name: Archon: SMB and PostgreSQL use the same password as Linux (specs 037, 039)
Default: yes
Priority: 0
Auth-Type: Additional
Auth:
	optional pam_exec.so quiet seteuid expose_authtok ${PASSWORDS.hook}
Password-Type: Additional
Password:
	optional pam_exec.so quiet seteuid expose_authtok ${PASSWORDS.hook}
`;

/** The password hook, for hosts with SMB or PostgreSQL (specs 037, 039). */
export const passwords =
  (): Capability =>
  ({ host }) => {
    if (host.kind === "workstation") return { spec: SPEC };
    const regenerate = {
      kind: "run" as const,
      argv: ["pam-auth-update", "--package", "--enable", PASSWORDS.profileName],
    };
    return {
      spec: SPEC,
      files: [
        { path: PASSWORDS.hook, content: PASSWORD_SYNC, mode: "0700", owner: "root", spec: SPEC },
        {
          // Ubuntu's own way to add to its PAM stacks (pam-auth-update), not an edit of /etc/pam.d.
          path: PASSWORDS.profile,
          content: PASSWORDS_PROFILE,
          mode: "0644",
          owner: "root",
          spec: SPEC,
          onChange: [regenerate],
        },
      ],
      notes: [
        "A person's Linux password also signs in to SMB and to published PostgreSQL instances (PAM keeps the copies in step).",
      ],
    };
  };
