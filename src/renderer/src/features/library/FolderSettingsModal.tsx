import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryFolder, UpdateFolderInput } from '../../../../shared/contracts'
import { formatGlossaryLines, parseGlossaryLines } from '../../../../shared/glossary-text'
import { RESEARCH_TRACK_OPTIONS, getTrackById } from '../../../../shared/research-onboarding'

function buildDescendantSet(folderId: string, allFolders: readonly LibraryFolder[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const f of allFolders) {
    if (!f.parentId) continue
    const list = children.get(f.parentId)
    if (list) list.push(f.id)
    else children.set(f.parentId, [f.id])
  }
  const blocked = new Set<string>([folderId])
  const queue = [folderId]
  while (queue.length > 0) {
    const curr = queue.shift()!
    for (const childId of children.get(curr) ?? []) {
      if (blocked.has(childId)) continue
      blocked.add(childId)
      queue.push(childId)
    }
  }
  return blocked
}

function flattenFolderOptions(
  allFolders: readonly LibraryFolder[],
  blockedIds: Set<string>
): Array<{ id: string; label: string }> {
  const byParent = new Map<string | null, LibraryFolder[]>()
  for (const f of allFolders) {
    const key = f.parentId ?? null
    const list = byParent.get(key)
    if (list) list.push(f)
    else byParent.set(key, [f])
  }
  const out: Array<{ id: string; label: string }> = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      if (blockedIds.has(folder.id)) continue
      const indent = depth > 0 ? `${'　'.repeat(depth)}└ ` : ''
      out.push({ id: folder.id, label: `${indent}${folder.name}` })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export interface FolderSettingsModalProps {
  open: boolean
  folder: LibraryFolder | null
  allFolders: readonly LibraryFolder[]
  onClose(): void
  onSave(input: UpdateFolderInput): Promise<LibraryFolder | null>
  onDelete(folderId: string): Promise<boolean>
  onExportFolder?(folderId: string): void
}

export function FolderSettingsModal({
  open,
  folder,
  allFolders,
  onClose,
  onSave,
  onDelete,
  onExportFolder
}: FolderSettingsModalProps): React.JSX.Element | null {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<string | null>(null)
  const [contextSummary, setContextSummary] = useState('')
  const [glossaryText, setGlossaryText] = useState('')
  const [inheritGlobal, setInheritGlobal] = useState(false)
  const [templateTrackId, setTemplateTrackId] = useState<string>(RESEARCH_TRACK_OPTIONS[0]?.id ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initializedFolderIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open || !folder) {
      initializedFolderIdRef.current = null
      return
    }
    // 后台 refresh() 会生成新 folder 对象引用；同一分类打开期间不能覆盖用户正在编辑的表单值
    if (initializedFolderIdRef.current === folder.id) return
    initializedFolderIdRef.current = folder.id
    setName(folder.name)
    setParentId(folder.parentId)
    setContextSummary(folder.contextSummary)
    setGlossaryText(formatGlossaryLines(folder.glossary))
    setInheritGlobal(folder.inheritGlobalGlossary)
    setConfirmDelete(false)
    setBusy(false)
    setError(null)
  }, [open, folder])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  const parentOptions = useMemo(() => {
    if (!folder) return []
    const blocked = buildDescendantSet(folder.id, allFolders)
    return flattenFolderOptions(allFolders, blocked)
  }, [folder, allFolders])

  if (!open || !folder) return null

  const parsedEntries = parseGlossaryLines(glossaryText)

  const handleAppendTemplate = (): void => {
    const track = getTrackById(templateTrackId)
    if (!track) return
    const existing = parseGlossaryLines(glossaryText)
    const seen = new Set(existing.map(item => item.source.toLowerCase()))
    const merged = [...existing]
    for (const item of track.starterGlossary) {
      if (seen.has(item.source.toLowerCase()) || merged.length >= 200) continue
      seen.add(item.source.toLowerCase())
      merged.push(item)
    }
    setGlossaryText(formatGlossaryLines(merged))
    if (!contextSummary.trim()) {
      setContextSummary(`${track.name}（${track.summary}）`.slice(0, 300))
    }
  }

  const handleSubmit = async (): Promise<void> => {
    if (busy) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('分类名称不能为空。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const updated = await onSave({
        id: folder.id,
        name: trimmedName,
        parentId,
        contextSummary: contextSummary.trim(),
        glossary: parsedEntries,
        inheritGlobalGlossary: inheritGlobal
      })
      if (updated) {
        onClose()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const ok = await onDelete(folder.id)
      if (ok) onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="folder-modal-backdrop" role="presentation">
      <div
        className="folder-modal"
        data-testid="folder-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-settings-title"
      >
        <div className="folder-modal__header">
          <div>
            <div className="folder-modal__eyebrow">Zotero 分类与专属术语表隔离</div>
            <h3 id="folder-settings-title">分类设置：{folder.name}</h3>
          </div>
          <button
            type="button"
            className="folder-modal__close"
            aria-label="关闭分类设置"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="folder-modal__body">
          <div className="folder-modal__row">
            <label className="folder-modal__field">
              <span className="folder-modal__label">分类名称</span>
              <input
                type="text"
                data-testid="folder-settings-name"
                value={name}
                maxLength={64}
                onChange={event => setName(event.target.value)}
              />
            </label>
            <label className="folder-modal__field">
              <span className="folder-modal__label">上级分类（最多 4 级）</span>
              <select
                value={parentId ?? ''}
                onChange={event => setParentId(event.target.value || null)}
              >
                <option value="">顶级分类（无上级）</option>
                {parentOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="folder-modal__field">
            <span className="folder-modal__label">从学科模板一键追加初始术语</span>
            <div className="folder-modal__template-row">
              <select
                value={templateTrackId}
                onChange={event => setTemplateTrackId(event.target.value)}
              >
                {RESEARCH_TRACK_OPTIONS.map(track => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={handleAppendTemplate}>
                追加该学科词条
              </button>
            </div>
          </div>

          <label className="folder-modal__field">
            <span className="folder-modal__label">本分类学科语境说明（翻译与解释该分类文献时参考）</span>
            <textarea
              rows={2}
              data-testid="folder-settings-context"
              maxLength={300}
              value={contextSummary}
              onChange={event => setContextSummary(event.target.value)}
              placeholder="例如：电催化析氢方向，侧重过电位、Tafel 斜率与原位谱学机制"
            />
          </label>

          <label className="folder-modal__field">
            <div className="folder-modal__label-row">
              <span className="folder-modal__label">本分类专属术语表（每行一条：英文 =&gt; 中文）</span>
              <span className="folder-modal__hint">已识别 {parsedEntries.length} 条</span>
            </div>
            <textarea
              rows={5}
              data-testid="folder-settings-glossary"
              value={glossaryText}
              onChange={event => setGlossaryText(event.target.value)}
              placeholder={'ablation => 激光烧蚀\noverpotential => 过电位'}
            />
          </label>

          <label className="folder-modal__checkbox">
            <input
              type="checkbox"
              data-testid="folder-settings-inherit-global"
              checked={inheritGlobal}
              onChange={event => setInheritGlobal(event.target.checked)}
            />
            <span>同时参考全局术语表（关闭则严格仅使用本分类及上级分类词条，彻底隔离跨学科冲突）</span>
          </label>

          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : null}

          {confirmDelete ? (
            <div className="folder-modal__delete-box" role="alert">
              <span>仅移除分类文件夹（含下级子分类），绝不删除 PDF；其中文献将自动移至「未分类」。</span>
              <div className="folder-modal__delete-actions">
                <button
                  type="button"
                  className="folder-modal__danger"
                  data-testid="folder-settings-confirm-delete"
                  disabled={busy}
                  onClick={() => void handleConfirmDelete()}
                >
                  确认删除分类
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="folder-modal__footer">
          {!confirmDelete ? (
            <button
              type="button"
              className="folder-modal__danger-outline"
              data-testid="folder-settings-delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              删除分类
            </button>
          ) : null}
          {onExportFolder ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onExportFolder(folder.id)}
            >
              导出本分类 PDF
            </button>
          ) : null}
          <div className="folder-modal__footer-right">
            <button type="button" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="folder-modal__primary"
              data-testid="folder-settings-save"
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {busy ? '保存中…' : '保存分类设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
