import React, { useState, useRef, useMemo } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Plus,
  Trash2,
  Download,
  Edit3,
  Check,
  X,
  Code2,
  Layers,
  GitMerge,
  RefreshCw,
  Info,
  CheckSquare,
  Copy,
  BookOpen,
} from 'lucide-react';
import { MindMapNode } from '../types/meeting';

interface MindMapCanvasProps {
  nodes: MindMapNode[];
  onUpdateNodes: (nodes: MindMapNode[]) => void;
  meetingTitle: string;
  onOpenInspector?: () => void;
  onConvergeMindMap?: () => Promise<void>;
  isConverging?: boolean;
  onAddTodoFromNode?: (task: string, priority?: 'high' | 'medium' | 'low') => void;
}

interface PositionedNode extends MindMapNode {
  x: number;
  y: number;
  depth: number;
  width: number;
  height: number;
  hasChildren: boolean;
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 58;
const LEVEL_GAP_X = 290;
const SIBLING_GAP_Y = 24;
const ROW_HEIGHT = NODE_HEIGHT + SIBLING_GAP_Y; // 82px minimum vertical interval

export const MindMapCanvas: React.FC<MindMapCanvasProps> = ({
  nodes,
  onUpdateNodes,
  meetingTitle,
  onOpenInspector,
  onConvergeMindMap,
  isConverging = false,
  onAddTodoFromNode,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState<number>(0.92);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 60, y: 300 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Count Level 1 pillars directly connected to root
  const level1PillarsCount = useMemo(() => {
    return nodes.filter(
      (n) =>
        n.id !== 'root' &&
        (n.parentId === 'root' || !n.parentId || n.parentId === 'NONE')
    ).length;
  }, [nodes]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('root');
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState<string>('');
  const [editCategory, setEditCategory] =
    useState<MindMapNode['category']>('topic');
  const [editNotes, setEditNotes] = useState<string>('');

  // Leaf Node Detailed View Modal State
  const [detailNode, setDetailNode] = useState<PositionedNode | null>(null);
  const [detailNotesText, setDetailNotesText] = useState<string>('');
  const [isEditingNotesInDetail, setIsEditingNotesInDetail] = useState<boolean>(false);
  const [copiedFeedback, setCopiedFeedback] = useState<boolean>(false);
  const [addedTodoFeedback, setAddedTodoFeedback] = useState<boolean>(false);

  // Helper to trace breadcrumb hierarchy path from root down to any target node
  const getNodeBreadcrumbPath = (nodeId: string): MindMapNode[] => {
    const pathList: MindMapNode[] = [];
    let curr: MindMapNode | undefined = nodes.find((n) => n.id === nodeId);
    const visited = new Set<string>();
    while (curr && !visited.has(curr.id)) {
      visited.add(curr.id);
      pathList.unshift(curr);
      if (!curr.parentId || curr.parentId === 'NONE' || curr.id === 'root') break;
      curr = nodes.find((n) => n.id === curr!.parentId);
    }
    return pathList;
  };

  const handleSaveDetailNotes = (nodeId: string, newNotes: string) => {
    onUpdateNodes(
      nodes.map((n) =>
        n.id === nodeId ? { ...n, notes: newNotes.trim() || undefined } : n
      )
    );
    if (detailNode && detailNode.id === nodeId) {
      setDetailNode({ ...detailNode, notes: newNotes.trim() || undefined });
    }
  };

  const handleCopyNodeInfo = (node: PositionedNode) => {
    const path = getNodeBreadcrumbPath(node.id).map((n) => n.label).join(' > ');
    const text = `【心智圖節點】：${node.label}\n【所屬路徑】：${path}\n【節點屬性】：${node.category || '未分類'}\n${node.notes ? `【詳細備忘】：${node.notes}` : ''}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedFeedback(true);
      setTimeout(() => setCopiedFeedback(false), 2000);
    });
  };

  // Depth view mode: 'all' (3 levels) or 'l2' (only root + main topics)
  const [viewDepth, setViewDepth] = useState<'all' | 'l2'>('all');

  // Compute deterministic, collision-free hierarchical tree layout
  const { positionedNodes, edges, bounds } = useMemo(() => {
    if (!nodes || nodes.length === 0) {
      return {
        positionedNodes: [] as PositionedNode[],
        edges: [] as Array<{
          id: string;
          source: PositionedNode;
          target: PositionedNode;
        }>,
        bounds: { minX: 0, maxX: 800, minY: -200, maxY: 200 },
      };
    }

    // 1. Normalize root node
    const rootNode =
      nodes.find(
        (n) => n.id === 'root' || n.parentId === null || n.parentId === 'NONE'
      ) || nodes[0];

    const nodeMap = new Map<string, MindMapNode>();
    for (const n of nodes) {
      nodeMap.set(n.id, n);
    }

    // 2. Build parent -> children map with cycle-prevention
    const childrenMap = new Map<string, MindMapNode[]>();
    for (const n of nodes) {
      if (n.id === rootNode.id) continue;
      const pid =
        !n.parentId ||
        n.parentId === 'NONE' ||
        !nodeMap.has(n.parentId)
          ? rootNode.id
          : n.parentId;
      const list = childrenMap.get(pid) || [];
      list.push(n);
      childrenMap.set(pid, list);
    }

    // 3. Pass 1: Compute Subtree Bounding Height for every node
    const subtreeHeightMap = new Map<string, number>();

    const computeSubtreeHeight = (nodeId: string, depth: number): number => {
      const children = childrenMap.get(nodeId) || [];
      const isForcedCollapsed = viewDepth === 'l2' && depth >= 1;
      const nodeObj = nodeMap.get(nodeId);
      const isCollapsed = Boolean(nodeObj?.collapsed || isForcedCollapsed);

      if (children.length === 0 || isCollapsed) {
        subtreeHeightMap.set(nodeId, ROW_HEIGHT);
        return ROW_HEIGHT;
      }

      let totalChildHeight = 0;
      for (const child of children) {
        totalChildHeight += computeSubtreeHeight(child.id, depth + 1);
      }
      const height = Math.max(totalChildHeight, ROW_HEIGHT);
      subtreeHeightMap.set(nodeId, height);
      return height;
    };

    computeSubtreeHeight(rootNode.id, 0);

    // 4. Pass 2: Position nodes by partitioning vertical space among subtrees
    const resultNodes: PositionedNode[] = [];
    const posMap = new Map<string, PositionedNode>();

    const layoutSubtree = (
      node: MindMapNode,
      depth: number,
      topY: number,
      allocatedHeight: number
    ) => {
      const children = childrenMap.get(node.id) || [];
      const isForcedCollapsed = viewDepth === 'l2' && depth >= 1;
      const effectiveCollapsed = Boolean(node.collapsed || isForcedCollapsed);
      const hasChildren = children.length > 0 && !effectiveCollapsed;
      const x = depth * LEVEL_GAP_X;

      let y: number;

      if (!hasChildren) {
        // Center leaf in its dedicated non-overlapping vertical slice
        y = topY + allocatedHeight / 2;
      } else {
        // Distribute children into dedicated, contiguous vertical intervals
        let childTop = topY;
        const childYs: number[] = [];

        for (const child of children) {
          const childH = subtreeHeightMap.get(child.id) || ROW_HEIGHT;
          layoutSubtree(child, depth + 1, childTop, childH);
          const placedChild = posMap.get(child.id);
          if (placedChild) {
            childYs.push(placedChild.y);
          }
          childTop += childH;
        }

        // Center parent relative to its children span
        if (childYs.length > 0) {
          y = (childYs[0] + childYs[childYs.length - 1]) / 2;
        } else {
          y = topY + allocatedHeight / 2;
        }
      }

      const pNode: PositionedNode = {
        ...node,
        x,
        y,
        depth,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        hasChildren: children.length > 0,
      };

      resultNodes.push(pNode);
      posMap.set(node.id, pNode);
    };

    const totalRootHeight = subtreeHeightMap.get(rootNode.id) || ROW_HEIGHT;
    layoutSubtree(rootNode, 0, 0, totalRootHeight);

    // 5. Pass 3: Per-depth Collision Relaxation Guarantee (eliminates any edge-case overlaps)
    const depthGroups = new Map<number, PositionedNode[]>();
    for (const pn of resultNodes) {
      const list = depthGroups.get(pn.depth) || [];
      list.push(pn);
      depthGroups.set(pn.depth, list);
    }

    for (const [, list] of depthGroups) {
      list.sort((a, b) => a.y - b.y);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const curr = list[i];
        if (curr.y - prev.y < ROW_HEIGHT) {
          const shift = ROW_HEIGHT - (curr.y - prev.y);
          curr.y += shift;
        }
      }
    }

    // 6. Pass 4: Center tree vertically around root node y = 0
    const rootPos = posMap.get(rootNode.id);
    const offsetY = rootPos ? rootPos.y : 0;
    for (const pn of resultNodes) {
      pn.y -= offsetY;
    }

    // 7. Recompute clean directed edges
    const resultEdges: Array<{
      id: string;
      source: PositionedNode;
      target: PositionedNode;
    }> = [];

    for (const pn of resultNodes) {
      if (pn.id === rootNode.id) continue;
      const pid =
        !pn.parentId || pn.parentId === 'NONE' || !posMap.has(pn.parentId)
          ? rootNode.id
          : pn.parentId;
      const source = posMap.get(pid);
      if (source) {
        resultEdges.push({
          id: `${source.id}->${pn.id}`,
          source,
          target: pn,
        });
      }
    }

    // 8. Dynamic canvas bounds
    let minX = 0;
    let maxX = 800;
    let minY = -250;
    let maxY = 250;

    if (resultNodes.length > 0) {
      minX = Math.min(...resultNodes.map((n) => n.x)) - 60;
      maxX = Math.max(...resultNodes.map((n) => n.x + n.width)) + 80;
      minY = Math.min(...resultNodes.map((n) => n.y - n.height / 2)) - 80;
      maxY = Math.max(...resultNodes.map((n) => n.y + n.height / 2)) + 80;
    }

    return {
      positionedNodes: resultNodes,
      edges: resultEdges,
      bounds: { minX, maxX, minY, maxY },
    };
  }, [nodes, viewDepth]);

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if ((e.target as HTMLElement).closest('[data-node-interactive="true"]')) {
      return;
    }
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleResetView = () => {
    setZoom(0.92);
    setPan({ x: 50, y: 250 });
  };

  const handleToggleCollapse = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdateNodes(
      nodes.map((n) =>
        n.id === nodeId ? { ...n, collapsed: !n.collapsed } : n
      )
    );
  };

  const handleStartEdit = (node: MindMapNode, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedNodeId(node.id);
    setEditingNodeId(node.id);
    setEditLabel(node.label);
    setEditCategory(node.category || 'topic');
    setEditNotes(node.notes || '');
  };

  const handleSaveEdit = () => {
    if (!editingNodeId || !editLabel.trim()) return;
    onUpdateNodes(
      nodes.map((n) =>
        n.id === editingNodeId
          ? {
              ...n,
              label: editLabel.trim(),
              category: editCategory,
              notes: editNotes.trim() || undefined,
            }
          : n
      )
    );
    setEditingNodeId(null);
  };

  const handleAddChildNode = (parentId?: string) => {
    const targetParentId = parentId || selectedNodeId || 'root';
    const newId = `node-${Date.now().toString().slice(-5)}`;
    const newNode: MindMapNode = {
      id: newId,
      parentId: targetParentId,
      label: '新討論節點',
      category: targetParentId === 'root' ? 'topic' : 'decision',
    };
    const updated = nodes.map((n) =>
      n.id === targetParentId ? { ...n, collapsed: false } : n
    );
    onUpdateNodes([...updated, newNode]);
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditLabel('新討論節點');
    setEditCategory(newNode.category);
    setEditNotes('');
  };

  const handleDeleteNode = (nodeId: string) => {
    if (nodeId === 'root') return;
    const toRemove = new Set<string>([nodeId]);
    let added = true;
    while (added) {
      added = false;
      for (const n of nodes) {
        if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
          toRemove.add(n.id);
          added = true;
        }
      }
    }
    onUpdateNodes(nodes.filter((n) => !toRemove.has(n.id)));
    if (selectedNodeId && toRemove.has(selectedNodeId)) {
      setSelectedNodeId('root');
    }
  };

  const handleExportPNG = () => {
    if (!svgRef.current) return;
    const width = Math.max(960, bounds.maxX - bounds.minX);
    const height = Math.max(600, bounds.maxY - bounds.minY);
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute(
      'viewBox',
      `${bounds.minX} ${bounds.minY} ${width} ${height}`
    );
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    const innerGroup = clone.querySelector('[data-canvas-transform="true"]');
    if (innerGroup) {
      innerGroup.setAttribute('transform', 'translate(0, 0) scale(1)');
    }

    const svgData = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([svgData], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = 2; // Retina 2x resolution
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) {
            const pngUrl = URL.createObjectURL(pngBlob);
            const a = document.createElement('a');
            a.href = pngUrl;
            a.download = `${meetingTitle || 'mindmap'}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(pngUrl);
          }
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const getCategoryStyles = (
    category: MindMapNode['category'],
    isSelected: boolean
  ) => {
    if (category === 'root') {
      return {
        fill: '#0F172A',
        stroke: isSelected ? '#2563EB' : '#020617',
        textFill: '#FFFFFF',
        subLabel: 'L1 · 核心主題',
        subFill: '#94A3B8',
      };
    }
    if (category === 'decision') {
      return {
        fill: '#EFF6FF',
        stroke: isSelected ? '#2563EB' : '#93C5FD',
        textFill: '#1E3A8A',
        subLabel: 'L3 · 關鍵決策',
        subFill: '#2563EB',
      };
    }
    if (category === 'action') {
      return {
        fill: '#FEF3C7',
        stroke: isSelected ? '#D97706' : '#FCD34D',
        textFill: '#78350F',
        subLabel: 'L3 · 執行行動',
        subFill: '#B45309',
      };
    }
    return {
      fill: '#FFFFFF',
      stroke: isSelected ? '#2563EB' : '#CBD5E1',
      textFill: '#0F172A',
      subLabel: 'L2 · 討論主軸',
      subFill: '#475569',
    };
  };

  // Split label into 2 lines if longer than 13 characters to avoid truncated words
  const splitLabelToLines = (text: string): [string, string | null] => {
    if (text.length <= 13) return [text, null];
    if (text.length <= 26) {
      const mid = Math.ceil(text.length / 2);
      return [text.slice(0, mid), text.slice(mid)];
    }
    return [text.slice(0, 13), text.slice(13, 25) + '…'];
  };

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC] select-none relative overflow-hidden">
      {/* Column Header & Canvas Toolbar */}
      <div className="px-4 py-2.5 bg-white border-b border-slate-200 shrink-0">
        {/* Row 1: Completely Independent Title Area */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-bold text-slate-900 tracking-tight whitespace-nowrap">
              三層架構心智圖
            </h2>
            <span className="px-2 py-0.5 text-[11px] font-semibold text-slate-600 bg-slate-100 rounded-full font-mono-tabular shrink-0">
              {level1PillarsCount} 主柱 · {nodes.length} 節點
            </span>
            {level1PillarsCount > 4 && (
              <span
                className="px-2 py-0.5 text-[10.5px] font-medium bg-amber-100 text-amber-800 rounded-full whitespace-nowrap animate-pulse shrink-0"
                title="第一階分支超過 4 支，建議點擊下方「智慧收斂主幹」"
              >
                主幹偏多 (建議收斂)
              </span>
            )}
          </div>
        </div>

        {/* Row 2: Action Buttons Bar (Responsive flex-wrap, clean layout) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Smart Convergence Button */}
          {onConvergeMindMap && (
            <button
              onClick={() => onConvergeMindMap()}
              disabled={isConverging || nodes.length <= 2}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded transition-all whitespace-nowrap shrink-0 shadow-2xs ${
                level1PillarsCount > 4
                  ? 'bg-amber-600 hover:bg-amber-700 text-white ring-2 ring-amber-300'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              } disabled:opacity-50`}
              title="一鍵智慧收斂：AI 會自動將散落的第一階分支聚類為 3~4 個核心支柱，消除重複並聚合相同議題"
            >
              {isConverging ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>AI 收斂聚合中...</span>
                </>
              ) : (
                <>
                  <GitMerge className="w-3.5 h-3.5" />
                  <span>智慧收斂主幹</span>
                </>
              )}
            </button>
          )}

          {/* Depth View Filter Toggle */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded text-xs font-medium text-slate-600 shrink-0">
            <button
              onClick={() => setViewDepth('all')}
              className={`px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                viewDepth === 'all'
                  ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                  : 'hover:text-slate-900'
              }`}
              title="展開全部三層（主軸與決策）"
            >
              全部展開
            </button>
            <button
              onClick={() => setViewDepth('l2')}
              className={`px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                viewDepth === 'l2'
                  ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                  : 'hover:text-slate-900'
              }`}
              title="只顯示核心主題與二級主軸，收合次級細節"
            >
              僅看主幹
            </button>
          </div>

          <button
            onClick={() => handleAddChildNode()}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
            title="在選取節點下新增分支"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增節點</span>
          </button>

          <button
            onClick={handleExportPNG}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
            title="下載高解析度 PNG 心智圖"
          >
            <Download className="w-3.5 h-3.5" />
            <span>匯出 PNG</span>
          </button>

          {onOpenInspector && (
            <button
              onClick={onOpenInspector}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200/60 rounded transition-colors whitespace-nowrap shrink-0 ml-auto"
              title="查看 Gemini 3.8 Live 呼叫工具的原始 JSON 數據"
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>模型數據</span>
            </button>
          )}
        </div>
      </div>

      {/* Inline Node Editor Bar */}
      {editingNodeId && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 bg-blue-50/90 border-b border-blue-200 shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs font-medium text-blue-900 whitespace-nowrap">
              編輯節點：
            </span>
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              className="flex-1 min-w-0 px-2.5 py-1 text-xs bg-white border border-blue-300 rounded text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              placeholder="輸入節點標題..."
              autoFocus
            />
            <input
              type="text"
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="w-48 px-2.5 py-1 text-xs bg-white border border-blue-300 rounded text-slate-700 focus:outline-none"
              placeholder="補充說明細節 (notes)..."
            />
            <select
              value={editCategory}
              onChange={(e) =>
                setEditCategory(e.target.value as MindMapNode['category'])
              }
              className="px-2 py-1 text-xs bg-white border border-blue-300 rounded text-slate-700 focus:outline-none"
            >
              <option value="topic">討論主軸 (Level 2)</option>
              <option value="decision">關鍵決策 (Level 3)</option>
              <option value="action">執行行動 (Level 3)</option>
            </select>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleSaveEdit}
              className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors whitespace-nowrap"
            >
              <Check className="w-3.5 h-3.5" />
              <span>儲存</span>
            </button>
            <button
              onClick={() => setEditingNodeId(null)}
              className="p-1 text-slate-500 hover:text-slate-800 rounded"
              title="取消編輯"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Interactive SVG Canvas */}
      <div className="flex-1 relative overflow-hidden">
        {/* Subtle dot matrix background */}
        <div
          className="absolute inset-0 pointer-events-none opacity-40"
          style={{
            backgroundImage:
              'radial-gradient(#CBD5E1 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />

        <svg
          ref={svgRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className={`w-full h-full ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          <g
            data-canvas-transform="true"
            transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}
          >
            {/* Bézier Connecting Curves */}
            {edges.map((edge) => {
              const x1 = edge.source.x + edge.source.width;
              const y1 = edge.source.y;
              const x2 = edge.target.x;
              const y2 = edge.target.y;
              const cpx1 = x1 + (x2 - x1) * 0.45;
              const cpx2 = x1 + (x2 - x1) * 0.55;
              const pathData = `M ${x1} ${y1} C ${cpx1} ${y1}, ${cpx2} ${y2}, ${x2} ${y2}`;

              return (
                <path
                  key={edge.id}
                  d={pathData}
                  fill="none"
                  stroke="#94A3B8"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              );
            })}

            {/* Mind Map Nodes */}
            {positionedNodes.map((node) => {
              const isSelected = selectedNodeId === node.id;
              const style = getCategoryStyles(node.category, isSelected);
              const topY = node.y - node.height / 2;
              const [line1, line2] = splitLabelToLines(node.label);

              return (
                <g
                  key={node.id}
                  data-node-interactive="true"
                  transform={`translate(${node.x}, ${topY})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNodeId(node.id);
                    // Leaf node clicked: pop up detail modal!
                    if (!node.hasChildren) {
                      setDetailNode(node);
                      setDetailNotesText(node.notes || '');
                      setIsEditingNotesInDetail(false);
                    }
                  }}
                  onDoubleClick={(e) => handleStartEdit(node, e)}
                  className="cursor-pointer"
                >
                  {/* Node Box */}
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={9}
                    ry={9}
                    fill={style.fill}
                    stroke={style.stroke}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                  />

                  {/* Category level subtitle */}
                  <text
                    x={12}
                    y={16}
                    fill={style.subFill}
                    fontSize={10}
                    fontWeight={600}
                    fontFamily="Public Sans, sans-serif"
                  >
                    {style.subLabel}
                  </text>

                  {/* Multi-line Label (Line 1) */}
                  <text
                    x={12}
                    y={line2 ? 33 : 38}
                    fill={style.textFill}
                    fontSize={12.5}
                    fontWeight={600}
                    fontFamily="Plus Jakarta Sans, sans-serif"
                  >
                    {line1}
                  </text>

                  {/* Multi-line Label (Line 2 if text is longer) */}
                  {line2 && (
                    <text
                      x={12}
                      y={49}
                      fill={style.textFill}
                      fontSize={12}
                      fontWeight={600}
                      fontFamily="Plus Jakarta Sans, sans-serif"
                    >
                      {line2}
                    </text>
                  )}

                  {/* Collapse/Expand Toggle Button */}
                  {node.hasChildren && (
                    <g
                      onClick={(e) => handleToggleCollapse(node.id, e)}
                      transform={`translate(${node.width - 24}, ${
                        node.height / 2 - 9
                      })`}
                    >
                      <rect
                        width={18}
                        height={18}
                        rx={5}
                        fill={node.category === 'root' ? '#334155' : '#E2E8F0'}
                      />
                      <text
                        x={9}
                        y={13}
                        textAnchor="middle"
                        fill={node.category === 'root' ? '#F8FAFC' : '#1E293B'}
                        fontSize={11}
                        fontWeight={700}
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {node.collapsed ? '+' : '−'}
                      </text>
                    </g>
                  )}

                  {/* Leaf Node "詳情 ⤢" indicator badge */}
                  {!node.hasChildren && node.id !== 'root' && (
                    <g
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(node.id);
                        setDetailNode(node);
                        setDetailNotesText(node.notes || '');
                        setIsEditingNotesInDetail(false);
                      }}
                      transform={`translate(${node.width - 44}, 6)`}
                      className="opacity-75 hover:opacity-100 transition-opacity"
                    >
                      <rect
                        width={36}
                        height={15}
                        rx={3.5}
                        fill={style.subFill}
                        fillOpacity={0.16}
                      />
                      <text
                        x={18}
                        y={11}
                        textAnchor="middle"
                        fill={style.subFill}
                        fontSize={9}
                        fontWeight={700}
                        fontFamily="Plus Jakarta Sans, sans-serif"
                      >
                        詳情 ⤢
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Selected Node Details Bar */}
        {selectedNodeId && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2 px-3 py-1.5 bg-white/95 backdrop-blur border border-slate-200 rounded-lg text-xs text-slate-600 shadow-xs">
            <span className="font-semibold text-slate-900 truncate max-w-[200px]">
              {nodes.find((n) => n.id === selectedNodeId)?.label || '已選節點'}
            </span>
            {nodes.find((n) => n.id === selectedNodeId)?.notes && (
              <span className="text-slate-400 text-[11px] truncate max-w-[180px]">
                ({nodes.find((n) => n.id === selectedNodeId)?.notes})
              </span>
            )}
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <button
              onClick={() => {
                const target =
                  positionedNodes.find((n) => n.id === selectedNodeId) ||
                  nodes.find((n) => n.id === selectedNodeId);
                if (target) {
                  const pNode: PositionedNode =
                    (target as any).hasChildren !== undefined
                      ? (target as PositionedNode)
                      : {
                          ...target,
                          x: 0,
                          y: 0,
                          depth: 1,
                          width: NODE_WIDTH,
                          height: NODE_HEIGHT,
                          hasChildren: false,
                        };
                  setDetailNode(pNode);
                  setDetailNotesText(target.notes || '');
                  setIsEditingNotesInDetail(false);
                }
              }}
              className="flex items-center gap-1 text-blue-600 hover:text-blue-800 font-semibold whitespace-nowrap"
              title="查看此卡片詳細資訊與決策背景"
            >
              <Info className="w-3.5 h-3.5" />
              <span>詳細資訊</span>
            </button>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <button
              onClick={() => {
                const target = nodes.find((n) => n.id === selectedNodeId);
                if (target) handleStartEdit(target);
              }}
              className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium whitespace-nowrap"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>編輯</span>
            </button>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <button
              onClick={() => handleAddChildNode(selectedNodeId)}
              className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新增子節點</span>
            </button>
            {selectedNodeId !== 'root' && (
              <>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <button
                  onClick={() => handleDeleteNode(selectedNodeId)}
                  className="flex items-center gap-1 text-red-600 hover:text-red-700 font-medium whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>刪除</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* Bottom-right Zoom & Pan Controls */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 p-1 bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow-xs">
          <button
            onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
            title="縮小"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="px-2 text-xs font-mono-tabular text-slate-700">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(2.0, +(z + 0.1).toFixed(2)))}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
            title="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetView}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
            title="置中重設視角"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Leaf Node Detailed Information Modal */}
        {detailNode && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setDetailNode(null)}
          >
            <div
              className="bg-white rounded-xl shadow-2xl border border-slate-200 max-w-lg w-full overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="flex items-start justify-between p-4 border-b border-slate-100 bg-slate-50/70">
                <div className="space-y-1.5 min-w-0 pr-2">
                  {/* Breadcrumb Hierarchy Path */}
                  <div className="flex items-center gap-1 text-[11px] text-slate-500 font-medium flex-wrap">
                    {getNodeBreadcrumbPath(detailNode.id).map((step, idx, arr) => (
                      <React.Fragment key={step.id}>
                        <span
                          className={
                            idx === arr.length - 1
                              ? 'font-bold text-blue-700'
                              : 'text-slate-600'
                          }
                        >
                          {step.label}
                        </span>
                        {idx < arr.length - 1 && (
                          <span className="text-slate-300">/</span>
                        )}
                      </React.Fragment>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                        detailNode.category === 'decision'
                          ? 'bg-blue-100 text-blue-800'
                          : detailNode.category === 'action'
                          ? 'bg-amber-100 text-amber-800'
                          : detailNode.category === 'detail'
                          ? 'bg-slate-100 text-slate-700'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {detailNode.category === 'decision'
                        ? '關鍵決策 (Level 3)'
                        : detailNode.category === 'action'
                        ? '待執行項目 (Level 3)'
                        : detailNode.category === 'detail'
                        ? '補充細節 (Level 3)'
                        : '核心主幹'}
                    </span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500">
                      末端節點 (卡片詳細資訊)
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => setDetailNode(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-lg transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                {/* Node Title */}
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">
                    節點主題名稱
                  </label>
                  <div className="text-base font-bold text-slate-900 leading-snug">
                    {detailNode.label}
                  </div>
                </div>

                {/* Detailed Notes / Context */}
                <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <BookOpen className="w-3.5 h-3.5 text-blue-600" />
                      詳細補充與決策脈絡
                    </span>
                    {!isEditingNotesInDetail && (
                      <button
                        onClick={() => setIsEditingNotesInDetail(true)}
                        className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1"
                      >
                        <Edit3 className="w-3 h-3" />
                        編輯備忘
                      </button>
                    )}
                  </div>

                  {isEditingNotesInDetail ? (
                    <div className="space-y-2 pt-1">
                      <textarea
                        value={detailNotesText}
                        onChange={(e) => setDetailNotesText(e.target.value)}
                        placeholder="輸入此節點的詳細背景、決策細節或備忘..."
                        rows={3}
                        className="w-full text-xs p-2 bg-white border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-600 text-slate-800"
                        autoFocus
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setDetailNotesText(detailNode.notes || '');
                            setIsEditingNotesInDetail(false);
                          }}
                          className="px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded"
                        >
                          取消
                        </button>
                        <button
                          onClick={() => {
                            handleSaveDetailNotes(
                              detailNode.id,
                              detailNotesText
                            );
                            setIsEditingNotesInDetail(false);
                          }}
                          className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded font-medium"
                        >
                          儲存備忘
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-700 leading-relaxed font-normal">
                      {detailNode.notes ? (
                        detailNode.notes
                      ) : (
                        <span className="text-slate-400 italic">
                          本節點尚無額外補充筆記。可點擊右上角「編輯備忘」補充執行依據或技術細節。
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {/* Action Buttons Row */}
                <div className="flex items-center gap-2 pt-1 flex-wrap">
                  {onAddTodoFromNode && (
                    <button
                      onClick={() => {
                        onAddTodoFromNode(
                          detailNode.label,
                          detailNode.category === 'action' ? 'high' : 'medium'
                        );
                        setAddedTodoFeedback(true);
                        setTimeout(() => setAddedTodoFeedback(false), 2000);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-2xs"
                    >
                      <CheckSquare className="w-3.5 h-3.5" />
                      <span>
                        {addedTodoFeedback ? '已加入待辦清單 ✓' : '轉為行動待辦事項'}
                      </span>
                    </button>
                  )}

                  <button
                    onClick={() => handleCopyNodeInfo(detailNode)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
                  >
                    <Copy className="w-3.5 h-3.5 text-slate-500" />
                    <span>{copiedFeedback ? '已複製內容 ✓' : '複製節點內容'}</span>
                  </button>

                  <button
                    onClick={() => {
                      handleAddChildNode(detailNode.id);
                      setDetailNode(null);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5 text-slate-500" />
                    <span>延伸子分支</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
