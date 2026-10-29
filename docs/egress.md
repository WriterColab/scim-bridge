# Server egress

The Node server wires fixed outbound HTTP clients at startup.

| Client        | Route                                             | Trust rule                                                                         |
| ------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| WorkOS        | Directory group preload and event identity checks | Direct. Only `https://api.workos.com` is allowed. Metadata addresses are rejected. |
| Events poller | WorkOS Events API or the bundled demo mock        | Direct. Only the boot-configured URL and exact demo URL are allowed.               |
| Bridge status | Directory status and event mapping                | Direct. Only `BRIDGE_STATUS_URL` or the server loopback origin is allowed.         |
| IdP simulator | Bundled demo simulator                            | Direct. Only the server loopback origin is allowed.                                |

The transport resolves every host before connecting. It rejects metadata, link-local, and unspecified addresses. It connects to the checked numeric address. It keeps the original HTTP Host and TLS server name. It does not follow redirects. Environment proxy variables cannot change its dispatcher.

Customer directory URLs remain unchanged. They can be private. The control panel stores them in `native_url` and `workos_url`. Protecting them as public-only destinations requires a separate product decision. The directory SCIM adapter and the IdP simulator SCIM target still use their existing transport.

SDK transports remain unchanged. This change does not enable a sidecar or an environment gate.
