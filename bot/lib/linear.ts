import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/bdk";
import { demo, linearProjectName } from "./demo.js";
import { isRecord } from "./json.js";

const CONNECTION = "account";

const LIST_PROJECTS = /(?:list|search|get)[_-]?(?:projects|project)$/i;
const LIST_TEAMS = /(?:list|search|get)[_-]?teams?$/i;
const LIST_STATUSES = /(?:list|get)[_-]?issue[_-]?statuses$/i;
const CREATE_ISSUE = /(?:create|save)[_-]?issue$/i;
const UPDATE_ISSUE = /(?:save|update)[_-]?issue$/i;
const COMMENT_TOOL = /(?:add|create|save)[_-]?comment$/i;

const ISSUE_ID = /[A-Z][A-Z0-9]+-\d+/;

export type LinearCallResult =
  | { ok: true; identifier?: string; url?: string }
  | { ok: false; reason: "not_connected" | "failed"; message: string; toolNames?: string[] };

export async function openLinearIssue(
  mcp: HostMcpRegistry,
  input: { title: string; description: string },
): Promise<LinearCallResult> {
  const tools = await loadTools(mcp);
  if (tools.status === "error") {
    return tools.result;
  }
  const project = await findProject(mcp, tools.tools);
  const create = tools.tools.find((tool) => CREATE_ISSUE.test(tool.name));
  if (create === undefined) {
    return {
      ok: false,
      reason: "failed",
      message: "Linear connector has no create/save issue tool",
      toolNames: tools.tools.map((tool) => tool.name),
    };
  }
  const args: Record<string, unknown> = {};
  assign(args, create, ["title", "name"], input.title);
  assign(args, create, ["description", "body"], input.description);
  assign(args, create, ["project", "projectId", "project_id"], project?.name ?? linearProjectName());
  if (project?.team !== undefined) {
    assign(args, create, ["team", "teamId", "team_id"], project.team);
  }
  const result = await call(mcp, create.name, args);
  if (result.status === "error") {
    return result.result;
  }
  return { ok: true, ...identifierFrom(result.text) };
}

export async function commentLinearIssue(
  mcp: HostMcpRegistry,
  input: { identifier: string; body: string },
): Promise<LinearCallResult> {
  const tools = await loadTools(mcp);
  if (tools.status === "error") {
    return tools.result;
  }
  const comment = tools.tools.find((tool) => COMMENT_TOOL.test(tool.name));
  if (comment === undefined) {
    return {
      ok: false,
      reason: "failed",
      message: "Linear connector has no comment tool",
      toolNames: tools.tools.map((tool) => tool.name),
    };
  }
  const args: Record<string, unknown> = {};
  assign(args, comment, ["issueId", "issue_id", "issueKey", "id", "identifier"], input.identifier);
  assign(args, comment, ["body", "comment", "text", "message"], input.body);
  const result = await call(mcp, comment.name, args);
  if (result.status === "error") {
    return result.result;
  }
  return { ok: true, identifier: input.identifier };
}

export async function closeLinearIssue(
  mcp: HostMcpRegistry,
  input: { identifier: string },
): Promise<LinearCallResult> {
  const tools = await loadTools(mcp);
  if (tools.status === "error") {
    return tools.result;
  }
  const statuses = tools.tools.find((tool) => LIST_STATUSES.test(tool.name));
  const update = tools.tools.find((tool) => UPDATE_ISSUE.test(tool.name));
  if (update === undefined) {
    return {
      ok: false,
      reason: "failed",
      message: "Linear connector has no update/save issue tool",
      toolNames: tools.tools.map((tool) => tool.name),
    };
  }
  let stateName: string | undefined;
  if (statuses !== undefined) {
    const listed = await call(mcp, statuses.name, {});
    if (listed.status === "ready") {
      stateName = completedStatusName(listed.text);
    }
  }
  if (stateName === undefined) {
    return {
      ok: false,
      reason: "failed",
      message:
        "TODO: could not find a Done/Completed/Closed status from the Linear connector. Use the advertised Linear tools to set the state on " +
        input.identifier +
        " in workspace " +
        demo.linearWorkspace +
        ".",
      toolNames: tools.tools.map((tool) => tool.name),
    };
  }
  const args: Record<string, unknown> = {};
  assign(args, update, ["id", "issueId", "issue_id", "identifier"], input.identifier);
  assign(args, update, ["state", "stateId", "status", "statusId"], stateName);
  const result = await call(mcp, update.name, args);
  if (result.status === "error") {
    return result.result;
  }
  return { ok: true, identifier: input.identifier };
}

type ToolsLoaded =
  | { status: "ready"; tools: HostMcpToolInfo[] }
  | { status: "error"; result: Extract<LinearCallResult, { ok: false }> };

