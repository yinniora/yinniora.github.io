# Credentials and request privacy

Model API keys are submitted to the host over the authenticated workspace
connection. The web UI clears the entry after saving. Model and balance API
responses expose model metadata, a key-presence indicator and any supported
balance. Pi reads the saved credential from the local agent configuration.
YuGo protects the default agent directory and its own state directories and
database files on Unix. A custom agent root retains its selected directory
permissions. Windows storage follows the host account's file permissions.

Catalog, route detection and balance checks send credentials to the configured
provider and refuse redirects. Public model-limit lookup sends only a public
provider family name to `pi.dev`. Editing a key's endpoint to another origin
requires entering a replacement key. Official OpenAI profiles skip New API
balance probes and use the Responses API by default. Provider requests from the
chat worker to Messages, Chat Completions, Responses and Gemini generation
routes with API authentication also stop at redirects. Configure the final API
address for a gateway that returns a redirect.

Pi's normal prompt caching remains available during a model turn. YuGo stops
idle cache warming before it makes another model request and disables Pi's
optional install telemetry in YuGo-started processes. Session titles use local
heuristics by default. Selecting a model for automatic titles opts into requests
to that model. Scheduled runs, explicit sharing and extension operations follow
their own configured destinations.

Remote clients authenticate the host with the fingerprint from device pairing.
The relay carries encrypted workspace traffic and observes connection metadata.
Relay host credentials stay out of Pi subprocesses. The independently hosted
client program and its publishing account are trusted by approved devices.
See [remote workspace security](remote-security.md) for that boundary.

Installers verify release archive length and SHA-256 against the official
repository's release metadata. The release publisher is a trust dependency.
Installers keep workspace credentials out of command output. New host packages
bundle Pi 1.6.0, including project-extension trust checks and upstream auth-file
fixes. Installing a new backend binary alone retains the existing Pi runtime.

The host OS account, authorized shell execution, installed extensions, and
configured model providers remain in the trust boundary. The provider receives
the prompt and tool context necessary for each request and controls billing and
server-side retention. Workspace credentials are available to software with
equivalent access to the host user. Desktop startup assumes that the workspace
port on loopback belongs to the local YuGo host.
