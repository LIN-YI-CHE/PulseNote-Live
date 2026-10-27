import type { MindMapNode } from '../types/meeting';

// Keep the graph readable while retaining folded content in node notes.
export function compactMindMap(input: MindMapNode[]): MindMapNode[] {
  const nodes = new Map<string, MindMapNode>();
  for (const node of input) {
    if (node?.id && typeof node.label === 'string' && node.label.trim()) {
      nodes.set(node.id, { ...node, parentId: node.parentId === 'NONE' ? null : node.parentId });
    }
  }
  const originalRoot = nodes.get('root') || [...nodes.values()].find(n => !n.parentId);
  const root: MindMapNode = { ...originalRoot, id: 'root', parentId: null, category: 'root', label: originalRoot?.label || '會議核心主題' };
  const output = [root];
  const append = (target: MindMapNode, node: MindMapNode) => {
    const detail = [node.label, node.notes].filter(Boolean).join('：');
    if (detail && !target.notes?.includes(detail)) target.notes = [target.notes, detail].filter(Boolean).join('\n');
  };
  const topics = new Map<string, MindMapNode>();
  const aliases = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.id === originalRoot?.id || node.id === 'root') continue;
    if (!node.parentId || node.parentId === 'root' || node.parentId === originalRoot?.id) {
      const duplicate = [...topics.values()].find(n => n.label.trim() === node.label.trim());
      if (duplicate) { append(duplicate, node); aliases.set(node.id, duplicate.id); }
      else if (topics.size < 4) { const topic = { ...node, parentId: 'root' }; topics.set(node.id, topic); output.push(topic); }
      else { append(root, node); aliases.set(node.id, 'root'); }
    }
  }
  for (const node of nodes.values()) {
    if (node.id === originalRoot?.id || node.id === 'root' || topics.has(node.id) || aliases.has(node.id)) continue;
    let parent = node.parentId;
    const visited = new Set([node.id]);
    while (parent && !topics.has(parent) && !aliases.has(parent) && !visited.has(parent)) {
      visited.add(parent); parent = nodes.get(parent)?.parentId || null;
    }
    const topic = topics.get(aliases.get(parent || '') || parent || '');
    if (!topic) { append(root, node); continue; }
    const children = output.filter(n => n.parentId === topic.id);
    const duplicate = children.find(n => n.label.trim() === node.label.trim());
    if (duplicate) append(duplicate, node);
    else if (children.length < 5) output.push({ ...node, parentId: topic.id });
    else append(topic, node);
  }
  return output;
}
