// Ubuntu boot files archon-boot serves, pinned by SHA-256 (Article 12, spec 004).
//
// How these were established (2026-11-10):
// - The ISO's hash is the one in https://releases.ubuntu.com/26.04/SHA256SUMS.
// - bootx64.efi (shim), linux, and initrd from
//   https://releases.ubuntu.com/26.04/netboot/amd64/ are byte-identical to
//   EFI/boot/bootx64.efi, casper/vmlinuz, and casper/initrd inside that ISO.
// - grubx64.efi is Ubuntu's network GRUB (it differs from the ISO's local
//   GRUB); Ubuntu publishes no separate checksum, so it is pinned here, and
//   Secure Boot also checks Canonical's signature on it at every boot.
// A new point release is adopted by updating this file in a reviewed commit.

export const UBUNTU = {
  release: "26.04",
  point: "26.04.1",
  netboot: "https://releases.ubuntu.com/26.04/netboot/amd64/",
  iso: {
    name: "ubuntu-26.04.1-live-server-amd64.iso",
    url: "https://releases.ubuntu.com/26.04/ubuntu-26.04.1-live-server-amd64.iso",
    sha256: "cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927",
  },
  files: {
    "bootx64.efi": "4c89145e958cf592a6f16552eadf112ef2c1c525e2435c2761e6a99fa88188b3",
    "grubx64.efi": "f1dcfde2af47e7d7c2c46ca95f4529d22692383fe826e56058652437fd2a8b9d",
    "linux": "0ad39b13e289e1a5cf806d14541ac8f221eefe849017f5915e0846917ed67785",
    "initrd": "7aeb757e12400830fc59e962c603a43439d662fb9309ab36cb2537f41a1b8335",
  } as Record<string, string>,
} as const;