type CallText =
  | { status: "ready"; text: string }
  | { status: "error"; result: Extract<LinearCallResult, { ok: false }> };

async function loadTools(mcp: HostMcpRegistry): Promise<ToolsLoaded> {
  if (!mcp.names().includes(CONNECTION)) {
    return {
      status: "error",
      result: { ok: false, reason: "not_connected", message: "Linear account connection is not loaded" },
    };
  }
  try {
    const tools = await mcp.listTools(CONNECTION);
    if (tools.length === 0) {
      return {
        status: "error",
        result: { ok: false, reason: "not_connected", message: "Linear connector listed no tools" },
      };
    }
    return { status: "ready", tools };
  } catch (error) {
    return {
      status: "error",
      result: {
        ok: false,
        reason: "not_connected",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function findProject(
  mcp: HostMcpRegistry,
  tools: HostMcpToolInfo[],
): Promise<{ name: string; team?: string } | undefined> {
  const listProjects = tools.find((tool) => LIST_PROJECTS.test(tool.name));
  if (listProjects === undefined) {
    return undefined;
  }
  const listed = await call(mcp, listProjects.name, {});
  if (listed.status === "error") {
    return undefined;
  }
  const projects = collectProjects(tryParse(listed.text) ?? listed.text);
  const match = projects.find(
    (project) => project.name.toLowerCase() === linearProjectName().toLowerCase(),
  );
  if (match !== undefined) {
    return match;
  }
  const teams = tools.find((tool) => LIST_TEAMS.test(tool.name));
  if (teams === undefined) {
    return { name: linearProjectName() };
  }
  const teamList = await call(mcp, teams.name, {});
  if (teamList.status === "error") {
    return { name: linearProjectName() };
  }
  const team = firstTeam(tryParse(teamList.text) ?? teamList.text);
  return { name: linearProjectName(), team };
}

async function call(
  mcp: HostMcpRegistry,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallText> {
  try {
    const result = await mcp.callTool(CONNECTION, tool, args);
    if (result.isError === true) {
      return { status: "error", result: { ok: false, reason: "failed", message: resultText(result) } };
    }
    return { status: "ready", text: resultText(result) };
  } catch (error) {
    return {
      status: "error",
      result: {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function assign(
  args: Record<string, unknown>,
  tool: HostMcpToolInfo,
  aliases: readonly string[],
  value: string,
): void {
  const known = propertyNames(tool);
  const property = aliases.find((alias) => known.has(alias)) ?? aliases[0];
  if (property !== undefined) {
    args[property] = value;
  }
}

function propertyNames(tool: HostMcpToolInfo): Set<string> {
  const properties = tool.inputSchema?.["properties"];
  if (!isRecord(properties)) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

function resultText(result: HostMcpCallResult): string {
  return result.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

function identifierFrom(text: string): { identifier?: string; url?: string } {
  const identifier = text.match(ISSUE_ID)?.[0];
  const url = text.match(/https:\/\/linear\.app\/\S+/)?.[0];
  return {
    ...(identifier === undefined ? {} : { identifier }),
    ...(url === undefined ? {} : { url }),
  };
}

function completedStatusName(text: string): string | undefined {
  return findCompletedStatus(tryParse(text) ?? text);
}

function findCompletedStatus(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCompletedStatus(entry);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const name = typeof value.name === "string" ? value.name : "";
  const type = typeof value.type === "string" ? value.type : "";
  if (name !== "" && (type === "completed" || /^(done|completed|complete|closed)$/i.test(name))) {
    return name;
  }
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      const found = findCompletedStatus(nested);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

type ProjectHit = { name: string; team?: string };

function collectProjects(value: unknown, found: ProjectHit[] = []): ProjectHit[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectProjects(entry, found);
    }
    return found;
  }
  if (!isRecord(value)) {
    return found;
  }
  const url = typeof value.url === "string" ? value.url : "";
  if (
    typeof value.name === "string" &&
    (typeof value.slug === "string" || url.includes("/project"))
  ) {
    const team = typeof value.team === "string" ? value.team : teamName(value.team);
    found.push(team === undefined ? { name: value.name } : { name: value.name, team });
  }
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      collectProjects(nested, found);
    }
  }
  return found;
}

function teamName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.key === "string") {
    return value.key;
  }
  if (typeof value.name === "string") {
    return value.name;
  }
  if (typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

function firstTeam(value: unknown): string | undefined {
  const names = collectStrings(value, ["key", "name", "id"]);
  return names[0];
}

function collectStrings(value: unknown, keys: readonly string[], found: string[] = []): string[] {
  if (typeof value === "string") {
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, keys, found);
    }
    return found;
  }
  if (!isRecord(value)) {
    return found;
  }
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim() !== "") {
      found.push(entry);
    }
  }
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      collectStrings(nested, keys, found);
    }
  }
  return found;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
