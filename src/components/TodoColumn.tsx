import React, { useState } from 'react';
import {
  CheckSquare,
  Square,
  Plus,
  Trash2,
  Edit3,
  Check,
  X,
  ListChecks,
} from 'lucide-react';
import { TodoItem } from '../types/meeting';

interface TodoColumnProps {
  todos: TodoItem[];
  onUpdateTodos: (todos: TodoItem[]) => void;
}

export const TodoColumn: React.FC<TodoColumnProps> = ({
  todos,
  onUpdateTodos,
}) => {
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [newTask, setNewTask] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newPriority, setNewPriority] = useState<TodoItem['priority']>('medium');
  const [newDueDate, setNewDueDate] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTask, setEditTask] = useState('');
  const [editAssignee, setEditAssignee] = useState('');
  const [editPriority, setEditPriority] =
    useState<TodoItem['priority']>('medium');
  const [editDueDate, setEditDueDate] = useState('');

  const filteredTodos = todos.filter((t) => {
    if (filter === 'pending') return !t.completed;
    if (filter === 'completed') return t.completed;
    return true;
  });

  const pendingCount = todos.filter((t) => !t.completed).length;
  const completedCount = todos.filter((t) => t.completed).length;

  const handleToggleTodo = (id: string) => {
    onUpdateTodos(
      todos.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
    );
  };

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    const item: TodoItem = {
      id: `todo-${Date.now().toString().slice(-5)}`,
      task: newTask.trim(),
      assignee: newAssignee.trim() || '待指派',
      priority: newPriority,
      dueDate: newDueDate.trim() || undefined,
      completed: false,
      createdAt: new Date().toLocaleTimeString('zh-TW', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    onUpdateTodos([item, ...todos]);
    setNewTask('');
    setNewAssignee('');
    setNewDueDate('');
  };

  const handleStartEdit = (todo: TodoItem) => {
    setEditingId(todo.id);
    setEditTask(todo.task);
    setEditAssignee(todo.assignee);
    setEditPriority(todo.priority);
    setEditDueDate(todo.dueDate || '');
  };

  const handleSaveEdit = () => {
    if (!editingId || !editTask.trim()) return;
    onUpdateTodos(
      todos.map((t) =>
        t.id === editingId
          ? {
              ...t,
              task: editTask.trim(),
              assignee: editAssignee.trim() || '待指派',
              priority: editPriority,
              dueDate: editDueDate.trim() || undefined,
            }
          : t
      )
    );
    setEditingId(null);
  };

  const handleDeleteTodo = (id: string) => {
    onUpdateTodos(todos.filter((t) => t.id !== id));
  };

  const getPriorityMeta = (priority: TodoItem['priority']) => {
    if (priority === 'high') {
      return { label: '高優先', textClass: 'text-red-600 font-semibold' };
    }
    if (priority === 'medium') {
      return { label: '中優先', textClass: 'text-amber-600 font-medium' };
    }
    return { label: '一般', textClass: 'text-slate-500' };
  };

  return (
    <div className="flex flex-col h-full bg-white border-l border-slate-200 overflow-hidden">
      {/* Column Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 whitespace-nowrap">
            03. 待辦事項清單
          </h2>
          <span className="text-xs text-slate-400" aria-hidden="true">
            ·
          </span>
          <span className="text-xs text-slate-500 font-mono-tabular whitespace-nowrap">
            {pendingCount} 待辦 / {completedCount} 完成
          </span>
        </div>
      </div>

      {/* Interactive Filter Segmented Control */}
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            onClick={() => setFilter('all')}
            className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              filter === 'all'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            全部 ({todos.length})
          </button>
          <button
            onClick={() => setFilter('pending')}
            className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              filter === 'pending'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            待處理 ({pendingCount})
          </button>
          <button
            onClick={() => setFilter('completed')}
            className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              filter === 'completed'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            已完成 ({completedCount})
          </button>
        </div>
      </div>

      {/* Quick Add Action Item Form */}
      <form
        onSubmit={handleAddTodo}
        className="p-3 bg-white border-b border-slate-200 space-y-2 shrink-0"
      >
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="新增待辦事項或行動決議..."
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded text-slate-900 focus:outline-none focus:border-blue-600"
          />
          <button
            type="submit"
            disabled={!newTask.trim()}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={newAssignee}
            onChange={(e) => setNewAssignee(e.target.value)}
            placeholder="負責人 (例: 林建宏)"
            className="w-28 px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-600"
          />
          <select
            value={newPriority}
            onChange={(e) =>
              setNewPriority(e.target.value as TodoItem['priority'])
            }
            className="px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none"
          >
            <option value="high">高優先</option>
            <option value="medium">中優先</option>
            <option value="low">一般</option>
          </select>
          <input
            type="text"
            value={newDueDate}
            onChange={(e) => setNewDueDate(e.target.value)}
            placeholder="期限 (例: 本週五)"
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-600"
          />
        </div>
      </form>

      {/* Action Items List */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {filteredTodos.length === 0 ? (
          <div className="py-10 px-4 text-center">
            <ListChecks className="w-6 h-6 text-slate-400 mx-auto mb-2" />
            <p className="text-xs text-slate-600 mb-1">目前沒有符合的待辦事項</p>
            <p className="text-xs text-slate-400">
              當會議中提到負責人與任務時，Gemini 3.8 Live 會自動在此建立行動項目。
            </p>
          </div>
        ) : (
          filteredTodos.map((todo) => {
            const pMeta = getPriorityMeta(todo.priority);

            if (editingId === todo.id) {
              return (
                <div key={todo.id} className="p-3 bg-slate-50 space-y-2">
                  <input
                    type="text"
                    value={editTask}
                    onChange={(e) => setEditTask(e.target.value)}
                    className="w-full px-2.5 py-1 text-xs bg-white border border-slate-300 rounded text-slate-900"
                  />
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={editAssignee}
                      onChange={(e) => setEditAssignee(e.target.value)}
                      placeholder="負責人"
                      className="w-24 px-2 py-1 text-xs bg-white border border-slate-300 rounded text-slate-700"
                    />
                    <select
                      value={editPriority}
                      onChange={(e) =>
                        setEditPriority(e.target.value as TodoItem['priority'])
                      }
                      className="px-2 py-1 text-xs bg-white border border-slate-300 rounded text-slate-700"
                    >
                      <option value="high">高優先</option>
                      <option value="medium">中優先</option>
                      <option value="low">一般</option>
                    </select>
                    <input
                      type="text"
                      value={editDueDate}
                      onChange={(e) => setEditDueDate(e.target.value)}
                      placeholder="期限"
                      className="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-slate-300 rounded text-slate-700"
                    />
                  </div>
                  <div className="flex justify-end gap-1.5">
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded"
                    >
                      <Check className="w-3 h-3" />
                      <span>儲存</span>
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={todo.id}
                className="group px-4 py-3 hover:bg-slate-50/80 transition-colors flex items-start gap-2.5"
              >
                <button
                  onClick={() => handleToggleTodo(todo.id)}
                  className="mt-0.5 text-slate-400 hover:text-blue-600 transition-colors shrink-0"
                  title={todo.completed ? '標記為未完成' : '標記為已完成'}
                >
                  {todo.completed ? (
                    <CheckSquare className="w-4 h-4 text-blue-600" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <p
                    className={`text-xs leading-snug ${
                      todo.completed
                        ? 'line-through text-slate-400'
                        : 'text-slate-900 font-medium'
                    }`}
                  >
                    {todo.task}
                  </p>

                  {/* Zero-Pill Unboxed Metadata with Typographic Separators */}
                  <div className="flex items-center flex-wrap gap-1.5 mt-1 text-[11px] text-slate-500">
                    <span className="text-slate-700 font-medium">
                      {todo.assignee}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className={pMeta.textClass}>{pMeta.label}</span>
                    {todo.dueDate && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono-tabular">
                          期限 {todo.dueDate}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={() => handleStartEdit(todo)}
                    className="p-1 text-slate-400 hover:text-blue-600 rounded"
                    title="編輯待辦"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteTodo(todo.id)}
                    className="p-1 text-slate-400 hover:text-red-600 rounded"
                    title="刪除待辦"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
