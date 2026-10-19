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
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { MindMapNode } from '../types/meeting';

interface MindMapCanvasProps {
  nodes: MindMapNode[];
  onUpdateNodes: (nodes: MindMapNode[]) => void;
  meetingTitle: string;
}

interface PositionedNode extends MindMapNode {
  x: number;
  y: number;
  depth: number;
  width: number;
  height: number;
  hasChildren: boolean;
}

const NODE_WIDTH = 188;
const NODE_HEIGHT = 46;
const LEVEL_GAP_X = 250;
const SIBLING_GAP_Y = 66;

export const MindMapCanvas: React.FC<MindMapCanvasProps> = ({
  nodes,
  onUpdateNodes,
  meetingTitle,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState<number>(0.95);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 60, y: 240 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('root');
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState<string>('');
  const [editCategory, setEditCategory] =
    useState<MindMapNode['category']>('topic');

  // Compute deterministic tree layout
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

    // Normalize root node
    const rootNode =
      nodes.find((n) => n.id === 'root' || n.parentId === null || n.parentId === 'NONE') ||
      nodes[0];

    const childrenMap = new Map<string, MindMapNode[]>();
    for (const n of nodes) {
      if (n.id === rootNode.id) continue;
      const pid =
        !n.parentId || n.parentId === 'NONE' || !nodes.some((item) => item.id === n.parentId)
          ? rootNode.id
          : n.parentId;
      const list = childrenMap.get(pid) || [];
      list.push(n);
      childrenMap.set(pid, list);
    }

    const resultNodes: PositionedNode[] = [];
    let currentLeafY = 0;

    const traverse = (node: MindMapNode, depth: number): number => {
      const children = childrenMap.get(node.id) || [];
      const hasChildren = children.length > 0;
      const x = depth * LEVEL_GAP_X;

      if (!hasChildren || node.collapsed) {
        const y = currentLeafY;
        currentLeafY += SIBLING_GAP_Y;
        resultNodes.push({
          ...node,
          x,
          y,
          depth,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          hasChildren,
        });
        return y;
      }

      const childYs: number[] = [];
      for (const child of children) {
        childYs.push(traverse(child, depth + 1));
      }
      const y = (childYs[0] + childYs[childYs.length - 1]) / 2;
      resultNodes.push({
        ...node,
        x,
        y,
        depth,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        hasChildren,
      });
      return y;
    };

    const rootY = traverse(rootNode, 0);

    // Center the tree vertically around y = 0
    for (const pn of resultNodes) {
      pn.y -= rootY;
    }

    const posMap = new Map<string, PositionedNode>();
    for (const pn of resultNodes) {
      posMap.set(pn.id, pn);
    }

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

    let minX = 0;
    let maxX = 600;
    let minY = -200;
    let maxY = 200;

    if (resultNodes.length > 0) {
      minX = Math.min(...resultNodes.map((n) => n.x)) - 40;
      maxX = Math.max(...resultNodes.map((n) => n.x + n.width)) + 60;
      minY = Math.min(...resultNodes.map((n) => n.y - n.height / 2)) - 60;
      maxY = Math.max(...resultNodes.map((n) => n.y + n.height / 2)) + 60;
    }

    return {
      positionedNodes: resultNodes,
      edges: resultEdges,
      bounds: { minX, maxX, minY, maxY },
    };
  }, [nodes]);

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
    setZoom(0.95);
    setPan({ x: 60, y: 240 });
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
  };

  const handleSaveEdit = () => {
    if (!editingNodeId || !editLabel.trim()) return;
    onUpdateNodes(
      nodes.map((n) =>
        n.id === editingNodeId
          ? { ...n, label: editLabel.trim(), category: editCategory }
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
      label: '新分支節點',
      category: 'detail',
    };
    // Ensure parent is expanded
    const updated = nodes.map((n) =>
      n.id === targetParentId ? { ...n, collapsed: false } : n
    );
    onUpdateNodes([...updated, newNode]);
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditLabel('新分支節點');
    setEditCategory('detail');
  };

  const handleDeleteNode = (nodeId: string) => {
    if (nodeId === 'root') return;
    // Remove node and its descendants
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

  const handleExportSVG = () => {
    if (!svgRef.current) return;
    const width = Math.max(800, bounds.maxX - bounds.minX);
    const height = Math.max(500, bounds.maxY - bounds.minY);
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
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meetingTitle || 'mindmap'}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportPNG = () => {
    if (!svgRef.current) return;
    const width = Math.max(900, bounds.maxX - bounds.minX);
    const height = Math.max(560, bounds.maxY - bounds.minY);
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
        fill: '#1E293B',
        stroke: isSelected ? '#2563EB' : '#0F172A',
        textFill: '#FFFFFF',
        subLabel: '主題核心',
        subFill: '#94A3B8',
      };
    }
    if (category === 'decision') {
      return {
        fill: '#EFF6FF',
        stroke: isSelected ? '#2563EB' : '#93C5FD',
        textFill: '#1E3A8A',
        subLabel: '關鍵決策',
        subFill: '#2563EB',
      };
    }
    if (category === 'action') {
      return {
        fill: '#FEF3C7',
        stroke: isSelected ? '#D97706' : '#FCD34D',
        textFill: '#78350F',
        subLabel: '行動項目',
        subFill: '#B45309',
      };
    }
    if (category === 'topic') {
      return {
        fill: '#FFFFFF',
        stroke: isSelected ? '#2563EB' : '#CBD5E1',
        textFill: '#0F172A',
        subLabel: '討論主軸',
        subFill: '#475569',
      };
    }
    return {
      fill: '#F8FAFC',
      stroke: isSelected ? '#2563EB' : '#CBD5E1',
      textFill: '#334155',
      subLabel: '重點細節',
      subFill: '#64748B',
    };
  };

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC] select-none relative overflow-hidden">
      {/* Column Header & Canvas Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 whitespace-nowrap">
            02. 互動式心智圖脈絡
          </h2>
          <span className="text-xs text-slate-400" aria-hidden="true">
            ·
          </span>
          <span className="text-xs text-slate-500 font-mono-tabular whitespace-nowrap">
            {nodes.length} 節點
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => handleAddChildNode()}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
            title="在目前選取的節點下新增子節點"
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

          <button
            onClick={handleExportSVG}
            className="px-2 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors whitespace-nowrap shrink-0"
            title="下載向量 SVG 圖檔"
          >
            SVG
          </button>
        </div>
      </div>

      {/* Inline Node Editor Bar (shown when editing or selecting a node) */}
      {editingNodeId && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 bg-blue-50/80 border-b border-blue-200 shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs font-medium text-blue-900 whitespace-nowrap">
              編輯節點：
            </span>
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveEdit();
                if (e.key === 'Escape') setEditingNodeId(null);
              }}
              className="flex-1 min-w-0 px-2.5 py-1 text-xs bg-white border border-blue-300 rounded text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              placeholder="輸入節點名稱..."
              autoFocus
            />
            <select
              value={editCategory}
              onChange={(e) =>
                setEditCategory(e.target.value as MindMapNode['category'])
              }
              className="px-2 py-1 text-xs bg-white border border-blue-300 rounded text-slate-700 focus:outline-none"
            >
              <option value="topic">討論主軸</option>
              <option value="decision">關鍵決策</option>
              <option value="action">行動項目</option>
              <option value="detail">重點細節</option>
            </select>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleSaveEdit}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors whitespace-nowrap"
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
        {/* Subtle structural dot matrix background */}
        <div
          className="absolute inset-0 pointer-events-none opacity-45"
          style={{
            backgroundImage:
              'radial-gradient(#CBD5E1 1px, transparent 1px)',
            backgroundSize: '20px 20px',
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
                  strokeWidth={1.75}
                  strokeLinecap="round"
                />
              );
            })}

            {/* Mind Map Nodes */}
            {positionedNodes.map((node) => {
              const isSelected = selectedNodeId === node.id;
              const style = getCategoryStyles(node.category, isSelected);
              const topY = node.y - node.height / 2;
              const displayLabel =
                node.label.length > 13
                  ? node.label.slice(0, 12) + '…'
                  : node.label;

              return (
                <g
                  key={node.id}
                  data-node-interactive="true"
                  transform={`translate(${node.x}, ${topY})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNodeId(node.id);
                  }}
                  onDoubleClick={(e) => handleStartEdit(node, e)}
                  className="cursor-pointer"
                >
                  {/* Node Box */}
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={8}
                    ry={8}
                    fill={style.fill}
                    stroke={style.stroke}
                    strokeWidth={isSelected ? 2 : 1.25}
                  />

                  {/* Subtle category label */}
                  <text
                    x={12}
                    y={15}
                    fill={style.subFill}
                    fontSize={9.5}
                    fontWeight={600}
                    fontFamily="Public Sans, sans-serif"
                  >
                    {style.subLabel}
                  </text>

                  {/* Node Primary Title */}
                  <text
                    x={12}
                    y={33}
                    fill={style.textFill}
                    fontSize={12.5}
                    fontWeight={600}
                    fontFamily="Plus Jakarta Sans, sans-serif"
                  >
                    {displayLabel}
                  </text>

                  {/* Collapse/Expand Toggle Button if node has children */}
                  {node.hasChildren && (
                    <g
                      onClick={(e) => handleToggleCollapse(node.id, e)}
                      transform={`translate(${node.width - 22}, ${
                        node.height / 2 - 8
                      })`}
                    >
                      <rect
                        width={16}
                        height={16}
                        rx={4}
                        fill={node.category === 'root' ? '#334155' : '#E2E8F0'}
                      />
                      <text
                        x={8}
                        y={11.5}
                        textAnchor="middle"
                        fill={node.category === 'root' ? '#F8FAFC' : '#334155'}
                        fontSize={10}
                        fontWeight={700}
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {node.collapsed ? '+' : '−'}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Bottom-left Selected Node Quick Actions */}
        {selectedNodeId && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2 px-3 py-1.5 bg-white/95 backdrop-blur border border-slate-200 rounded-lg text-xs text-slate-600 shadow-xs">
            <span className="font-medium text-slate-900 truncate max-w-[160px]">
              {nodes.find((n) => n.id === selectedNodeId)?.label || '已選節點'}
            </span>
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
              <span>編輯文字</span>
            </button>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <button
              onClick={() => handleAddChildNode(selectedNodeId)}
              className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新增子分支</span>
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
            onClick={() => setZoom((z) => Math.max(0.45, +(z - 0.1).toFixed(2)))}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
            title="縮小畫布"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="px-2 text-xs font-mono-tabular text-slate-700">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(2.0, +(z + 0.1).toFixed(2)))}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
            title="放大畫布"
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
      </div>
    </div>
  );
};
