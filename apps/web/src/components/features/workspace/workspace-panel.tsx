import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Folder, FileText, ChevronRight, ChevronDown, RefreshCw, Image as ImageIcon, FileCode, Save, X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'
import { MonacoEditor } from '~/components/ui/monaco-editor'
import { toast } from 'react-hot-toast'

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modifiedAt?: number
  children?: TreeNode[]
}

function getFileIcon(name: string) {
  if (/\.(py|js|ts|jsx|tsx|java|go|rs|c|cpp|h|php|rb|sh|bash|zsh)$/.test(name)) return <FileCode size={14} className="text-[#d4a843]" />
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(name)) return <ImageIcon size={14} className="text-[#c084fc]" />
  if (/\.(md|txt|log|json|xml|yaml|yml|csv|html|css)$/.test(name)) return <FileText size={14} className="text-[#6b9fff]" />
  return <FileText size={14} className="text-[#9099ac]" />
}

function formatSize(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

interface FileTreeNodeProps {
  node: TreeNode
  level: number
  selectedPath: string | null
  onSelectFile: (path: string) => void
  expandedDirs: Set<string>
  onToggleDir: (path: string) => void
}

function FileTreeNode({ node, level, selectedPath, onSelectFile, expandedDirs, onToggleDir }: FileTreeNodeProps) {
  const isExpanded = expandedDirs.has(node.path)

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => onToggleDir(node.path)}
          className={cn(
            'flex items-center gap-1 w-full text-left px-2 py-1 rounded-md text-xs transition-colors',
            'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]',
          )}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={14} className="text-[#d4a843] shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded && node.children && (
          <div>
            {node.children.map(child => (
              <FileTreeNode
                key={child.path}
                node={child}
                level={level + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelectFile(node.path)}
      className={cn(
        'flex items-center gap-1.5 w-full text-left px-2 py-1 rounded-md text-xs transition-colors',
        selectedPath === node.path
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'hover:bg-[var(--bg-hover)] text-[var(--text-muted)]',
      )}
      style={{ paddingLeft: `${level * 12 + 24}px` }}
    >
      {getFileIcon(node.name)}
      <span className="truncate">{node.name}</span>
      {node.size != null && (
        <span className="ml-auto text-[10px] text-[var(--text-muted)] opacity-60 shrink-0">
          {formatSize(node.size)}
        </span>
      )}
    </button>
  )
}

interface WorkspacePanelProps {
  sessionId: string
}

function buildDataUrl(mime: string | undefined, content: string | undefined): string {
  if (!content) return ''
  return `data:${mime ?? 'image/png'};base64,${content}`
}

function ImageViewer({ name, mime, content, size }: { name: string; mime?: string; content: string; size?: number }) {
  const [zoomed, setZoomed] = useState(false)
  const [scale, setScale] = useState(1)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const dataUrl = buildDataUrl(mime, content)

  const closeZoom = useCallback(() => {
    setZoomed(false)
    setScale(1)
  }, [])

  useEffect(() => {
    if (!zoomed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeZoom()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed, closeZoom])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border)] bg-[var(--bg-base)] text-[10px] text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text-secondary)]">{name}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}px</span>}
        {size != null && <span>{formatSize(size)}</span>}
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4"
        style={{
          backgroundColor: 'var(--bg-base)',
          backgroundImage:
            'linear-gradient(45deg, var(--border) 25%, transparent 25%), linear-gradient(-45deg, var(--border) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--border) 75%), linear-gradient(-45deg, transparent 75%, var(--border) 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          opacity: 1,
        }}
      >
        <img
          src={dataUrl}
          alt={name}
          onClick={() => setZoomed(true)}
          onLoad={e => {
            const img = e.currentTarget
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
          }}
          className="max-w-full max-h-full object-contain cursor-zoom-in transition-transform hover:opacity-90"
          style={{ imageRendering: 'auto' }}
        />
      </div>
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-[var(--border)] bg-[var(--bg-base)]">
        <span className="text-[10px] text-[var(--text-placeholder)]">点击图片查看大图</span>
        <button
          onClick={() => setZoomed(true)}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <Maximize2 size={11} />
          放大
        </button>
      </div>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={closeZoom}
        >
          <div
            className="absolute top-3 right-3 flex items-center gap-1 z-10"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setScale(s => Math.max(0.2, s - 0.25))}
              className="p-2 rounded-md bg-white/10 text-white hover:bg-white/20 transition-colors"
              title="缩小"
            >
              <ZoomOut size={16} />
            </button>
            <span className="px-2 py-1 text-xs text-white/80 font-mono min-w-[3rem] text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale(s => Math.min(8, s + 0.25))}
              className="p-2 rounded-md bg-white/10 text-white hover:bg-white/20 transition-colors"
              title="放大"
            >
              <ZoomIn size={16} />
            </button>
            <button
              onClick={() => setScale(1)}
              className="px-2 py-1.5 rounded-md bg-white/10 text-white hover:bg-white/20 transition-colors text-xs"
              title="重置"
            >
              1:1
            </button>
            <button
              onClick={closeZoom}
              className="p-2 rounded-md bg-white/10 text-white hover:bg-white/20 transition-colors ml-1"
              title="关闭 (Esc)"
            >
              <X size={16} />
            </button>
          </div>
          <img
            src={dataUrl}
            alt={name}
            onClick={e => e.stopPropagation()}
            className="max-w-none transition-transform"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'center center',
              maxWidth: '90vw',
              maxHeight: '90vh',
              objectFit: 'contain',
            }}
          />
        </div>
      )}
    </div>
  )
}

