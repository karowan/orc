import type { ProgramGraphEdge, ProgramGraphNode, ProgramMeta, TraceRecord } from "./contracts.js";

const MAX_GRAPH_NODES = 128;
const MAX_GRAPH_EDGES = 256;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 256;
const MAX_LABEL_LENGTH = 256;

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TypeError(`${at} has unknown field "${extras[0]}"`);
}

function text(value: unknown, at: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${at} must be a non-empty string`);
  if (value.length > max) throw new TypeError(`${at} exceeds ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${at} contains control characters`);
  return value;
}

function normalizeNode(value: unknown, index: number): ProgramGraphNode {
  const at = `meta.graph.nodes[${index}]`;
  const node = object(value, at);
  exactKeys(node, ["id", "title", "kind", "terminalState"], at);
  if (
    node.kind !== undefined &&
    node.kind !== "phase" &&
    node.kind !== "gate" &&
    node.kind !== "terminal"
  ) {
    throw new TypeError(`${at}.kind must be "phase", "gate", or "terminal"`);
  }
  if (node.kind === "terminal") {
    if (node.terminalState !== "completed") {
      throw new TypeError(`${at}.terminalState must be "completed"`);
    }
  } else if (node.terminalState !== undefined) {
    throw new TypeError(`${at}.terminalState is only valid for terminal nodes`);
  }
  return {
    id: text(node.id, `${at}.id`, MAX_ID_LENGTH),
    title: text(node.title, `${at}.title`, MAX_TITLE_LENGTH),
    ...(node.kind === "gate" ? { kind: "gate" as const } : {}),
    ...(node.kind === "terminal"
      ? {
          kind: "terminal" as const,
          terminalState: "completed" as const,
        }
      : {}),
  };
}

function normalizeEdge(value: unknown, index: number): ProgramGraphEdge {
  const at = `meta.graph.edges[${index}]`;
  const edge = object(value, at);
  exactKeys(edge, ["from", "to", "kind", "label"], at);
  if (edge.kind !== undefined && edge.kind !== "loop") {
    throw new TypeError(`${at}.kind must be "loop" when present`);
  }
  return {
    from: text(edge.from, `${at}.from`, MAX_ID_LENGTH),
    to: text(edge.to, `${at}.to`, MAX_ID_LENGTH),
    ...(edge.kind === "loop" ? { kind: "loop" as const } : {}),
    ...(edge.label !== undefined ? { label: text(edge.label, `${at}.label`, MAX_LABEL_LENGTH) } : {}),
  };
}

function assertForwardGraphIsAcyclic(nodes: ProgramGraphNode[], edges: ProgramGraphEdge[]): void {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (edge.kind === "loop") continue;
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const ready = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const id = ready[cursor];
    visited++;
    for (const target of outgoing.get(id)!) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (visited !== nodes.length) {
    throw new TypeError('meta.graph forward edges contain a cycle; mark each back edge with kind: "loop"');
  }
}

export function normalizeProgramMeta(value: unknown): ProgramMeta | undefined {
  if (value === undefined) return undefined;
  const meta = object(value, "meta");
  exactKeys(meta, ["graph"], "meta");
  const graph = object(meta.graph, "meta.graph");
  exactKeys(graph, ["nodes", "edges"], "meta.graph");
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new TypeError("meta.graph.nodes must be a non-empty array");
  }
  if (graph.nodes.length > MAX_GRAPH_NODES) {
    throw new TypeError(`meta.graph.nodes exceeds ${MAX_GRAPH_NODES} entries`);
  }
  if (!Array.isArray(graph.edges)) throw new TypeError("meta.graph.edges must be an array");
  if (graph.edges.length > MAX_GRAPH_EDGES) {
    throw new TypeError(`meta.graph.edges exceeds ${MAX_GRAPH_EDGES} entries`);
  }

  const nodes = graph.nodes.map(normalizeNode);
  const nodeIds = new Set<string>();
  let terminalId: string | undefined;
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new TypeError(`meta.graph.nodes has duplicate id "${node.id}"`);
    nodeIds.add(node.id);
    if (node.kind === "terminal") {
      if (terminalId) {
        throw new TypeError(
          `meta.graph supports at most one terminal node; found "${terminalId}" and "${node.id}"`,
        );
      }
      terminalId = node.id;
    }
  }

  const edges = graph.edges.map(normalizeEdge);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) throw new TypeError(`meta.graph edge references unknown source "${edge.from}"`);
    if (!nodeIds.has(edge.to)) throw new TypeError(`meta.graph edge references unknown target "${edge.to}"`);
    if (edge.from === terminalId) {
      throw new TypeError(`meta.graph terminal node "${terminalId}" cannot have outgoing edges`);
    }
    const edgeId = `${edge.from}\u0000${edge.to}\u0000${edge.kind ?? ""}\u0000${edge.label ?? ""}`;
    if (edgeIds.has(edgeId)) {
      throw new TypeError(`meta.graph has duplicate edge "${edge.from}" -> "${edge.to}"`);
    }
    edgeIds.add(edgeId);
  }
  if (terminalId) {
    const incoming = edges.filter((edge) => edge.to === terminalId);
    if (incoming.length !== 1) {
      throw new TypeError(
        `meta.graph terminal node "${terminalId}" must have exactly one incoming edge`,
      );
    }
  }
  assertForwardGraphIsAcyclic(nodes, edges);
  return { graph: { nodes, edges } };
}

export function programMetaFromTraces(traces: TraceRecord[]): ProgramMeta | undefined {
  return traces.find((trace) => trace.t === "program-meta")?.meta;
}
