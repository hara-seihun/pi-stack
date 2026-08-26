import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import stripJsonComments from "strip-json-comments";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

function interpolate(value) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced, bare) => {
    const name = braced ?? bare;
    if (process.env[name] === undefined) throw new Error(`environment variable ${name} is not set`);
    return process.env[name];
  });
}

async function resolveSecret(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("!")) return interpolate(value);
  const command = value.slice(1).trim();
  if (!command) throw new Error("empty secret command");
  const { stdout } = await execFileAsync("bash", ["-lc", command], {
    encoding: "utf8",
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function readConfig(path) {
  if (!existsSync(path)) return {};
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`cannot parse MCP config ${path}: ${error.message}`);
  }
  const servers = parsed?.mcpServers ?? parsed?.servers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`MCP config ${path} must contain an object at mcpServers`);
  }
  return servers;
}

export function configPaths(cwd = process.cwd(), options = {}) {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  if (options.config) return [resolve(cwd, options.config)];
  return [
    join(home, ".config", "mcp", "mcp.json"),
    join(home, ".agents", "mcp.json"),
    join(home, ".agents", "mcp", "mcp.json"),
    join(agentDir, "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ];
}

export function loadConfig(cwd = process.cwd(), options = {}) {
  const servers = {};
  const provenance = {};
  for (const path of configPaths(cwd, options)) {
    for (const [name, definition] of Object.entries(readConfig(path))) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw new Error(`MCP server ${name} in ${path} must be an object`);
      }
      servers[name] = { ...definition };
      provenance[name] = path;
    }
  }
  return { servers, provenance };
}

function enabled(definition) {
  return definition.disabled !== true && definition.enabled !== false;
}

async function resolvedHeaders(definition) {
  const headers = {};
  for (const [key, value] of Object.entries(definition.headers ?? {})) {
    headers[key] = await resolveSecret(String(value));
  }
  if (definition.bearerToken !== undefined) {
    headers.Authorization = `Bearer ${await resolveSecret(definition.bearerToken)}`;
  }
  return headers;
}

async function resolvedEnv(definition) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(definition.env ?? {})) {
    env[key] = await resolveSecret(String(value));
  }
  return env;
}

async function transportFor(name, definition) {
  const transports = [definition.url, definition.command].filter((value) => typeof value === "string" && value.length > 0);
  if (transports.length !== 1) throw new Error(`server ${name} must define exactly one of url or command`);
  if (definition.url) {
    if (definition.auth === "oauth") {
      throw new Error(`server ${name} requires OAuth; standalone OAuth login has not been configured for this machine`);
    }
    const headers = await resolvedHeaders(definition);
    return new StreamableHTTPClientTransport(new URL(interpolate(definition.url)), {
      requestInit: { headers },
    });
  }
  return new StdioClientTransport({
    command: interpolate(definition.command),
    args: (definition.args ?? []).map((arg) => interpolate(String(arg))),
    env: await resolvedEnv(definition),
    cwd: definition.cwd ? resolve(interpolate(definition.cwd)) : process.cwd(),
    stderr: definition.debug ? "inherit" : "pipe",
  });
}