export function WorkspacePanel({ sessionId }: WorkspacePanelProps) {
  const queryClient = useQueryClient()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [editedContent, setEditedContent] = useState<string | null>(null)

  const {
    data: treeData,
    isLoading: treeLoading,
    refetch: refetchTree,
  } = useQuery({
    queryKey: ['workspace-tree', sessionId],
    queryFn: () => api.workspace.tree(sessionId),
    refetchInterval: 5000,
  })

  const {
    data: fileData,
    isLoading: fileLoading,
  } = useQuery({
    queryKey: ['workspace-file', sessionId, selectedPath],
    queryFn: () => api.workspace.file(sessionId, selectedPath!),
    enabled: !!selectedPath,
  })

  const writeMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.workspace.write(sessionId, path, content),
    onSuccess: () => {
      toast.success('文件已保存')
      queryClient.invalidateQueries({ queryKey: ['workspace-file', sessionId, selectedPath] })
      queryClient.invalidateQueries({ queryKey: ['workspace-tree', sessionId] })
      setEditedContent(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path)
    setEditedContent(null)
  }, [])

  const handleSave = useCallback(() => {
    if (selectedPath && editedContent != null) {
      writeMutation.mutate({ path: selectedPath, content: editedContent })
    }
  }, [selectedPath, editedContent, writeMutation])

  const isDirty = editedContent != null && editedContent !== (fileData?.content ?? '')
  const tree = treeData?.tree ?? []

  return (
    <div className="flex h-full min-h-0">
      {/* File tree sidebar */}
      <div className="flex flex-col w-[45%] min-w-[180px] max-w-[280px] border-r border-[var(--border)] bg-[var(--bg-base)]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
          <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">工作目录</span>
          <button
            onClick={() => refetchTree()}
            className="p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
            title="刷新"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {treeLoading ? (
            <div className="flex items-center justify-center h-20 text-[var(--text-muted)] text-xs">
              加载中...
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[var(--text-muted)] text-xs gap-2">
              <Folder size={24} className="opacity-30" />
              <span>暂无文件</span>
              <span className="text-[10px] opacity-50">Agent 执行后会在此生成脚本和报告</span>
            </div>
          ) : (
            tree.map(node => (
              <FileTreeNode
                key={node.path}
                node={node}
                level={0}
                selectedPath={selectedPath}
                onSelectFile={handleSelectFile}
                expandedDirs={expandedDirs}
                onToggleDir={toggleDir}
              />
            ))
          )}
        </div>
      </div>

      {/* File viewer / editor */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg-surface)]">
        {!selectedPath ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-3">
            <FileText size={32} className="opacity-20" />
            <span className="text-xs">选择文件以查看内容</span>
          </div>
        ) : fileLoading ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-xs">
            加载文件中...
          </div>
        ) : fileData?.isImage && fileData.content ? (
          <ImageViewer
            name={fileData.name ?? selectedPath}
            mime={fileData.mime}
            content={fileData.content}
            size={fileData.size}
          />
        ) : fileData?.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-3">
            <ImageIcon size={32} className="opacity-20" />
            <span className="text-xs">二进制文件</span>
            <span className="text-[10px] opacity-50">{formatSize(fileData?.size)}</span>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-base)]">
              <div className="flex items-center gap-2 min-w-0">
                {getFileIcon(fileData?.name ?? '')}
                <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                  {fileData?.name ?? selectedPath}
                </span>
                {isDirty && (
                  <span className="text-[10px] text-[#d4a843] font-medium">已修改</span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                  {fileData?.size != null && <span>{formatSize(fileData.size)}</span>}
                  {fileData?.modifiedAt && (
                    <span>{new Date(fileData.modifiedAt).toLocaleString('zh-CN')}</span>
                  )}
                </div>
                <button
                  onClick={handleSave}
                  disabled={!isDirty || writeMutation.isPending}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
                    isDirty
                      ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90'
                      : 'bg-[var(--bg-hover)] text-[var(--text-muted)] cursor-not-allowed',
                  )}
                  title="Ctrl+S 保存"
                >
                  <Save size={10} />
                  {writeMutation.isPending ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 relative">
              <div className="absolute inset-0">
                <MonacoEditor
                  key={selectedPath}
                  value={editedContent ?? (fileData?.content ?? '')}
                  filename={fileData?.name ?? selectedPath}
                  onChange={setEditedContent}
                  onSave={handleSave}
                  className="h-full"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
