# Node Platform Agent

This repository contains the public machine-side component for Node Platform.
It is intended for infrastructure that you own or are authorized to manage.
The control plane creates a short-lived, one-time installation command after an
administrator adds a machine. Paste that command into the target Debian or
Ubuntu machine as a user with `sudo` access.

## What the installer does

1. Installs the supported Node.js runtime, Xray core, and operating-system
   prerequisites.
2. Creates an unprivileged `node-agent` service account.
3. Downloads `agent.js` and `traffic.js` from this repository.
4. Generates a unique local Agent CA plus TLS certificate for the machine.
5. Installs and starts the visible `node-platform-agent` systemd service.
6. Registers the Agent with the control plane using the one-time enrollment
   token. The control plane verifies the Agent over HTTPS before enrollment is
   accepted.
7. When UFW is enabled, opens the configured node TCP range and allows the
   Agent HTTPS port only from the control-plane IP when that address is an IP.

The installer verifies the SHA-256 checksum published with the selected Xray
release. It does not use `curl -k` for control-plane registration.

## Administrator workflow

1. In Node Platform, open **管理员** and add a region if needed.
2. Enter the machine name, public IP/domain, region, Agent HTTPS port, node
   port range, and capacity. The Agent address is derived automatically as
   `https://<machine-address>:<agent-port>`.
3. Copy the command displayed in the one-time installation dialog.
4. Run it on the new machine. The command expires after the configured period
   (24 hours by default) and becomes invalid immediately when a new command is
   generated.
5. Return to the machine list and use **探测** to check reachability. Only an
   enrolled, online machine is available for node creation.

The platform must be configured with a stable public `PUBLIC_URL` and the CA
certificate that signs its HTTPS endpoint. See the control-plane deployment
example for `CONTROL_PLANE_CA_PATH`.

## Requirements

- Debian or Ubuntu with `systemd`, root or sudo access, and outbound HTTPS.
- x86_64/amd64 or arm64/aarch64 CPU.
- A public IP address or DNS name that routes to the machine.
- Inbound TCP access to the Agent port from the control plane and to the
  configured node port range from authorized clients.
- Network and application use that complies with applicable law, your hosting
  provider's terms, and the policies of every service involved.

## Service management

```sh
sudo systemctl status node-platform-agent
sudo journalctl -u node-platform-agent -n 100 --no-pager
sudo systemctl restart node-platform-agent
```

Agent configuration is kept in `/etc/node-platform/agent.env` (mode `0640`)
and state/configuration data is stored below `/var/lib/node-platform-agent`.
The Agent TLS private key stays on the node machine in
`/etc/node-platform/agent-tls/agent.key`; do not copy it to the control plane.

## Update

Generate a fresh command from the machine entry in the administrator console
and run it again. This replaces the Agent files, refreshes the local Agent
certificate, re-registers the machine, and restarts the systemd service.
Existing node state is retained in `/var/lib/node-platform-agent`.

For a reviewed Xray version, export `XRAY_VERSION` in the same terminal before
running the command copied from the administrator console:

```sh
export XRAY_VERSION=v26.3.27
```

Then paste and run the newly generated administrator command. Use the command
directly from the administrator console when possible.

## Uninstall

Remove the machine from service in the administrator console first, then on
the machine run:

```sh
sudo systemctl disable --now node-platform-agent
sudo rm -f /etc/systemd/system/node-platform-agent.service /etc/node-platform/agent.env
sudo rm -rf /opt/node-platform-agent /var/lib/node-platform-agent /etc/node-platform/agent-tls
sudo systemctl daemon-reload
```

Review firewall rules separately before removing them. This repository does not
contain control-plane database files, environment files, enrollment tokens,
administrator credentials, or private keys.

## Security notes

- The installation command is a secret while it is valid. Do not publish it in
  tickets, chat rooms, screenshots, browser history, or shell history.
- The one-time enrollment token is stored by the control plane only as a hash.
- Each new Agent has a unique API token and CA. The control plane trusts only
  that machine's CA for later HTTPS calls.
- Keep port `32081` restricted to the control plane. Do not expose the Agent
  token or TLS key.
- The generated VLESS profile in this proof-of-concept uses TCP without a
  transport security layer. Before a production rollout, select and review an
  appropriate transport/security profile for your authorized use case.

## License

MIT. Xray is an independent project and is downloaded from its official GitHub
release endpoint; refer to its own license and release notes.
