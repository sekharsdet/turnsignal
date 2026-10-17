# Builds the turnsignal package from source and runs its MCP server over stdio.
# Needs TURNSIGNAL_TOKEN (a TurnSignal project token) at run time.
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm run package
ENTRYPOINT ["node", "packages/turnsignal/dist/cli.js", "mcp"]
