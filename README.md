# diagram-creator-tanstack

Work in progress.

This project is a collection of packages I'm working on to give AI agents the ability to create technical diagrams using [Typst](https://typst.app/) and [CeTZ](https://cetz-package.github.io/docs/).

## Packages

- `packages/core` - shared agent harness
- `packages/typst-wasm` - a reusable WebAssembly Typst compiler service for loading files, fonts, packages, and compiling diagrams in different runtimes.
- `packages/mcp-common` - shared MCP schemas and the searchable index of CeTZ example content.
- `packages/mcp-server-node` - the Node-based MCP server that exposes tools to search CeTZ examples and compile Typst source.
- `packages/mcp-server-web` - the browser/web-worker-friendly MCP server with the same core diagram tools.
- `packages/mcp-runner-stdio` - runs the Node MCP server over stdio for local agent integrations.
- `packages/mcp-runner-http` - runs the Node MCP server over HTTP.
- `packages/mcp-runner-worker` - runs the web MCP server inside a worker transport.
- `packages/web-app` - the interactive web app for chatting with the agent and working on diagram generation in the browser.
