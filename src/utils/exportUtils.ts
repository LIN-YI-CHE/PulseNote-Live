import { MeetingSession, MindMapNode } from '../types/meeting';

function buildMindMapMarkdownTree(
  nodes: MindMapNode[],
  parentId: string | null = null,
  depth = 0
): string {
  const children = nodes.filter((n) =>
    parentId === null
      ? n.parentId === null || n.parentId === 'NONE'
      : n.parentId === parentId
  );

  let result = '';
  for (const child of children) {
    const indent = '  '.repeat(depth);
    const noteSuffix = child.notes ? ` — *${child.notes}*` : '';
    result += `${indent}- **${child.label}**${noteSuffix}\n`;
    result += buildMindMapMarkdownTree(nodes, child.id, depth + 1);
  }
  return result;
}

export function generateMeetingMarkdown(session: MeetingSession): string {
  const lines: string[] = [];

  lines.push(`# ${session.title}`);
  lines.push(
    `建立時間：${session.createdAt} · 最後更新：${session.updatedAt} · 累計收音時長：${Math.floor(
      session.durationSeconds / 60
    )}分${session.durationSeconds % 60}秒`
  );
  lines.push('');

  if (session.sourceRecordingName) {
    lines.push(`來源錄音：${session.sourceRecordingName}`);
    lines.push(`重建狀態：${session.recoveryStatus === 'complete' ? '已完成整理' : '逐字稿已保留，待重試整理'}`);
    lines.push('');
  }

  lines.push('## 一、結構化會議重點與決策');
  if (session.notes.length === 0) {
    lines.push('_尚無會議重點摘要_');
  } else {
    for (const sec of session.notes) {
      lines.push(`### ${sec.topic}`);
      lines.push(sec.summary);
      if (sec.keyDecisions && sec.keyDecisions.length > 0) {
        lines.push('');
        lines.push('**關鍵決策：**');
        for (const dec of sec.keyDecisions) {
          lines.push(`- ${dec}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## 二、心智圖結構階層 (Mind Map)');
  if (session.mindMapNodes.length === 0) {
    lines.push('_尚無心智圖節點_');
  } else {
    const treeMd = buildMindMapMarkdownTree(session.mindMapNodes, null, 0);
    lines.push(treeMd || '_尚無心智圖節點_');
  }
  lines.push('');

  lines.push('## 三、待辦事項清單 (Action Items)');
  if (session.todos.length === 0) {
    lines.push('_尚無待辦事項_');
  } else {
    for (const todo of session.todos) {
      const check = todo.completed ? '[x]' : '[ ]';
      const priorityLabel =
        todo.priority === 'high'
          ? '高優先'
          : todo.priority === 'medium'
          ? '中優先'
          : '一般';
      const dueStr = todo.dueDate ? ` · 期限：${todo.dueDate}` : '';
      lines.push(
        `- ${check} **${todo.task}** （負責人：${todo.assignee} · 優先級：${priorityLabel}${dueStr}）`
      );
    }
  }
  lines.push('');

  lines.push('## 四、即時語音逐字稿紀錄');
  if (session.transcripts.length === 0) {
    lines.push('_尚無語音逐字稿_');
  } else {
    for (const tr of session.transcripts) {
      lines.push(`- \`[${tr.timestamp}]\` **${tr.speaker}**：${tr.text}`);
    }
  }

  return lines.join('\n');
}

export function downloadTextFile(
  content: string,
  filename: string,
  mimeType = 'text/markdown;charset=utf-8'
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
