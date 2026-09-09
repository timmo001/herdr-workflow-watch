# Herdr Workflow Watch

GitHub workflow failure indicators for Herdr workspaces.

This repository currently contains the TypeScript and Effect CLI scaffold.
Workflow watching and Herdr integration are planned.

## Development

[mise](https://mise.jdx.dev/) pins Bun and Node and runs the project tasks.

```sh
mise install
mise run install
mise run check
mise run build
bun dist/index.js --help
```

Use `mise run format` to format source and configuration.
CI installs dependencies with `bun install --frozen-lockfile` before checking
and building. Build output is a Bun module in `dist/`.

## Licence

[Apache-2.0](LICENSE).