async function allPages(fetchPage) {
  const items = [];
  let cursor;
  do {
    const page = await fetchPage(cursor);
    items.push(...(page.tools ?? page.prompts ?? page.resources ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export class McpRuntime {
  constructor(options = {}) {
    const loaded = loadConfig(options.cwd ?? process.cwd(), options);
    this.servers = loaded.servers;
    this.provenance = loaded.provenance;
    this.connections = new Map();
    this.catalog = undefined;
  }

  serverNames() {
    return Object.entries(this.servers).filter(([, definition]) => enabled(definition)).map(([name]) => name).sort();
  }

  async connect(serverName) {
    if (this.connections.has(serverName)) return this.connections.get(serverName);
    const definition = this.servers[serverName];
    if (!definition) throw new Error(`MCP server ${serverName} is not configured`);
    if (!enabled(definition)) throw new Error(`MCP server ${serverName} is disabled`);
    const transport = await transportFor(serverName, definition);
    const client = new Client({ name: "mcp-cli", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: definition.timeout ?? DEFAULT_TIMEOUT_MS });
      const tools = await allPages((cursor) => client.listTools(cursor ? { cursor } : undefined));
      const connection = {
        name: serverName,
        client,
        transport,
        tools,
        instructions: client.getInstructions?.(),
        capabilities: client.getServerCapabilities?.() ?? {},
      };
      this.connections.set(serverName, connection);
      this.catalog = undefined;
      return connection;
    } catch (error) {
      await Promise.resolve(client.close()).catch(() => {});
      throw new Error(`cannot connect to MCP server ${serverName}: ${error.message}`, { cause: error });
    }
  }

  async close() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map((connection) => connection.client.close()));
  }

  async list(serverName) {
    if (serverName) return (await this.connect(serverName)).tools.map((tool) => toolRecord(serverName, tool));
    const settled = await Promise.allSettled(this.serverNames().map((name) => this.connect(name)));
    const errors = settled.flatMap((result, index) => result.status === "rejected"
      ? [{ server: this.serverNames()[index], error: result.reason?.message ?? String(result.reason) }]
      : []);
    if (errors.length > 0) {
      const error = new Error(`failed to connect to ${errors.length} MCP server(s)`);
      error.details = errors;
      throw error;
    }
    return settled.flatMap((result) => result.value.tools.map((tool) => toolRecord(result.value.name, tool)));
  }

  async buildCatalog() {
    if (this.catalog) return this.catalog;
    const records = await this.list();
    const byPath = new Map();
    const byName = new Map();
    for (const record of records) {
      byPath.set(record.path, record);
      const names = byName.get(record.name) ?? [];
      names.push(record);
      byName.set(record.name, names);
    }
    this.catalog = { records, byPath, byName };
    return this.catalog;
  }

  async resolveTool(path) {
    const catalog = await this.buildCatalog();
    const exact = catalog.byPath.get(path);
    if (exact) return exact;
    const plain = catalog.byName.get(path) ?? [];
    if (plain.length === 1) return plain[0];
    if (plain.length > 1) throw new Error(`tool name ${path} is ambiguous: ${plain.map((item) => item.path).join(", ")}`);
    const suggestions = catalog.records.filter((item) => item.path.includes(path) || item.name.includes(path)).slice(0, 8).map((item) => item.path);
    throw new Error(`MCP tool ${path} was not found${suggestions.length ? `; matches: ${suggestions.join(", ")}` : ""}`);
  }

  async call(path, args = {}) {
    const tool = await this.resolveTool(path);
    const connection = await this.connect(tool.server);
    try {
      return await connection.client.callTool({ name: tool.name, arguments: args }, undefined, {
        timeout: this.servers[tool.server]?.toolTimeout ?? 120_000,
      });
    } catch (error) {
      throw new Error(`${tool.path} failed: ${error.message}`, { cause: error });
    }
  }

  async describe(path) {
    const tool = await this.resolveTool(path);
    return { ...tool, inputTypeScript: schemaToTypeScript(tool.inputSchema ?? {}, "Input") };
  }

  async search({ query, server, limit = 12, offset = 0 } = {}) {
    const terms = String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const records = server ? await this.list(server) : (await this.buildCatalog()).records;
    const ranked = records.map((record) => {
      const haystack = `${record.path} ${record.name} ${record.description ?? ""}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? (record.path.toLowerCase().includes(term) ? 3 : 1) : 0), 0);
      return { record, score };
    }).filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path));
    const items = ranked.slice(offset, offset + limit).map(({ record }) => record);
    return { items, total: ranked.length, hasMore: offset + items.length < ranked.length, nextOffset: offset + items.length };
  }

  async instructions(serverName) {
    return (await this.connect(serverName)).instructions ?? "";
  }

  async status({ connect = false } = {}) {
    const names = Object.keys(this.servers).sort();
    return Promise.all(names.map(async (name) => {
      const definition = this.servers[name];
      const base = { server: name, enabled: enabled(definition), transport: definition.url ? "http" : definition.command ? "stdio" : "invalid", source: this.provenance[name] };
      if (!connect || !base.enabled) return base;
      try {
        const connection = await this.connect(name);
        return { ...base, connected: true, tools: connection.tools.length, instructions: Boolean(connection.instructions) };
      } catch (error) {
        return { ...base, connected: false, error: error.message };
      }
    }));
  }
}

function toolRecord(server, tool) {
  return {
    path: `${server}_${tool.name}`,
    name: tool.name,
    server,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
  };
}

function literal(value) {
  return JSON.stringify(value);
}

function schemaType(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ") || "never";
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(schemaType).join(" | ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(schemaType).join(" | ");
  if (Array.isArray(schema.allOf)) return schema.allOf.map(schemaType).join(" & ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => schemaType({ ...schema, type })).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `${schemaType(schema.items ?? {})}[]`;
    case "object": {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(([name, child]) => {
        const description = child?.description ? `  /** ${String(child.description).replaceAll("*/", "* /")} */\n` : "";
        return `${description}  ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(child)};`;
      });
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") fields.push(`  [key: string]: ${schemaType(schema.additionalProperties)};`);
      return `{\n${fields.join("\n")}\n}`;
    }
    default: return "unknown";
  }
}

export function schemaToTypeScript(schema, name = "Input") {
  return `type ${name} = ${schemaType(schema)};`;
}

export function parseJson(text, label = "JSON") {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

export function formatError(error) {
  return { error: { message: error?.message ?? String(error), ...(error?.details ? { details: error.details } : {}) } };
}
