import type { WikiMonitorConfig, WikiNode } from '../shared/types'
import { FeishuClient } from '../feishu/client'

async function listAllChildren(
  client: FeishuClient,
  token: string,
  spaceId: string,
  parentNodeToken?: string,
): Promise<WikiNode[]> {
  const nodes: WikiNode[] = []
  let cursor: string | undefined
  do {
    const page = await client.listWikiChildren(token, spaceId, parentNodeToken, cursor)
    nodes.push(...page.items)
    cursor = page.nextCursor || undefined
  } while (cursor)
  return nodes
}

export async function traverseWiki(
  client: FeishuClient,
  token: string,
  monitor: WikiMonitorConfig,
): Promise<WikiNode[]> {
  const results: WikiNode[] = []
  const visited = new Set<string>()
  const stack: Array<{ node: WikiNode; parents: string[] }> = []

  if (monitor.rootNodeToken) {
    const root = await client.getWikiNode(token, monitor.rootNodeToken)
    stack.push({ node: root, parents: [] })
  } else {
    const roots = await listAllChildren(client, token, monitor.spaceId)
    for (const root of roots.reverse()) stack.push({ node: root, parents: [] })
  }

  while (stack.length > 0) {
    const current = stack.pop()!
    if (visited.has(current.node.nodeToken)) continue
    visited.add(current.node.nodeToken)
    current.node.parentTitles = current.parents
    results.push(current.node)

    // has_child is only a hint. A real list call is the source of truth.
    const children = await listAllChildren(client, token, monitor.spaceId, current.node.nodeToken)
    const nextParents = [...current.parents, current.node.title]
    for (const child of children.reverse()) stack.push({ node: child, parents: nextParents })
  }

  return results
}
